import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ENGINES = [
    {
        path: 'src/services/recognize/volcengine/index.jsx',
        fn: 'normal_ocr',
        // 正常返回时的数组字段名与元素形状
        listKey: 'line_texts',
        item: (text) => text,
        sample: ['第一行', '第二行'],
        joined: '第一行\n第二行\n',
    },
    {
        path: 'src/services/recognize/volcengine_multi_lang/index.jsx',
        fn: 'multi_lang_ocr',
        listKey: 'ocr_infos',
        item: (text) => ({ text }),
        sample: ['foo', 'bar'],
        joined: 'foo\nbar\n',
    },
];

/**
 * 火山引擎识别在服务端返回错误时，必须抛出带**真实原因**的错误，
 * 而不是**静默返回 `undefined`**（随后在前端崩成另一个 TypeError）。
 *
 * 背景（响应结构已用真实接口实测）：
 *   用伪造凭据请求 `https://visual.volcengineapi.com/?Action=OCRNormal`
 *   拿到的失败响应是（**不含 `data` 字段**）：
 *
 *     {"ResponseMetadata":{"RequestId":"2026...","Action":"OCRNormal",
 *       "Error":{"CodeN":100009,"Code":"InvalidAccessKey",
 *        "Message":"The security token[fake] included in the request is invalid."}}}
 *
 *   而修复前的代码是：
 *
 *     if (res.ok) {
 *         let result = res.data;
 *         if (result['data']) {          // <-- 假
 *             ...return texts;
 *         }
 *         // 没有 else，也没有兜底 return
 *     } else { throw ... }
 *     // 函数到此结束
 *
 *   于是 `res.ok === true` 且没有 `data` 时，函数**不抛错、也不返回内容**，
 *   直接返回 `undefined`。它一路传到前端 `Recognize/TextArea/index.jsx:128`：
 *
 *     v = v.trim();
 *     // TypeError: Cannot read properties of undefined (reading 'trim')
 *
 *   用户看到的既不是「凭据无效」也不是任何可操作提示，服务端的
 *   `InvalidAccessKey` 被彻底丢弃。
 *
 *   **这比前两轮更隐蔽**：`tencent_img` 与 `iflytek_latex` 是当场抛 TypeError
 *   （错误发生在现场），这里是**静默返回 undefined**，错误发生在离现场很远的
 *   调用方，堆栈里看不到这个文件。
 *
 *   两个文件（`volcengine` 与 `volcengine_multi_lang`）的这一段结构完全相同，
 *   只是字段名不同（`line_texts` / `ocr_infos`），所以一并覆盖。
 *
 * 这里**执行真实源码**：抽出 `normal_ocr` / `multi_lang_ocr` 的函数体，
 * 注入假的 `query`（它才是真正做 HTTP 与签名的地方），从而精确测到出错的逻辑。
 */

/** 从源码里抽出指定 async 函数的函数体（跳过参数括号后按花括号配平）。 */
function extractBody(source, fnName) {
    const sig = source.indexOf(`async function ${fnName}(`);
    assert.notEqual(sig, -1, `${fnName} must still exist`);
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
    assert.notEqual(bodyStart, -1, `could not locate the ${fnName} body`);
    let depth = 0;
    for (let i = bodyStart; i < source.length; i += 1) {
        if (source[i] === '{') depth += 1;
        else if (source[i] === '}') {
            depth -= 1;
            if (depth === 0) {
                const body = source.slice(bodyStart + 1, i);
                assert.ok(body.trim().length > 0, `extracted ${fnName} body must not be empty`);
                return body;
            }
        }
    }
    throw new Error(`unbalanced braces while extracting ${fnName}()`);
}

/** 构造可执行的引擎函数，注入受控的 query。 */
function buildEngine(source, fnName, response) {
    const body = extractBody(source, fnName);
    // ⚠️ 必须声明参数名 `img_base64`：函数体第一行就是
    // `let res = await query(img_base64, 'OCRNormal', ...)`，
    // 不声明会直接 `ReferenceError: img_base64 is not defined`
    // （第一版写成了 `img`，8 条测试全红 —— 那是**夹具**的问题，
    // 不是被测代码有问题；核对过 ReferenceError 才改这里）。
    const factory = new Function('query', `return async (img_base64, appid, secret) => { ${body} };`);
    return factory(async () => response);
}

for (const engine of ENGINES) {
    const source = await readFile(engine.path, 'utf8');
    const label = engine.path.split('/')[3];

    test(`${label}: a Volcengine error response throws instead of returning undefined`, async () => {
        // 真实测到的失败响应：有 ResponseMetadata.Error，没有 data
        const errorBody = {
            ResponseMetadata: {
                RequestId: '20261016021452771606037BB8EE4C024F',
                Action: 'OCRNormal',
                Error: {
                    CodeN: 100009,
                    Code: 'InvalidAccessKey',
                    Message: 'The security token[fake] included in the request is invalid.',
                },
            },
        };
        const run = buildEngine(source, engine.fn, { ok: true, status: 200, data: errorBody });

        let returned;
        let thrown = null;
        try {
            returned = await run('aGk=', 'appid', 'secret');
        } catch (e) {
            thrown = e;
        }

        assert.equal(returned, undefined, 'the engine must not silently resolve; a resolved value here is the bug');
        assert.notEqual(thrown, null, 'an error response must throw rather than return undefined');
        // 必须把服务端返回的内容透出来
        assert.match(String(thrown), /InvalidAccessKey/, 'the server error code must survive');
        assert.match(String(thrown), /security token/, 'the server message must survive');
    });

    test(`${label}: a response whose list field is missing throws the raw payload`, async () => {
        const run = buildEngine(source, engine.fn, {
            ok: true,
            status: 200,
            data: { data: { something_else: 1 } },
        });
        const err = await run('aGk=', 'appid', 'secret').then(
            () => null,
            (e) => e
        );
        assert.notEqual(err, null, 'must reject rather than return undefined');
        assert.doesNotMatch(
            String(err),
            /is not iterable/,
            `must not surface a bare "not iterable" TypeError; got: ${String(err)}`
        );
        assert.match(String(err), /something_else/, 'the raw payload should be surfaced');
    });

    test(`${label}: the happy path still joins the recognised lines`, async () => {
        const run = buildEngine(source, engine.fn, {
            ok: true,
            status: 200,
            data: { data: { [engine.listKey]: engine.sample.map(engine.item) } },
        });
        assert.equal(await run('aGk=', 'appid', 'secret'), engine.joined);
    });

    test(`${label}: a non-2xx response keeps its existing actionable error`, async () => {
        const run = buildEngine(source, engine.fn, {
            ok: false,
            status: 401,
            data: { message: 'unauthorized' },
        });
        const err = await run('aGk=', 'appid', 'secret').then(
            () => null,
            (e) => e
        );
        assert.match(String(err), /Http Request Error/, 'the HTTP error path must be unchanged');
        assert.match(String(err), /401/);
    });
}
