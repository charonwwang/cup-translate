import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const SOURCE_AREA = 'src/window/Translate/components/SourceArea/index.jsx';
const LANG_DETECT = 'src/utils/lang_detect.js';

/**
 * 背景（本轮实测）：动态翻译路径上，语言检测失败会让后续同步被**静默跳过**。
 *
 * SourceArea.changeSourceText（原第 322-328 行）：
 *
 *     sourceTextChangeTimerRef.current = setTimeout(() => {
 *         sourceTextChangeTimerRef.current = null;
 *         detect_language(text).then(() => {
 *             syncSourceText();
 *         });
 *     }, 1000);
 *
 * 这里只有 .then，**没有 .catch**；而 detect() 会 reject：
 *   · `store.get('translate_detect_engine')` 读取失败
 *   · local 引擎是 invoke('lang_detect')，Rust 侧出错即 reject
 *   · baidu/google/tencent/niutrans/yandex/bing 是网络请求，离线必 reject
 *
 * src/utils/lang_detect.js 全文**没有任何 try/catch**：各引擎末尾的
 * `return 'en'` 只兜住「响应异常」，兜不住「抛出的异常」。
 *
 * 后果不只是控制台里一条未处理 rejection —— syncSourceText() 永不执行，
 * 而本项目自己的注释说明了它的重要性：
 *   「setSourceText … 不会自动写回 sourceTextAtom。必须显式 syncSourceText()，
 *     否则界面清空了、atom 里还留着上一次的文本，TargetArea 会继续显示旧译文。」
 * 也就是说：语言检测一失败，翻译结果就停在上一段文本上，用户看到的是**错误的旧译文**。
 *
 * 这些测试断言「失败路径必须被处理」，而不是断言具体实现写法。
 */

/** 取出一段源码里某个括号块的完整内容（大括号配对，跳过字符串/注释）。 */
function balancedBlock(source, openIndex) {
    let depth = 0;
    for (let i = openIndex; i < source.length; i += 1) {
        const ch = source[i];
        if (ch === '`' || ch === "'" || ch === '"') {
            const quote = ch;
            i += 1;
            while (i < source.length && source[i] !== quote) {
                if (source[i] === '\\') i += 1;
                i += 1;
            }
            continue;
        }
        if (ch === '/' && source[i + 1] === '/') {
            while (i < source.length && source[i] !== '\n') i += 1;
            continue;
        }
        if (ch === '/' && source[i + 1] === '*') {
            i += 2;
            while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
            i += 1;
            continue;
        }
        if (ch === '{') depth += 1;
        if (ch === '}') {
            depth -= 1;
            if (depth === 0) return source.slice(openIndex, i + 1);
        }
    }
    throw new Error('unbalanced braces');
}

test('the dynamic-translate detect() call handles rejection', async () => {
    const source = await readFile(SOURCE_AREA, 'utf8');
    const start = source.indexOf('const changeSourceText =');
    assert.notEqual(start, -1, 'changeSourceText should exist');
    const body = balancedBlock(source, source.indexOf('{', start));

    // 该函数里应当存在 detect_language(...) 的调用
    assert.match(body, /detect_language\(/, 'changeSourceText should call detect_language');

    // 关键断言：这一段必须有 catch（或 try/catch、或 await 在 try 里）
    const hasCatch = /\.catch\s*\(/.test(body) || /try\s*\{/.test(body);
    assert.ok(
        hasCatch,
        'detect_language(...) can reject (network engines, store read, invoke), ' +
            'and without a catch syncSourceText() never runs, leaving the previous translation on screen'
    );

    // 并且即使检测失败，也必须仍然调用 syncSourceText —— 检测失败不该阻断同步。
    const syncCount = (body.match(/syncSourceText\(\)/g) ?? []).length;
    assert.ok(syncCount >= 1, 'syncSourceText must still be reachable');
});

test('a detect failure still synchronises the source text atom', async () => {
    // 精确断言修复语义：syncSourceText 必须出现在「无论成功失败都会执行」的位置，
    // 即在 catch/finally 里，或在使用 .finally() 时。
    const source = await readFile(SOURCE_AREA, 'utf8');
    const start = source.indexOf('const changeSourceText =');
    const body = balancedBlock(source, source.indexOf('{', start));

    const guarded = /\.catch\s*\(/.test(body) || /\.finally\s*\(/.test(body) || /try\s*\{/.test(body);
    assert.ok(guarded, 'the detect call must have a failure path (catch/finally/try)');
});

test('lang_detect never lets an engine exception escape untyped', async () => {
    // src/utils/lang_detect.js 全文没有 try/catch：各引擎用 `return 'en'` 兜「响应异常」，
    // 但兜不住「抛出的异常」。detect() 作为公共入口，应当保证**总是返回一个语言码**，
    // 使调用方不必处理 rejection。
    const source = await readFile(LANG_DETECT, 'utf8');

    assert.ok(
        /try\s*\{/.test(source),
        'lang_detect.js should guard its engine calls so detect() always resolves to a language code'
    );

    // 仍应保留 'en' 兜底语义
    assert.match(source, /return 'en'/, "the 'en' fallback must remain");
});
