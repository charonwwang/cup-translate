import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const IFLYTEK_LATEX = 'src/services/recognize/iflytek_latex/index.jsx';

/**
 * `iflytek_latex` 在服务端返回错误时，必须把**真实原因**带给用户，
 * 而不是一个与失败无关的 `TypeError`。
 *
 * 背景（实测）：
 *   讯飞鉴权失败时返回的是**不带 `data` 字段**的响应。用伪造签名真实请求
 *   `https://rest-api.xfyun.cn/v2/itr` 拿到的响应就是：
 *
 *     {"message":"HMAC signature cannot be verified: apikey not found"}
 *
 *   修复前代码直接访问 `result.data['region']`，在 `data` 为 `undefined` 时抛：
 *
 *     TypeError: Cannot read properties of undefined (reading 'region')
 *
 *   前端 `Recognize/TextArea` 用 `setError(e.toString())` **原样展示**，
 *   所以用户看到的只是这句 TypeError —— 服务端明明说了「apikey 找不到」，
 *   这条真正可操作的信息被完全丢弃。
 *
 *   **这是同目录三个讯飞引擎里唯一漏掉的**：`iflytek` 与 `iflytek_intsig`
 *   本来就写了 `if (!data) throw ...` / `if (!res_payload) throw ...` 两层判断，
 *   `iflytek_latex` 两层都没有（已逐一核对源码）。
 *
 * 修复：补上 `data` 的存在性判断（文案与另外两个引擎一致），
 * 并在循环里容忍单个区域块缺少 `recog`。
 *
 * 与上一轮 `tencent_img` 的关系：两者都是「服务端已经返回了真实错误，
 * 被前端的链式属性访问变成 TypeError 丢掉」，属同一类缺陷；
 * 但触发结构不同（腾讯是 HTTP 200 + Response.Error 无 ImageRecord；
 * 讯飞是 HTTP 200 + 完全没有 data 字段），所以各写各的用例。
 */

/** 从真实源码里抽出 `recognize` 的函数体（跳过参数括号后按花括号配平）。 */
function extractRecognizeBody(source) {
    const sig = source.indexOf('export async function recognize(');
    assert.notEqual(sig, -1, 'iflytek_latex must still export an async recognize()');
    const parenStart = source.indexOf('(', sig);
    let depthParen = 0;
    let bodyStart = -1;
    for (let i = parenStart; i < source.length; i += 1) {
        if (source[i] === '(') depthParen += 1;
        else if (source[i] === ')') {
            depthParen -= 1;
            if (depthParen === 0) {
                bodyStart = source.indexOf('{', i);
                break;
            }
        }
    }
    assert.notEqual(bodyStart, -1, 'could not locate the recognize body');
    let depth = 0;
    for (let i = bodyStart; i < source.length; i += 1) {
        if (source[i] === '{') depth += 1;
        else if (source[i] === '}') {
            depth -= 1;
            if (depth === 0) {
                const body = source.slice(bodyStart + 1, i);
                assert.ok(body.trim().length > 0, 'extracted body must not be empty');
                return body;
            }
        }
    }
    throw new Error('unbalanced braces while extracting recognize()');
}

/** 构造可执行的 recognize，注入受控的 fetch 与 crypto-js。 */
function buildRecognize(source, { response }) {
    const body = extractRecognizeBody(source);
    const chain = { toString: () => 'fakesig', stringify: () => 'fakesig' };
    const factory = new Function(
        'fetch',
        'hmacSHA256',
        'hashSHA256',
        'Base64',
        `return async (base64, language, options = {}) => { ${body} };`
    );
    return factory(
        async () => response,
        () => chain,
        () => chain,
        { stringify: () => 'fakesig' }
    );
}

const source = await readFile(IFLYTEK_LATEX, 'utf8');

test('an iFlytek auth failure reports the server message, not a TypeError', async () => {
    // 真实测到的错误响应：完全没有 data 字段
    const errorBody = { message: 'HMAC signature cannot be verified: apikey not found' };
    const recognize = buildRecognize(source, {
        response: { ok: true, status: 200, data: errorBody },
    });

    const err = await recognize('aGk=', 'auto', { config: { appid: 'a', apisecret: 's', apikey: 'k' } }).then(
        () => null,
        (e) => e
    );

    assert.notEqual(err, null, 'an error response must reject rather than resolve');
    assert.doesNotMatch(String(err), /TypeError/, `the user must not see a TypeError; got: ${String(err)}`);
    assert.doesNotMatch(String(err), /reading 'region'/, 'the failure must not be an unguarded property access');
    assert.match(String(err), /HMAC signature cannot be verified/, 'the server message must survive');
    assert.match(String(err), /apikey not found/, 'the actionable part of the message must survive');
});

test('a response with data but no region still falls through to the raw payload', async () => {
    const recognize = buildRecognize(source, {
        response: { ok: true, status: 200, data: { data: { other: 1 } } },
    });
    const err = await recognize('aGk=', 'auto', { config: { appid: 'a', apisecret: 's', apikey: 'k' } }).then(
        () => null,
        (e) => e
    );
    assert.notEqual(err, null, 'must reject');
    assert.doesNotMatch(String(err), /TypeError/, `must not be a TypeError; got: ${String(err)}`);
    assert.match(String(err), /other/, 'the raw payload should be surfaced');
});

test('the happy path joins region blocks and strips the latex markers', async () => {
    // ⚠️ 标记的确切形式是 `' ifly-latex-begin '`（**两侧各一个空格**，
    // 代码用 replaceAll 精确匹配该模式）。夹具必须与真实返回一致，否则测的
    // 是我自己想象出来的格式 —— 第一版夹具多写了一个空格，断言随即失败，
    // 暴露的是夹具写错，而不是代码有问题（已按真实形式修正）。
    const okBody = {
        data: {
            region: [
                { recog: { content: ' ifly-latex-begin E=mc^2 ifly-latex-end ' } },
                { recog: { content: 'x^2+y^2' } },
            ],
        },
    };
    const recognize = buildRecognize(source, { response: { ok: true, status: 200, data: okBody } });
    const got = await recognize('aGk=', 'auto', { config: { appid: 'a', apisecret: 's', apikey: 'k' } });
    assert.equal(got, 'E=mc^2\nx^2+y^2', 'markers stripped and blocks joined');
    assert.doesNotMatch(got, /ifly-latex/, 'no latex marker may leak into the result');
});

test('a region block without recog does not abort the whole recognition', async () => {
    // 单块缺 recog 不应让整次识别崩掉，只当作空内容
    const body = {
        data: { region: [{ recog: { content: 'good' } }, {}, { recog: { content: 'also good' } }] },
    };
    const recognize = buildRecognize(source, { response: { ok: true, status: 200, data: body } });
    const got = await recognize('aGk=', 'auto', { config: { appid: 'a', apisecret: 's', apikey: 'k' } });
    assert.match(got, /good/, 'the recognisable blocks must still come through');
    assert.match(got, /also good/, 'later blocks must not be skipped');
});

test('a non-2xx response keeps its existing actionable error', async () => {
    const recognize = buildRecognize(source, {
        response: { ok: false, status: 401, data: { message: 'unauthorized' } },
    });
    const err = await recognize('aGk=', 'auto', { config: { appid: 'a', apisecret: 's', apikey: 'k' } }).then(
        () => null,
        (e) => e
    );
    assert.match(String(err), /Http Request Error/, 'the HTTP error path must be unchanged');
    assert.match(String(err), /401/);
});
