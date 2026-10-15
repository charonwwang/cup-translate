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

test('the real lang_detect.js source keeps its invoke command', async () => {
    // 回归：这正是坑 1 的真实触发点（该文件里有通配 MIME 类型）。
    const src = await readFile('src/utils/lang_detect.js', 'utf8');
    assert.ok(src.includes("'*/*'"), 'precondition: the wildcard MIME type is still there');

    const names = invokedCommandNames(src);
    assert.ok(names.has('lang_detect'), 'the naive stripper lost this command; the shared helper must not');
});

test('the helper finds every command a naive stripper would miss', async () => {
    // 交叉验证：对整个 src/ 扫描，正确实现找到的命令集合必须**包含**
    // 朴素实现找到的，且本例中严格更大（多出 lang_detect）。
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

    const naiveStrip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    const correct = new Set();
    const naive = new Set();
    for (const f of files) {
        const src = await readFile(f, 'utf8');
        for (const n of invokedCommandNames(src)) correct.add(n);
        for (const m of naiveStrip(src).matchAll(/invoke\(\s*['"]([a-z0-9_]+)['"]/g)) naive.add(m[1]);
    }

    assert.ok(correct.size > naive.size, 'the correct helper must find strictly more commands here');
    for (const n of naive) {
        assert.ok(correct.has(n), `'${n}' found by the naive stripper must also be found by the helper`);
    }
    assert.ok(
        [...correct].filter((n) => !naive.has(n)).includes('lang_detect'),
        'lang_detect is exactly the command the naive stripper loses'
    );
});
