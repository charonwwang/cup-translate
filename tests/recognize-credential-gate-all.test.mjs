import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { stripComments } from './helpers/source.mjs';

/**
 * 背景（延续上一轮的发现）：翻译路径有配置闸门（`isServiceConfigured`，
 * 由 TargetArea 在发请求前调用），**recognize 路径没有对应闸门**。
 * 上一轮只修了已实测确认 401 的 `simple_latex`；本文件覆盖其余需要凭据的服务。
 *
 * 可达性（已确认，非构造边界）：`Recognize/index.jsx:91` 用
 * `store.get(key) ?? {}` 取实例配置，新建但未填凭据的实例就是 `{}`；
 * 而 `Service/Recognize/ConfigModal` **没有任何必填校验**，所以这种实例
 * 既能创建也能被选中并触发识别。
 *
 * 实测（2026-10，对真实端点）：
 *   · baidu  空 client_id/secret -> HTTP 400 invalid_request
 *   · simple_latex 空 token      -> HTTP 401 invalid credentials（上一轮已修）
 * 即真的会向第三方发一次注定失败的请求，用户只看到
 * `Http Request Error / Http Status: 4xx / {...}`，没说清缺哪个字段。
 *
 * 本文件的断言目标是「**有没有发请求**」，而不是错误文案 ——
 * 前者才是这条约定（「不发无效请求」）的实质。
 */

/** 每个需要凭据的内置 recognize 服务：文件、凭据键、可选的 fetch 前置动作。 */
const SERVICES = {
    baidu: { keys: ['client_id', 'client_secret'] },
    baidu_accurate: { keys: ['client_id', 'client_secret'] },
    baidu_img: { keys: ['appid', 'secret'] },
    simple_latex: { keys: ['token'] },
    tencent: { keys: ['secret_id', 'secret_key'] },
    tencent_accurate: { keys: ['secret_id', 'secret_key'] },
    tencent_img: { keys: ['secret_id', 'secret_key'] },
    iflytek: { keys: ['appid', 'apikey', 'apisecret'] },
    iflytek_intsig: { keys: ['appid', 'apikey', 'apisecret'] },
    iflytek_latex: { keys: ['appid', 'apikey', 'apisecret'] },
    volcengine: { keys: ['appid', 'secret'] },
    volcengine_multi_lang: { keys: ['appid', 'secret'] },
};

const path = (name) => `src/services/recognize/${name}/index.jsx`;

/**
 * 把真实源码装进受控作用域执行（去掉 import/export，注入假依赖），
 * 记录 fetch 调用 —— 「有没有发请求」正是要断言的核心。
 */
