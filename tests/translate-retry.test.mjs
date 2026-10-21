import { createRequestCache } from '../src/utils/requestCache.js';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const GOOGLE = 'src/services/translate/google/index.jsx';
const normalizedWord = (translation) => ({
    pronunciations: [],
    explanations: [{ trait: '', explains: [translation] }],
    associations: [],
    sentence: [],
});

// google 是默认翻译引擎，其重试退避直接决定「网络异常时用户要等多久才看到报错」。
// 旧实现在循环体末尾无条件 sleep：最后一次尝试失败后仍先睡 32 秒再抛错，
// 而那时已明知不会再有重试（总等待 62s，其中 32s 纯属白等）。
//
// 为避免「测试自己复刻逻辑、真实代码回归却照样全绿」，这里把真实源码
// 装进受控作用域执行，并把 sleep 换成记录器 + 零延迟，从而直接观测
// 真实实现到底睡了哪些时长。
async function loadRealTranslate({ responses }) {
    const source = await readFile(GOOGLE, 'utf8');
    const body = source
        // 去掉 import / export 关键字（new Function 里不能出现），
        // 但必须保留 `async`：只删 `export` 本身
        .replace(/^import .*$/gm, '')
        .replace(/^export\s+\*\s+from\s+.*$/gm, '')
        .replace(/^export\s+async\s+function/gm, 'async function')
        .replace(
            'function sleep(ms) {\n    return new Promise((r) => setTimeout(r, ms));\n}',
            'function sleep(ms) { __slept.push(ms); return Promise.resolve(); }'
        );

    const slept = [];
    const attempted = [];
    const requestOptions = [];
    let call = 0;
    // 与源码中 `fetchWithTimeout as fetch` 的别名对应
    const fetch = async (url, options) => {
        requestOptions.push(options);
        attempted.push(url);
        const next = responses[Math.min(call, responses.length - 1)];
        call += 1;
        if (next === 'throw') {
            throw new Error('network down');
        }
        return next;
    };

    const factory = new Function(
        'fetch',
        '__slept',
        'createRequestCache',
        `${body}\nreturn { translate, supplement };`
    );
    return { ...factory(fetch, slept, createRequestCache), slept, attempted, requestOptions };
}

test('real translate: no backoff sleep after the final attempt', async () => {
    // 全部 3 次都失败（网络异常），观察真实实现睡了哪些时长
    const { translate, slept, attempted } = await loadRealTranslate({ responses: ['throw'] });

    await assert.rejects(
        () => translate('hello', 'en', 'zh', { config: {} }),
        (e) => String(e).includes('Google translate request failed'),
        'must surface an actionable failure'
    );

    assert.equal(attempted.length, 3, 'must retry at most 3 attempts');
    assert.deepEqual(slept, [250, 500], `must not sleep after the last attempt; got ${JSON.stringify(slept)}`);
    assert.equal(
        slept.reduce((a, b) => a + b, 0),
        750,
        'total backoff should be bounded at 750ms'
    );
});

test('real translate: non-retryable HTTP status breaks out without sleeping', async () => {
    // 4xx 参数错误重试无意义，应立即失败且不等待
    const { translate, slept, attempted } = await loadRealTranslate({
        responses: [{ ok: false, status: 400 }],
    });

    await assert.rejects(() => translate('hello', 'en', 'zh', { config: {} }));
    assert.equal(attempted.length, 1, 'must not retry a non-429 failure');
    assert.deepEqual(slept, [], 'must not back off when not retrying');
});

test('real translate: 429 retries with exponential backoff then succeeds', async () => {
    const { translate, slept, attempted } = await loadRealTranslate({
        responses: [
            { ok: false, status: 429 },
            { ok: false, status: 429 },
            { ok: true, status: 200, data: [[['你好', 'hello', null, null]], null] },
        ],
    });

    assert.deepEqual(await translate('hello', 'en', 'zh', { config: {} }), normalizedWord('你好'));
    assert.equal(attempted.length, 3, 'should succeed on the third attempt');
    assert.deepEqual(slept, [250, 500], 'backoff applies between retries only');
});

