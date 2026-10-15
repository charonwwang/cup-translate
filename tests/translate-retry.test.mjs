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
        (e) => String(e).includes('Google 翻译请求失败'),
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