async function loadRealRecognize(name, config) {
    const source = await readFile(path(name), 'utf8');
    const body = source
        .replace(/^import .*$/gm, '')
        .replace(/^export\s+\*\s+from\s+.*$/gm, '')
        // 注意：`export async function` 与 `export function` **都要**处理。
        // iflytek 除了 recognize 还导出了 iflytek_auth（`export function`），
        // 只替换前者会在 new Function 里留下 `export` 而 SyntaxError。
        .replace(/^export\s+(async\s+)?function/gm, '$1function');

    const calls = [];
    const fetch = async (url) => {
        calls.push(url);
        // 返回一个「成功但没有内容」的响应：若实现没有提前拦截，
        // 它会继续跑下去并最终因内容缺失而抛错 —— 但那已经发过请求了。
        return { ok: true, status: 200, data: {} };
    };
    // ⚠️ 必须把源码 import 的**全部**依赖都注入进来。
    //
    // 本文件第一版只注入了 fetch/Body/readBinaryFile 等，漏了 tencent 用到的
    // crypto-js（`hmacSHA256` / `hashSHA256` / `hex`）。结果是：剥掉 import 后
    // 这些名字未定义，函数在**第一次 fetch 之前**就抛 ReferenceError，
    // 于是 `calls === []` 成立而断言通过 —— **假绿**：
    // 它证明的是「函数崩了」，不是「函数主动不发请求」。
    // 现已补齐依赖并加了下面的 `reachedNetwork` 自检（见测试内的断言）。
    const deps = {
        fetch,
        // volcengine 用到 Body.text(...)；各服务的用法不止 Body.form
        Body: {
            form: (o) => o,
            text: (s) => s,
            json: (o) => o,
        },
        readBinaryFile: async () => new Uint8Array([1, 2, 3]),
        BaseDirectory: { AppCache: 'AppCache' },
        nanoid: () => 'test-nanoid',
        md5: () => 'test-md5',
        __TAURI__: {},
        // crypto-js：只需「能算出稳定字符串」即可，测试不校验签名正确性
        hmacSHA256: (message, secret) => ({ toString: () => `hmac:${secret}:${message}`.slice(0, 64) }),
        hashSHA256: (message) => ({ toString: () => `sha:${message}`.slice(0, 64) }),
        hex: { parse: (s) => s, stringify: (s) => s },
        // iflytek / volcengine 用的是 crypto-js 的**默认导出**（`import CryptoJS from 'crypto-js'`），
        // 其调用形如 CryptoJS.HmacSHA256(...).toString(CryptoJS.enc.Base64)，
        // 故这里给出可链式调用的最小假实现（不校验签名正确性）。
        CryptoJS: {
            HmacSHA256: () => ({ toString: () => 'test-hmac' }),
            SHA256: () => ({ toString: () => 'test-sha' }),
            // iflytek 会调用 CryptoJS.enc.Base64.stringify(...)，故必须是**对象**而非字符串
            enc: {
                Base64: { stringify: (w) => 'test-base64', parse: (s) => s },
                Hex: { stringify: (w) => 'test-hex', parse: (s) => s },
                Utf8: { stringify: (w) => 'test-utf8', parse: (s) => s },
                Latin1: { stringify: (w) => 'test-latin1', parse: (s) => s },
            },
        },
        // iflytek_intsig 从别的模块 import 了 iflytek_auth
        iflytek_auth: () => 'test-auth',
        // 其余可能出现的工具
        fetchWithTimeout: fetch,
        encodeBase64: (s) => s,
        Base64: { encode: (s) => s },
        gzip: async (s) => s,
        urlEncode: (s) => s,
        sha256: (s) => `sha:${s}`,
        // iflytek_latex 直接用**裸的** Base64 全局（未 import），故需单独注入
        Base64: { stringify: (s) => 'test-base64', encode: (s) => 'test-base64' },
        // iflytek 在浏览器环境下会读 window（node 里没有这个全局）。
        // 给一个最小替身即可 —— 测试不关心其内容，只关心「有没有发请求」。
        // iflytek 用 window.btoa(...)（浏览器全局）；node 里没有，需要替身
        window: {
            location: { protocol: 'https:' },
            navigator: { userAgent: 'test' },
            btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
        },
        btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
        navigator: { userAgent: 'test' },
        location: { protocol: 'https:', host: 'localhost' },
    };
    const names = Object.keys(deps);
    const factory = new Function(...names, `${body}\nreturn { recognize };`);
    const { recognize } = factory(...names.map((n) => deps[n]));
    return { recognize: (b64 = 'b64', lang = 'auto') => recognize(b64, lang, { config }), calls };
}

/**
 * 前置自检：喂**有效**凭据时必须真的走到 fetch。
 *
 * 这条防的是本文件第一版踩过的坑 —— 夹具缺依赖导致函数在发请求前就崩，
 * `calls === []` 于是恒真、断言假绿（它证明的是「崩了」而非「没发请求」）。
 * 只有确认「有效凭据 -> 会发请求」，下面「空凭据 -> 不发请求」才有意义。
 */
for (const name of Object.keys(SERVICES)) {
    test(`${name}: with real credentials the fixture actually reaches the network`, async () => {
        const { keys } = SERVICES[name];
        const config = Object.fromEntries(keys.map((k) => [k, 'real-value']));
        const { recognize, calls } = await loadRealRecognize(name, config);
        try {
            await recognize();
        } catch {
            // 允许失败（假 fetch 的响应体不完整），关键是**有没有发出请求**
        }
        assert.ok(
            calls.length > 0,
            `${name}: the fixture never reached fetch even with valid credentials — ` +
                `the "no request" assertions below would be vacuous (likely a missing injected dependency)`
        );
    });
}

for (const [name, { keys }] of Object.entries(SERVICES)) {
    test(`${name}: empty credentials never reach the network`, async () => {
        const { recognize, calls } = await loadRealRecognize(name, {});
        await assert.rejects(
            () => recognize(),
            () => true,
            `${name} must fail fast when its credentials are unset`
        );
        assert.deepEqual(
            calls,
            [],
            `${name} sent a request that is certain to fail without credentials; keys=${keys.join(', ')}`
        );
    });

    test(`${name}: whitespace-only credentials count as unset`, async () => {
        const blank = Object.fromEntries(keys.map((k) => [k, '   ']));
        const { recognize, calls } = await loadRealRecognize(name, blank);
        await assert.rejects(
            () => recognize(),
            () => true,
            `${name} must reject whitespace-only credentials`
        );
        assert.deepEqual(calls, [], `${name} must not treat whitespace as a credential`);
    });
}
