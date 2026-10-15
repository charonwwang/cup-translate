import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const GOOGLE = 'src/services/translate/google/index.jsx';

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
    let call = 0;
    // 与源码中 `fetchWithTimeout as fetch` 的别名对应
    const fetch = async (url) => {
        attempted.push(url);
        const next = responses[Math.min(call, responses.length - 1)];
        call += 1;
        if (next === 'throw') {
            throw new Error('network down');
        }
        return next;
    };

    const factory = new Function('fetch', '__slept', `${body}\nreturn { translate };`);
    return { translate: factory(fetch, slept).translate, slept, attempted };
}

test('real translate: no backoff sleep after the final attempt', async () => {
    // 全部 5 次都失败（网络异常），观察真实实现睡了哪些时长
    const { translate, slept, attempted } = await loadRealTranslate({ responses: ['throw'] });

    await assert.rejects(
        () => translate('hello', 'en', 'zh', { config: {} }),
        (e) => String(e).includes('Google translate request failed'),
        'must surface an actionable failure'
    );

    assert.equal(attempted.length, 5, 'must still retry all 5 attempts');
    assert.deepEqual(
        slept,
        [2000, 4000, 8000, 16000],
        `must not sleep after the last attempt; got ${JSON.stringify(slept)}`
    );
    assert.equal(
        slept.reduce((a, b) => a + b, 0),
        30000,
        'total wait should be 30s, not 62s'
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

    assert.equal(await translate('hello', 'en', 'zh', { config: {} }), '你好');
    assert.equal(attempted.length, 3, 'should succeed on the third attempt');
    assert.deepEqual(slept, [2000, 4000], 'backoff applies between retries only');
});

test('real translate: a first-try success never sleeps', async () => {
    const { translate, slept } = await loadRealTranslate({
        responses: [{ ok: true, status: 200, data: [[['hi', 'x', null, null]], null] }],
    });

    assert.equal(await translate('你好', 'zh', 'en', { config: {} }), 'hi');
    assert.deepEqual(slept, []);
});

test('real translate: 429 on the last attempt does not sleep either', async () => {
    // 恰好第 5 次才返回 429：仍不应在抛错前再睡一次
    const { translate, slept } = await loadRealTranslate({ responses: [{ ok: false, status: 429 }] });

    await assert.rejects(() => translate('hello', 'en', 'zh', { config: {} }));
    assert.deepEqual(slept, [2000, 4000, 8000, 16000], 'the 429 path must also skip the final sleep');
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
