import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const WEBDAV = 'src/window/Config/pages/Backup/utils/webdav.jsx';

/**
 * 背景（本轮实测）：`webdav.list()` 把 WebDAV 的 PROPFIND 响应转成文件名列表，
 * 原实现有两处问题：
 *
 *     let backup_list = JSON.parse(backup_list_text);
 *     backup_list = backup_list.filter((item) => item.hasOwnProperty('File'));
 *     return backup_list.map((file) => file.File.href.split('/').slice(-1)[0]);
 *
 * ── 问题 1：`item.hasOwnProperty` 会被自有属性遮蔽
 *    `hasOwnProperty` 来自原型链，若对象自身带同名键就会被顶掉。实测：
 *        JSON.parse('{"hasOwnProperty":1}').hasOwnProperty('File')
 *        -> TypeError: ... is not a function
 *    **可达性诚实说明**：Rust 侧是
 *    `serde_json::to_string(&Vec<ListEntity>)`，而 `ListEntity` 是
 *    `File(ListFile) | Folder(ListFolder)`，键只可能是 `File` / `Folder`，
 *    所以这条**当前不可达** —— 改它是因为 `Object.hasOwn` 是零成本的正确
 *    写法，不是为了修一个已发生的故障。
 *
 * ── 问题 2：href 以 `/` 结尾时得到**空串条目**（这条才是真问题）
 *    basename 取法是 `href.split('/').slice(-1)[0]`，对
 *    `"http://x/pot-app/"` 得到 `""`。而 Rust 侧 `backup_name()` 明确拒绝
 *    空名字（`Invalid backup name`）。于是这种条目进入列表后：
 *      · 界面上是一个**没有文字的按钮**（用户不知道它是什么）；
 *      · 点它只会得到一句毫无意义的错误提示；
 *      · 多个空条目还会造成 React key 重复。
 *
 *    可达条件：服务器对某个以 `/` 结尾的 `<D:href>` 不回 `<D:collection/>`。
 *    这不符 RFC4918，但 reqwest_dav 是按「有无 collection」判 File/Folder 的
 *    （lib.rs:269），所以不合规的实现确实会让它带着尾斜杠以 `File` 出现。
 *    既然这种条目**必然用不了**，就该不显示。
 *
 * 本机没有可用的 WebDAV 服务端，因此测试用受控的 JSON 输入驱动**真实函数**。
 */

/** 去掉注释，避免注释里的示例代码被误判成真实代码。 */
function stripComments(source) {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** 按括号配平抽出被具名导出的函数体（不依赖缩进宽度）。 */
function extractExportedFunction(source, name) {
    const start = source.indexOf(`export function ${name}(`);
    assert.notEqual(start, -1, `export function ${name} must exist`);
    const open = source.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < source.length; i += 1) {
        if (source[i] === '{') depth += 1;
        else if (source[i] === '}') {
            depth -= 1;
            if (depth === 0) return source.slice(open + 1, i);
        }
    }
    throw new Error(`unbalanced braces while extracting ${name}`);
}

/** 用真实的 extractBackupNames 实现构造可调用函数。 */
function realExtractBackupNames(source) {
    const body = extractExportedFunction(source, 'extractBackupNames');
    return new Function(`return function extractBackupNames(rawJson) { ${body} };`)();
}

const item = (kind, href) => JSON.stringify([{ [kind]: { href } }]);

test('webdav list uses a shadow-proof property check', async () => {
    const code = stripComments(await readFile(WEBDAV, 'utf8'));

    assert.doesNotMatch(code, /\.hasOwnProperty\(/, 'hasOwnProperty can be shadowed by an own property');
    assert.match(code, /Object\.hasOwn\(item, 'File'\)/, 'must use Object.hasOwn');
    // 调用点必须走抽出来的纯函数
    assert.match(code, /return extractBackupNames\(backup_list_text\);/, 'list() must delegate to the predicate');
});

test('real extractBackupNames: normal folders are excluded, files are returned', async () => {
    const source = await readFile(WEBDAV, 'utf8');
    const extract = realExtractBackupNames(source);

    const payload = JSON.stringify([
        { Folder: { href: 'http://x/pot-app/' } },
        { File: { href: 'http://x/pot-app/os-2026-1-1-0-0-0.zip' } },
        { Folder: { href: 'http://x/pot-app/sub/' } },
        { File: { href: 'http://x/pot-app/other.zip' } },
    ]);
    assert.deepEqual(extract(payload), ['os-2026-1-1-0-0-0.zip', 'other.zip']);
});

test('real extractBackupNames: unusable entries are dropped, not shown as blank buttons', async () => {
    const source = await readFile(WEBDAV, 'utf8');
    const extract = realExtractBackupNames(source);

    // href 以 / 结尾 -> basename 为空串 -> Rust 会拒绝 -> 不该出现在列表里
    assert.deepEqual(extract(item('File', 'http://x/pot-app/')), []);
    assert.deepEqual(extract(item('File', 'http://x/pot-app/sub/')), []);

    // 与正常条目混在一起时，只丢掉空的那条
    const mixed = JSON.stringify([
        { File: { href: 'http://x/pot-app/' } },
        { File: { href: 'http://x/pot-app/good.zip' } },
    ]);
    assert.deepEqual(extract(mixed), ['good.zip']);

    // href 不是字符串 / File 为 null：不许抛，直接丢掉
    assert.deepEqual(extract(JSON.stringify([{ File: { href: 123 } }])), []);
    assert.deepEqual(extract(JSON.stringify([{ File: null }])), []);
    assert.deepEqual(extract(JSON.stringify([{ File: {} }])), []);

    // 非数组 / 空数组
    assert.deepEqual(extract('[]'), []);
    assert.deepEqual(extract('{}'), []);

    // 条目为 null 不许抛
    assert.deepEqual(extract(JSON.stringify([null, { File: { href: 'http://x/a.zip' } }])), ['a.zip']);
});

test('real extractBackupNames: a shadowing key does not throw', async () => {
    const source = await readFile(WEBDAV, 'utf8');
    const extract = realExtractBackupNames(source);

    // 这条在修复前会抛 TypeError: ... hasOwnProperty is not a function
    const shadowed = JSON.stringify([{ hasOwnProperty: 1 }, { File: { href: 'http://x/a.zip' } }]);
    assert.deepEqual(extract(shadowed), ['a.zip']);
});
