import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { invokedCommandNames, stripComments } from './helpers/source.mjs';

/**
 * 守住 `tests/helpers/source.mjs` 的剥注释实现。
 *
 * 这个函数是「扫描源码做契约断言」类护栏的共同底座，
 * 它错一次，**所有基于它的结论都会静默失真**。
 * 所以它自己必须有测试，把踩过的坑逐个钉住。
 */

test('a wildcard MIME type inside a string does not swallow the rest of the file', () => {
    // 坑 1：字符串里的通配 MIME 类型（斜杠星号两个字符）会被朴素正则
    // 当成块注释开头。
    //
    // ⚠️ fixture 必须**带一个后面真正的块注释**才能复现：
    // 朴素正则匹配的是「斜杠星号 ... 星号斜杠」这样**成对**的区间，
    // 只有斜杠星号、后面没有星号斜杠时，它匹配不到、什么都不会吞 ——
    // 那样的用例是**无效**的（我第一版就是这样，朴素实现照样通过）。
    // 真实文件 `lang_detect.js` 里恰好在后面有文档注释，于是从那个通配
    // MIME 类型一路吞到文档注释结尾，把中间的 `local_detect` 整段带走。
    const src = [
        "const headers = { accept: '*/*' };",
        'async function local_detect(text) {',
        "    return await invoke('lang_detect', { text });",
        '}',
        '/** 文档注释：下面这个才是真正的兜底实现 */',
        'export default async function detect(text) {',
        "    return 'en';",
        '}',
    ].join('\n');

    const code = stripComments(src);
    assert.match(code, /accept: '\*\/\*'/, 'the string itself must survive');
    assert.match(code, /async function local_detect/, 'the function after the wildcard must not be swallowed');
    assert.match(code, /invoke\('lang_detect'/, 'the invoke call inside it must survive');
    assert.match(code, /export default async function detect/, 'code after the doc comment must survive');
});

test('string contents are preserved, because command names live inside them', () => {
    // 坑 2：把字符串整段丢弃，就会连命令名一起丢掉。
    //
    // 覆盖范围说明（实测确认，避免夸大）：本用例的 fixture **不含块注释**，
    // 因此它在「朴素正则」实现下**也通过** —— 它区分不了坑 1，
    // 只能区分坑 2。已实测：把实现改成「跳过字符串但不保留内容」时，
    // 本用例（连同 1/5/6/7）失败。坑 1 由第 1 条用例负责。
    const src = 'const a = invoke(\'get_text\'); const b = `tts_speak`; const c = "install_plugin";';
    const code = stripComments(src);
    for (const cmd of ['get_text', 'tts_speak', 'install_plugin']) {
        assert.ok(code.includes(cmd), `'${cmd}' must survive comment stripping`);
    }
});

test('comments are actually removed, in both styles', () => {
    // 反向：确认它不是「什么都不做」的空操作。
    const src = [
        '// 行注释：local_detect',
        '/* 块注释：lang_detect */',
        'const keep = 1;',
        '/** 文档注释 */',
        'const alsoKeep = 2;',
    ].join('\n');
    const code = stripComments(src);
    assert.doesNotMatch(code, /行注释|块注释|文档注释/, 'all comment text must be gone');
    assert.match(code, /const keep = 1;/, 'real code must remain');
    assert.match(code, /const alsoKeep = 2;/, 'code after a doc comment must remain');
});

test('escaped quotes do not end a string early', () => {
    const src = String.raw`const s = 'it\'s fine /* not a comment */'; const after = 1;`;
    const code = stripComments(src);
    assert.match(code, /const after = 1;/, 'an escaped quote must not open a phantom comment');
});

test('backticks keep their contents and do not leak into code', () => {
    const src = 'const t = `a /* b */ c`; const after = 2;';
    const code = stripComments(src);
    assert.ok(code.includes('a /* b */ c'), 'template contents are string data, not a comment');
    assert.match(code, /const after = 2;/, 'code after the template must remain');
});

test('a committed fixture reproduces the wildcard-MIME trap on real-looking source', async () => {
    // 回归：坑 1 的**真实结构**样本。
    //
    // 原先是直接拿 `src/utils/lang_detect.js` 当样本，因为 `bing_detect` 的请求头
    // 里有通配 MIME 类型。后来 `bing_detect` 因端点实测 404 被删除
    // （见 `src/utils/lang_detect.js` 中的说明），该文件里不再有那三个字符，
    // 全仓库也再无第二处 —— 真实样本消失，本用例的前提断言失效。
    //
    // 处置：改用受版本控制的 fixture，它的触发几何与原文件一致
    // （字符串里的通配 MIME 类型 -> 夹在中间的 `local_detect()` -> 后方的注释定界符）。
    // fixture 自身带有「改动注意事项」，见该文件末尾说明。
    const src = await readFile('tests/fixtures/comment-stripper-trap.js', 'utf8');

    // 前提 1：触发点确实存在（否则本用例又变成无效的）
    assert.ok(src.includes("'*/*'"), 'precondition: the wildcard MIME type must be present');

    // 前提 2：朴素实现**确实会**在这份样本上出错 —— 否则测不出任何东西。
    // 这一条是关键：没有它，样本有一天退化成「朴素实现也能处理」时，
    // 本用例会一直绿着而毫无价值（我写这个 fixture 时正是这样错了两次）。
    const naive = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const naiveNames = new Set([...naive(src).matchAll(/invoke\(\s*['"]([a-z0-9_]+)['"]/g)].map((m) => m[1]));
    assert.ok(
        !naiveNames.has('lang_detect'),
        'precondition: the naive stripper must lose lang_detect on this fixture, otherwise the case is vacuous'
    );

    // 正题：共享 helper 必须保住它
    const names = invokedCommandNames(src);
    assert.ok(names.has('lang_detect'), 'the naive stripper lost this command; the shared helper must not');
});

test('the helper finds every command a naive stripper would miss', async () => {
    // 交叉验证：扫描整个 src/ **加上** fixture 目录，正确实现找到的命令集合必须
    // **包含**朴素实现找到的，且严格更大（多出 fixture 里的 lang_detect）。
    const { readdir } = await import('node:fs/promises');
    const files = [];
    const walk = async (dir) => {
        for (const e of await readdir(dir, { withFileTypes: true })) {
            const full = `${dir}/${e.name}`;
            if (e.isDirectory()) await walk(full);
            else if (/\.(jsx?|ts)$/.test(e.name)) files.push(full);
        }
    };
    await walk('src');
    // fixture 也要扫：它是当前**唯一**能区分两种实现的地方。
    // （`src/` 下已无真实触发样本，见上一条用例的说明。）
    await walk('tests/fixtures');

    const naiveStrip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    const correct = new Set();
    const naive = new Set();
    for (const f of files) {
        const src = await readFile(f, 'utf8');
        for (const n of invokedCommandNames(src)) correct.add(n);
        for (const m of naiveStrip(src).matchAll(/invoke\(\s*['"]([a-z0-9_]+)['"]/g)) naive.add(m[1]);
    }

    assert.ok(correct.size >= naive.size, 'the helper must find at least as many commands as the naive stripper');
    for (const n of naive) {
        assert.ok(correct.has(n), `'${n}' found by the naive stripper must also be found by the helper`);
    }
    assert.ok(correct.has('lang_detect'), 'the helper must still see lang_detect somewhere in the tree');

    // ⚠️ 这里**不再**断言「正确实现严格更多」。
    //
    // 原先可以：`src/utils/lang_detect.js` 的 `local_detect()` 会被朴素实现吞掉，
    // 于是全仓聚合时丢了 `lang_detect`。但删除 `bing_detect` 后该文件不再被吞，
    // 聚合层面的差异随之消失 —— 实测确认，现在**只有 fixture 那个文件**能区分
    // 两种实现（「严格更多」已在上一条用例里针对该文件断言）。
    //
    // 保留包含关系而非删除用例：包含关系是**永不退化**的性质
    //（helper 永远不该比朴素实现找到得更少），它正是这个共享底座的意义。
});
