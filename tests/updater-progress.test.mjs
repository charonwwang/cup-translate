import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const UPDATER = 'src/window/Updater/index.jsx';

/**
 * 背景（本轮实测）：更新器下载进度条会算出 Infinity。
 *
 * Tauri 的下载进度事件 `tauri://update-download-progress` 的 payload 是
 * `DownloadProgressEvent { chunk_length: usize, content_length: Option<u64> }`
 * （tauri 1.8.1 `src/updater/mod.rs:124-129`），且标了
 * `#[serde(rename_all = "camelCase")]`，所以 JS 侧字段名是
 * `chunkLength` / `contentLength`。
 *
 * `content_length` 取自响应头的 `Content-Length`（`src/updater/core.rs:663-667`）：
 *
 *     let content_length: Option<u64> = response
 *         .headers()
 *         .get(header::CONTENT_LENGTH)
 *         .and_then(|value| value.to_str().ok())
 *         .and_then(|value| value.parse().ok());
 *
 * 服务器用**分块传输（chunked）**不带该头时，它就是 `None`。
 * 实测 serde 对 `Option::None` 的默认序列化是 `null`（不是省略字段）：
 *
 *     Some -> {"chunk_length":500,"content_length":1000}
 *     None -> {"chunk_length":500,"content_length":null}
 *
 * 修复前 `setTotal(e.payload.contentLength)` 会把 `total` 设成 `null`，
 * 于是 `(downloaded / total) * 100` = **Infinity**，进度条拿到非法值；
 * 且 `downloaded > total` 在 total 为 null 时恒为 true，按钮永远显示「安装中」。
 *
 * 下面的测试把「total 必须是正数才参与计算」钉死。
 */

/**
 * 用真实的回调体构造一个可调用的事件处理函数。
 *
 * 回调体里引用的 `e` 是箭头函数的形参，`eventId` 是模块级变量——
 * 两者都要在求值时补上，所以用 `(e) => { ... }` 包一层，
 * 并把 eventId 存进一个外部 ref 以便跨多次调用保持。
 */
function realHandler(source) {
    const body = extractProgressHandler(source);
    const state = { total: 0, downloaded: 0 };
    const eventIdRef = { value: 0 };
    const send = new Function(
        'setTotal',
        'setDownloaded',
        'eventIdRef',
        `let eventId = eventIdRef.value;
         const onProgress = (e) => { ${body} eventIdRef.value = eventId; };
         return onProgress;`
    )(
        (v) => {
            state.total = v;
        },
        (fn) => {
            state.downloaded = fn(state.downloaded);
        },
        eventIdRef
    );
    return { send, state, eventIdRef };
}

/** 去掉注释，避免注释里提到的写法被误判成真实代码。 */
function stripComments(source) {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** 取出真实的进度事件回调体，供行为测试执行。 */
function extractProgressHandler(source) {
    const start = source.indexOf("listen('tauri://update-download-progress'");
    assert.notEqual(start, -1, 'the download-progress listener must exist');
    const open = source.indexOf('{', source.indexOf('(e) =>', start));
    assert.notEqual(open, -1, 'the listener callback must be an arrow with a block body');

    // 括号配平，取出回调体（不依赖缩进或缩进宽度）
    let depth = 0;
    for (let i = open; i < source.length; i += 1) {
        if (source[i] === '{') depth += 1;
        else if (source[i] === '}') {
            depth -= 1;
            if (depth === 0) return source.slice(open + 1, i);
        }
    }
    throw new Error('unbalanced braces while extracting the progress handler');
}

test('the download progress bar never computes a percentage from a missing total', async () => {
    const source = await readFile(UPDATER, 'utf8');
    const code = stripComments(source);

    // 1) 进度条的值必须是受保护的除法（total 为 0 / null 时不能除）
    assert.match(
        code,
        /value=\{total > 0 \? \(downloaded \/ total\) \* 100 : 0\}/,
        'the Progress value must guard against a zero/missing total'
    );

    // 2) 不允许出现裸的 downloaded / total
    assert.doesNotMatch(
        code,
        /value=\{\(downloaded \/ total\)/,
        'an unguarded (downloaded / total) * 100 yields Infinity when contentLength is null'
    );

    // 3) contentLength 必须先验证是正数才能写进 total
    assert.match(
        code,
        /if \(typeof e\.payload\.contentLength === 'number' && e\.payload\.contentLength > 0\) \{\s*setTotal\(e\.payload\.contentLength\);\s*\}/,
        'setTotal must only receive a positive numeric contentLength'
    );

    // 4) 按钮的「安装中」判据同样不能拿 null 做比较
    assert.match(
        code,
        /total > 0 && downloaded > total/,
        'the installing label must also require a known positive total'
    );
});

test('real handler: a chunked response (contentLength null) does not produce Infinity', async () => {
    const source = await readFile(UPDATER, 'utf8');
    const { send, state } = realHandler(source);
    void state;

    // 服务器不带 Content-Length（分块传输）：serde 把 None 序列化成 null
    send({ id: 1, payload: { contentLength: null, chunkLength: 500 } });
    assert.equal(state.downloaded, 500, 'chunks must still be accumulated');
    assert.equal(state.total, 0, 'a null contentLength must not become the total');

    const percent = state.total > 0 ? (state.downloaded / state.total) * 100 : 0;
    assert.ok(Number.isFinite(percent), `progress must be finite, got ${percent}`);
    assert.equal(percent, 0, 'with an unknown total the bar shows an indeterminate 0');

    // 后续块也不能把 total 变成 null
    send({ id: 1, payload: { contentLength: null, chunkLength: 200 } });
    assert.equal(state.total, 0);
    assert.equal(state.downloaded, 700);
});

test('real handler: a normal response still tracks the real percentage', async () => {
    const source = await readFile(UPDATER, 'utf8');
    const { send, state, eventIdRef } = realHandler(source);

    send({ id: 7, payload: { contentLength: 1000, chunkLength: 400 } });
    send({ id: 7, payload: { contentLength: 1000, chunkLength: 400 } });
    send({ id: 7, payload: { contentLength: 1000, chunkLength: 200 } });

    assert.equal(state.total, 1000, 'a real contentLength must be recorded');
    assert.equal(state.downloaded, 1000);
    assert.equal((state.downloaded / state.total) * 100, 100);

    // 来自其它下载事件流（id 不同）的块必须被忽略——第一块钉住了 eventId
    send({ id: 99, payload: { contentLength: 1000, chunkLength: 5000 } });
    assert.equal(state.downloaded, 1000, 'chunks from another event stream must be ignored');

    // 下载完成后重新开始一次：eventId 已非 0，新流仍被忽略（现有语义，未被本次改动影响）
    assert.equal(eventIdRef.value, 7);
});
