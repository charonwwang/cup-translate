/**
 * 测试用的源码处理工具。
 *
 * 这些函数被多个测试文件共用，**放在 helpers/ 下是因为不会被当成测试执行**
 * （`pnpm test` 跑的是 `tests/*.test.mjs`，该 glob 不匹配子目录）。
 */

/**
 * 剥掉 JS/JSX/TS 源码里的注释，但**保留字符串字面量的内容**。
 *
 * 为什么需要它（这个函数是踩了三次坑才写对的，请勿用正则简化）
 * ------------------------------------------------------------
 * 项目里长期沿用的写法是把块注释「整段删除」，形如一个非贪婪正则匹配
 * 从「斜杠星号」到「星号斜杠」的内容，再删掉行首为双斜杠的行。
 * 它有两个真实缺陷：
 *
 * 坑 1：字符串里的「斜杠星号」会被当成块注释开头。
 *   最典型的是 `src/utils/lang_detect.js` 里的 HTTP 请求头 `accept`，
 *   其值是通配 MIME 类型（斜杠星号两个字符）。正则把这里当成注释起点，
 *   于是把后面 1000 多字符的真实代码（含 `local_detect` 函数与
 *   `invoke('lang_detect')` 调用）整段吞掉。
 *   实测：朴素写法在 `lang_detect.js` 里**少扫出一个 `invoke` 命令名**
 *   （22 个 vs 正确版 23 个，漏掉的正是 `lang_detect`）。
 *   后果是「扫描源码确认某契约成立」这类护栏会**基于被截断的源码**下结论。
 *
 * 坑 2：把字符串字面量整段**跳过且不保留内容**也是一种错。
 *   剥注释的目的只是「不看注释」，而 `invoke('cmd')` 的命令名、
 *   各种字面量常量**恰恰就在字符串里**。整段丢弃等于删掉了要匹配的对象。
 *   正确做法是：字符串照原样保留，只丢弃注释部分。
 *
 * 坑 3：本文件早期版本在**注释里**写了那个正则字面量，其中的
 *   「星号斜杠」序列让这条块注释提前闭合，整个文件直接
 *   `SyntaxError: Invalid or unexpected token`，一条测试都跑不起来。
 *   所以这里只用文字描述，不写该字面量。
 *
 * 实现：状态机跟踪单引号 / 双引号 / 反引号与反斜杠转义，
 * 字符串内容原样写入输出，注释整体丢弃。
 *
 * 已知边界（不做处理，因为本项目源码不涉及）：
 *   · 不解析正则字面量，形如 `const re = /ab/;` 中的内容会被当普通代码；
 *   · 不解析模板串里的 `${}` 嵌套（整体当字符串保留，不影响「剥注释」目的）。
 *
 * @param {string} source 源码文本
 * @returns {string} 去掉注释、但保留字符串内容的文本
 */
export function stripComments(source) {
    const out = [];
    let i = 0;
    const n = source.length;
    while (i < n) {
        // 行注释：丢到行尾（保留换行，避免把两行粘成一行）
        if (source.startsWith('//', i)) {
            const j = source.indexOf('\n', i);
            i = j < 0 ? n : j;
            continue;
        }
        // 块注释
        if (source.startsWith('/*', i)) {
            const j = source.indexOf('*/', i + 2);
            i = j < 0 ? n : j + 2;
            continue;
        }
        // 字符串字面量：连引号一起原样保留
        const c = source[i];
        if (c === '"' || c === "'" || c === '`') {
            out.push(c);
            i += 1;
            while (i < n) {
                if (source[i] === '\\') {
                    out.push(source.slice(i, i + 2));
                    i += 2;
                    continue;
                }
                out.push(source[i]);
                if (source[i] === c) {
                    i += 1;
                    break;
                }
                i += 1;
            }
            continue;
        }
        out.push(c);
        i += 1;
    }
    return out.join('');
}

/** 剥注释后，取出源码里所有 `invoke('<cmd>')` 的命令名（去重、保持出现顺序）。 */
export function invokedCommandNames(source) {
    const code = stripComments(source);
    const names = new Set();
    for (const m of code.matchAll(/invoke\(\s*['"]([a-z0-9_]+)['"]/g)) names.add(m[1]);
    return names;
}
