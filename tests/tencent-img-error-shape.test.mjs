import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const TENCENT_IMG = 'src/services/recognize/tencent_img/index.jsx';

/**
 * `tencent_img` 在服务端返回错误时，必须把**真实原因**带给用户，
 * 而不是一个与失败无关的 `TypeError`。
 *
 * 背景（实测）：
 *   腾讯云接口在**失败时也返回 HTTP 200**，错误信息放在 `Response.Error` 里，
 *   **不带** `ImageRecord` 字段。用无效凭据实测到的真实响应结构：
 *
 *     {"Response":{"Error":{"Code":"AuthFailure.SignatureExpire",
 *       "Message":"Signature expired. Please use local time ..."},
 *       "RequestId":"edea4403-..."}}
 *
 *   修复前的代码是三层链式访问：
 *
 *     if (result['Response']['ImageRecord']['Value']) { ... }
 *
 *   在错误响应下 `Response` 存在、`ImageRecord` 是 `undefined`，
 *   于是抛 `TypeError: Cannot read properties of undefined (reading 'Value')`。
 *   而前端 `Recognize/TextArea` 的错误处理是 `setError(e.toString())` **原样展示**，
 *   用户看到的就是这句 TypeError —— 既看不出是密钥错还是签名过期，
 *   也不知道要去改配置。
 *
 *   对照：同目录的 `tencent/index.jsx`（非 img 版）用的是**单层**访问
 *   `result['Response']['TextDetections']`，`Response` 存在时得到 `undefined`、
 *   正常走 `else` 分支 `throw JSON.stringify(result)`，所以没有这个问题。
 *   `tencent_img` 是全仓唯一出现三层链式访问的 recognize 引擎（已全量扫描确认）。
 *
 * 修复：先取 `Response`、再取 `ImageRecord`、再取 `Value`，逐层判断；
 * 任何一层缺失都退回到 `throw JSON.stringify(result)`，如实透传服务端错误。
 *
 * 这里**执行真实源码**（注入假的 fetch / crypto-js），验证行为，
 * 而不是只断言源码里有几个 `&&`。
 */

/** 从真实源码里抽出 `recognize` 的函数体（按花括号配平）。 */
function extractRecognizeBody(source) {
    const sig = source.indexOf('export async function recognize(');
    assert.notEqual(sig, -1, 'tencent_img must still export an async recognize()');
    // 跳过参数括号，再从函数体的 `{` 开始配平
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

/** 构造一个可执行的 recognize，注入受控的 fetch 与 crypto-js。 */
function buildRecognize(source, { response }) {
    const body = extractRecognizeBody(source);
    // crypto-js 的签名计算与本次断言无关，用记录型假件替代即可
    const chain = { toString: () => 'fakesig', stringify: () => 'fakesig' };
    const hmacSHA256 = () => chain;
    const hashSHA256 = () => chain;
    const hex = { stringify: () => 'fakesig' };
    const nanoid = () => 'fakeuuid';
    const fetchWithTimeout = async () => response;

    const factory = new Function(
        'hmacSHA256',
        'hashSHA256',
        'hex',
        'nanoid',
        'fetch',
        `return async (base64, language, options = {}) => { ${body} };`
    );
    return factory(hmacSHA256, hashSHA256, hex, nanoid, fetchWithTimeout);
}

const source = await readFile(TENCENT_IMG, 'utf8');

test('a Tencent error response reports the server error, not a TypeError', async () => {
    // 真实测到的错误结构（HTTP 200 + Response.Error，无 ImageRecord）
    const errorBody = {
        Response: {
            Error: {
                Code: 'AuthFailure.SignatureExpire',
                Message: 'Signature expired. Please use local time and enable NTP service.',
            },
            RequestId: 'edea4403-ad31-498e-8b4f-261934e6e838',
        },
    };
    const recognize = buildRecognize(source, {
        response: { ok: true, status: 200, data: errorBody },
    });

    const err = await recognize('aGk=', 'auto', { config: { secret_key: 'k', secret_id: 'i' } }).then(
        () => null,
        (e) => e
    );

    assert.notEqual(err, null, 'an error response must reject rather than resolve');
    assert.doesNotMatch(String(err), /TypeError/, `the user must not see a TypeError; got: ${String(err)}`);
    assert.doesNotMatch(String(err), /reading 'Value'/, 'the failure must not be an unguarded property access');
    // 必须如实带上服务端返回的错误内容
    assert.match(String(err), /AuthFailure\.SignatureExpire/, 'the server error code must survive');
    assert.match(String(err), /Signature expired/, 'the server error message must survive');
});

test('a partially-shaped response also falls through to the raw payload', async () => {
    // Response 存在但没有 ImageRecord（另一种失败形态）
    const recognize = buildRecognize(source, {
        response: { ok: true, status: 200, data: { Response: { RequestId: 'x' } } },
    });
    const err = await recognize('aGk=', 'auto', { config: { secret_key: 'k', secret_id: 'i' } }).then(
        () => null,
        (e) => e
    );
    assert.notEqual(err, null, 'must reject');
    assert.doesNotMatch(String(err), /TypeError/, `must not be a TypeError; got: ${String(err)}`);
    assert.match(String(err), /RequestId/, 'the raw payload should be surfaced');
});

test('the happy path still returns the recognized text', async () => {
    const okBody = {
        Response: {
            ImageRecord: {
                Value: [
                    { SourceText: 'hello', TargetText: '你好' },
                    { SourceText: 'world', TargetText: '世界' },
                ],
            },
        },
    };
    const recognize = buildRecognize(source, {
        response: { ok: true, status: 200, data: okBody },
    });
    const cfg = { config: { secret_key: 'k', secret_id: 'i' } };

    assert.equal(await recognize('aGk=', 'auto', cfg), 'hello\nworld', 'auto returns the source text');
    assert.equal(await recognize('aGk=', 'zh', cfg), '你好\n世界', 'an explicit target returns the target text');
});

test('a non-2xx response keeps its existing actionable error', async () => {
    const recognize = buildRecognize(source, {
        response: { ok: false, status: 403, data: { message: 'forbidden' } },
    });
    const err = await recognize('aGk=', 'auto', { config: { secret_key: 'k', secret_id: 'i' } }).then(
        () => null,
        (e) => e
    );
    assert.match(String(err), /Http Request Error/, 'the HTTP error path must be unchanged');
    assert.match(String(err), /403/);
});
