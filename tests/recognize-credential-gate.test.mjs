import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/**
 * 背景（本轮实测）：翻译路径有配置闸门（`services/translate/required_config.js`
 * 的 `isServiceConfigured`，由 `TargetArea` 在发请求前调用，注释明确写着
 * 「未配置的引擎直接跳过、不发无效请求」），但 **recognize 路径没有对应闸门**。
 *
 * 后果（以 simple_latex 为例，实测 2026-10）：实例的配置对象是 `{}` 时
 * `token` 为 `undefined`，请求照样发出去，第三方服务器返回
 *     HTTP 401 {"err_info":{"err_msg":"invalid credentials",...}}
 * 用户看到的是 `Http Request Error / Http Status: 401 / {...}` ——
 * 既没有说明「你没填 token」，也白白发了一次注定失败的请求。
 *
 * 本文件用**真实源码**（受控 fetch）验证：**凭据为空时根本不发请求**。
 */

const SIMPLE_LATEX = 'src/services/recognize/simple_latex/index.jsx';

/**
 * 把真实源码装进受控作用域执行。
 * 去掉 import / export，注入假的 fetch / readBinaryFile / Body，
 * 并记录 fetch 是否被调用过 —— 「有没有发请求」正是要断言的核心。
 */
async function loadRealRecognize({ config }) {
    const source = await readFile(SIMPLE_LATEX, 'utf8');
    const body = source
        .replace(/^import .*$/gm, '')
        .replace(/^export\s+\*\s+from\s+.*$/gm, '')
        .replace(/^export\s+async\s+function/gm, 'async function');

    const calls = [];
    const fetch = async (url) => {
        calls.push(url);
        return { ok: true, status: 200, data: { res: { latex: 'x' } } };
    };
    const readBinaryFile = async () => new Uint8Array([1, 2, 3]);
    const Body = { form: (o) => o };

    const factory = new Function('fetch', 'readBinaryFile', 'BaseDirectory', 'Body', `${body}\nreturn { recognize };`);
    const { recognize } = factory(fetch, readBinaryFile, { AppCache: 'AppCache' }, Body);
    return { recognize: (b64, lang) => recognize(b64, lang, { config }), calls };
}

test('simple_latex: an empty token never reaches the network', async () => {
    const { recognize, calls } = await loadRealRecognize({ config: { token: '' } });

    await assert.rejects(
        () => recognize('b64', 'auto'),
        (e) => String(e).includes('token'),
        'must tell the user the token is missing'
    );
    assert.deepEqual(calls, [], 'must NOT send a request that is certain to fail with HTTP 401');
});

test('simple_latex: a whitespace-only token is treated as missing', async () => {
    // 与 required_config.js 的 isFilledString 同一语义：'   ' 与 '' 等效
    const { recognize, calls } = await loadRealRecognize({ config: { token: '   ' } });

    await assert.rejects(() => recognize('b64', 'auto'));
    assert.deepEqual(calls, [], 'whitespace is not a credential');
});

test('simple_latex: a missing token key behaves like an empty one', async () => {
    // 实例配置为 {} 时 token 是 undefined —— 这是真实可达路径，不是构造的边界
    const { recognize, calls } = await loadRealRecognize({ config: {} });

    await assert.rejects(() => recognize('b64', 'auto'));
    assert.deepEqual(calls, [], 'an unstored instance config yields {} and must not fire a request');
});

test('simple_latex: a real token still performs the request', async () => {
    // 反向守卫：闸门不能把正常路径也拦掉（否则功能直接失效）
    const { recognize, calls } = await loadRealRecognize({ config: { token: 'real-token' } });

    assert.equal(await recognize('b64', 'auto'), 'x');
    assert.equal(calls.length, 1, 'a configured service must still call the API');
    assert.match(calls[0], /simpletex\.cn/, 'and must call the expected endpoint');
});