test('real translate: a first-try success never sleeps', async () => {
    const { translate, slept } = await loadRealTranslate({
        responses: [{ ok: true, status: 200, data: [[['hi', 'x', null, null]], null] }],
    });

    assert.deepEqual(await translate('你好', 'zh', 'en', { config: {} }), normalizedWord('hi'));
    assert.deepEqual(slept, []);
});

test('real translate: a single word without a dictionary branch still becomes a word entry', async () => {
    const wordData = [];
    wordData[0] = [['情态', 'modality', null, null, 3]];
    wordData[1] = null;
    wordData[2] = 'en';
    wordData[13] = [
        [
            ['The <b>modality</b> of the treatment depends on the diagnosis.'],
            ['Language <b>modality</b> can be spoken, written, or signed.'],
        ],
    ];
    const { translate, supplement } = await loadRealTranslate({
        responses: [
            { ok: true, status: 200, data: wordData },
            { ok: true, status: 200, data: [[['治疗方式取决于诊断结果。']]] },
            { ok: true, status: 200, data: [[['语言模态可以是口头的、书面的或手语的。']]] },
        ],
    });

    const result = await translate('modality', 'en', 'zh-CN', { config: {} });
    assert.deepEqual(result.explanations, [{ trait: '', explains: ['情态'] }]);
    assert.equal(result.sentence.length, 2);
    assert.equal(result.sentence[0].target, '', 'main result returns without waiting for example translations');
    const enriched = await supplement(result, 'en', 'zh-CN', { config: {} });
    assert.equal(enriched.sentence[0].target, '治疗方式取决于诊断结果。');
});

test('real translate: 429 on the last attempt does not sleep either', async () => {
    // 最后一次仍返回 429：仍不应在抛错前再睡一次
    const { translate, slept } = await loadRealTranslate({ responses: [{ ok: false, status: 429 }] });

    await assert.rejects(() => translate('hello', 'en', 'zh', { config: {} }));
    assert.deepEqual(slept, [250, 500], 'the 429 path must also skip the final sleep');
});

// ---------------------------------------------------------------------------
// 服务层错误文案必须统一用英文
// ---------------------------------------------------------------------------

/**
 * 背景（本轮实测）：`src/services/**` 共 86 处 `throw`，其中 85 处是英文，
 * 只有 3 处是简体中文：
 *   · translate/google         "Google 翻译请求失败…"
 *   · translate/local_mt       "本地离线翻译仅支持中英互译…"
 *   · tts/google_tts           "Google TTS 请求失败…"
 *
 * 这些字符串会经 `setError(e.toString())` / `toast.error(e.toString())`
 * **原样显示给用户**，于是英文（及另外 19 种语言）界面下会弹出中文。
 *
 * 为什么是「统一成英文」而不是「在服务层做 i18n」：
 *   1. 服务层是普通模块、**拿不到 `t`**（不是 React 组件，没有 hook 可用）；
 *   2. 项目默认与回退语言就是英文（`fallbackLng` 的 `default: ['en']`）；
 *   3. 85/86 已经是英文——3 处中文是**例外**，让它们向多数看齐才是最小改动。
 * 真正需要本地化的用户可见文案放在 UI 层（如 `common.language_not_supported`）。
 *
 * 这类问题不会被构建或类型检查发现（字符串总是合法的），所以需要断言。
 */
test('service-layer error messages are written in English, not Chinese', async () => {
    const files = [
        'src/services/translate/google/index.jsx',
        'src/services/translate/local_mt/index.jsx',
        'src/services/tts/google_tts/index.jsx',
    ];
    for (const file of files) {
        const source = await readFile(file, 'utf8');
        // 只看 throw 语句所在的行，避免误伤注释里的中文说明
        const throwLines = source
            .split('\n')
            .filter((line) => /\bthrow\b/.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line));
        assert.ok(throwLines.length > 0, `${file} should contain a throw`);
        for (const line of throwLines) {
            assert.ok(
                !/[\u4e00-\u9fff]/.test(line),
                `${file} throws a Chinese message that users will see verbatim: ${line.trim()}`
            );
        }
    }
});

