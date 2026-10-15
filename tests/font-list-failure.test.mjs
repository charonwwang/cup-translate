import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const GENERAL = 'src/window/Config/pages/General/index.jsx';

/**
 * `General/index.jsx` 的 `font_list` 调用失败时必须**降级而不是消失**。
 *
 * 背景：
 *   Rust 侧 `cmd.rs::font_list()` 的签名是 `Result<Vec<String>, Error>`：
 *
 *       pub fn font_list() -> Result<Vec<String>, Error> {
 *           let source = font_kit::source::SystemSource::new();
 *           Ok(source.all_families()?)
 *       }
 *
 *   `all_families()` 来自 font-kit 0.14.2 的 `SystemSource`，返回
 *   `Result<Vec<String>, SelectionError>` —— 也就是说这个命令**是会 reject 的**。
 *
 *   修复前前端只有一句 `.then()`：
 *
 *       invoke('font_list').then((v) => { setFontList(v); });
 *
 *   一旦 reject，有两个后果：
 *     ① 产生一个**未处理的 Promise 拒绝**（项目里没有
 *        `unhandledrejection` 全局兜底，`invoke_plugin.js` 也不管这条路径）；
 *     ② `fontList` 永远停在初始值 `null`，而两处字体下拉框的渲染条件都是
 *        `appFont !== null && fontList !== null` —— 于是整个
 *        「应用字体 / 回退字体」选择器**静默消失**，用户既看不到选项
 *        也看不到任何错误提示，只会以为功能被删了。
 *
 * 修复：补 `.catch()`，失败时 `setFontList([])`（置空数组而非留在 null），
 * 让下拉框照常渲染 —— 里面硬编码的「默认」项（`key='default'`）仍在，
 * 用户至少能选回默认字体；同时用 `info()` 记一条日志便于排查。
 *
 * 这里**执行真实源码片段**并注入假的 React/invoke，验证两条路径的实际行为，
 * 而不是只断言源码里有 `.catch` 字样（「测了写法、没测行为」是本会话
 * 反复踩过的陷阱）。
 */

/** 把 useEffect 的第一个回调体抽出来（按花括号配平）。 */
function extractEffectBody(source) {
    const start = source.indexOf('useEffect(() => {');
    assert.notEqual(start, -1, 'General/index.jsx should still have a useEffect calling font_list');
    const bodyStart = source.indexOf('{', start);
    let depth = 0;
    for (let i = bodyStart; i < source.length; i += 1) {
        if (source[i] === '{') depth += 1;
        else if (source[i] === '}') {
            depth -= 1;
            if (depth === 0) {
                const body = source.slice(bodyStart + 1, i);
                assert.ok(body.trim().length > 0, 'extracted useEffect body must not be empty');
                return body;
            }
        }
    }
    throw new Error('unbalanced braces while extracting the useEffect body');
}

/** 从源码里取出 `invoke('font_list')` 那一条语句（到分号为止）。 */
function extractFontListStatement(body) {
    const start = body.indexOf("invoke('font_list')");
    assert.notEqual(start, -1, 'the effect must still call font_list');
    const end = body.indexOf('\n', body.indexOf('});', start));
    const stmt = body.slice(start, end === -1 ? body.length : end);
    assert.ok(stmt.includes('.catch('), 'the font_list call must handle rejection');
    return stmt;
}

/** 在受控作用域里真实执行那条语句，返回可观察的结果。 */
function runFontListStatement(stmt, { reject }) {
    const calls = { fontList: [], logs: [] };
    const invoke = () =>
        reject ? Promise.reject(new Error('font_list failed')) : Promise.resolve(['Arial', 'Noto Sans']);
    const setFontList = (v) => calls.fontList.push(v);
    const info = (m) => calls.logs.push(m);
    // 其余标识符在本语句里用不到，但不注入会让 new Function 直接抛 ReferenceError
    const fn = new Function(
        'invoke',
        'setFontList',
        'info',
        `return (async () => { ${stmt} ; await new Promise((r) => setTimeout(r, 0)); })();`
    );
    return fn(invoke, setFontList, info).then(() => calls);
}

const source = await readFile(GENERAL, 'utf8');
const body = extractEffectBody(source);
const stmt = extractFontListStatement(body);

test('a failing font_list no longer leaves fontList stuck at null', async () => {
    const calls = await runFontListStatement(stmt, { reject: true });

    assert.equal(calls.fontList.length, 1, 'the failure path must still set fontList exactly once');
    assert.notEqual(
        calls.fontList[0],
        null,
        'fontList must not stay null: the font dropdowns are gated on `fontList !== null` and would vanish'
    );
    assert.deepEqual(calls.fontList[0], [], 'the degraded value should be an empty list');
    // 空数组下下拉框仍会渲染硬编码的「默认」项（key='default'），功能不至于完全消失
    assert.match(
        source,
        /key='default'/,
        'the dropdown must still have a hardcoded default item so an empty font list stays usable'
    );
    // 不能静默：失败要留下一条日志
    assert.equal(calls.logs.length, 1, 'the failure must be logged once');
    assert.match(calls.logs[0], /font/i, 'the log should mention the font list');
});

test('the success path is unchanged and still stores the real list', async () => {
    const calls = await runFontListStatement(stmt, { reject: false });
    assert.deepEqual(calls.fontList, [['Arial', 'Noto Sans']], 'a successful load must be stored as-is');
    assert.deepEqual(calls.logs, [], 'a successful load must not log an error');
});

test('the rejection is handled, not left unhandled', async () => {
    // 真实执行一遍：若没有 .catch，这个 await 会抛出（即在真实环境里
    // 成为一个未处理的 Promise 拒绝）。
    await assert.doesNotReject(
        () => runFontListStatement(stmt, { reject: true }),
        'an unhandled rejection here would surface as an uncaught error in the webview'
    );
});