test('the google retry failure keeps its diagnostic detail', async () => {
    // 本地化/英文化**不能**把诊断信息弄丢：状态码与可操作提示都要在，
    // 否则用户拿不到可自查的线索。
    const source = await readFile(GOOGLE, 'utf8');
    const line = source.split('\n').find((l) => l.includes('throw') && l.includes('request failed'));
    assert.ok(line, 'the google failure message should still exist');
    assert.match(line, /lastErr/, 'must still interpolate the underlying error');
    assert.match(line, /429/, 'must still explain what 429 means');
});

/**
 * 5xx 是**镜像端**的瞬时故障，应当换下一个镜像再试；
 * 4xx 是**请求本身**有问题，换镜像无意义（上一条测试已守住）。
 *
 * 修改前的行为：分支只对 429 走 `continue`，其余（含全部 5xx）一律 `break`，
 * 于是 `ENDPOINTS` 里的 4 个镜像**只对 429 生效** ——
 * 「某镜像挂了就换下一个」这个兜底对 5xx 完全没起作用。
 *
 * 严重性：**健壮性缺口，未证明用户可见**。本机实测 4 个镜像当下均返回 200，
 * 无法诱发真实 5xx，故这里用受控响应验证逻辑本身，而非声称线上出现过。
 */
test('real translate: a 5xx mirror failure falls through to the next mirror', async () => {
    const { translate, attempted, slept } = await loadRealTranslate({
        responses: [
            { ok: false, status: 503 }, // 第一个镜像挂了
            { ok: true, status: 200, data: [[['你好', 'hello', null, null]], null] },
        ],
    });

    assert.deepEqual(await translate('hello', 'en', 'zh', { config: {} }), normalizedWord('你好'));
    assert.equal(
        attempted.length,
        2,
        'a 503 from the first mirror must fall through to the second, not give up immediately'
    );
    // 换了镜像才成功，两个 URL 必须不同（否则等于没换）
    assert.notEqual(attempted[0], attempted[1], 'the retry must use a different mirror URL');
    assert.deepEqual(slept, [250], 'a 5xx retry backs off like the 429 path');
});

test('real translate: 5xx on every mirror still surfaces an actionable error', async () => {
    const { translate, attempted, slept } = await loadRealTranslate({
        responses: [{ ok: false, status: 502 }],
    });

    await assert.rejects(
        () => translate('hello', 'en', 'zh', { config: {} }),
        (e) => String(e).includes('Google translate request failed') && String(e).includes('502'),
        'must still fail with the underlying status after exhausting retries'
    );
    assert.equal(attempted.length, 3, 'must exhaust all attempts before giving up');
    assert.deepEqual(slept, [250, 500], 'and must not sleep after the final attempt');
});

test('real translate: 4xx is still not retried (the 5xx change must not loosen this)', async () => {
    // 反向守卫：把 5xx 纳入重试**不能**顺手把 4xx 也带上
    for (const status of [400, 401, 403, 404]) {
        const { translate, attempted, slept } = await loadRealTranslate({
            responses: [{ ok: false, status }],
        });
        await assert.rejects(() => translate('hello', 'en', 'zh', { config: {} }));
        assert.equal(attempted.length, 1, `HTTP ${status} must fail immediately without switching mirrors`);
        assert.deepEqual(slept, [], `HTTP ${status} must not back off`);
    }
});

test('real Google service coalesces identical requests and separates endpoint configurations', async () => {
    const { translate, attempted, requestOptions } = await loadRealTranslate({
        responses: [{ ok: true, status: 200, data: [[['你好', 'hello']], null] }],
    });
    await Promise.all([translate('hello', 'en', 'zh'), translate('hello', 'en', 'zh')]);
    await translate('hello', 'en', 'zh');
    assert.equal(attempted.length, 1);
    await translate('hello', 'en', 'zh', { config: { custom_url: 'https://example.test' } });
    assert.equal(attempted.length, 2);
    assert.ok(requestOptions.every((options) => options.timeout === 6));
});
