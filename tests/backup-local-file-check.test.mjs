import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const LOCAL = 'src/window/Config/pages/Backup/utils/local.jsx';

/**
 * 背景（本轮实测）：`local.get()` 的备份文件校验同时存在两个方向的错误。
 *
 * 原实现：
 *     if (selected !== null && selected.endsWith('zip')) { ... } else { throw 'Invalid File'; }
 *
 * 实测：
 *     '/tmp/backup.zip'  -> true     ✓ 正确
 *     '/tmp/backup.ZIP'  -> **false** ✗ 被拒（大小写敏感）
 *     '/tmp/backup.Zip'  -> **false** ✗ 被拒
 *     '/tmp/myzip'       -> **true**  ✗ 通过（后缀不是扩展名，也没有点）
 *     '/tmp/a.zip.bak'   -> false    ✓ 正确
 *
 * 「该收的没收」为什么是真问题：
 *   `backup()` 用的 save 对话框**没有 defaultPath**，用户可以自行把文件
 *   存成 `backup.ZIP`；而 `filters` 只是**建议性**的显示过滤，不是强制约束
 *   （GTK 的文件选择器与 macOS 的 NSOpenPanel 都允许手输路径）。
 *   在 Windows / macOS 这类大小写不敏感的文件系统上，`.ZIP` 是常见形态。
 *   用户会遇到：备份成功 -> 想恢复 -> 选自己的文件 -> 得到「Invalid File」，
 *   完全无从判断为什么。
 *
 * 「不该收的收了」是可接受的一面：Rust 侧
 * （`src-tauri/src/backup.rs::local` 的 `"get"` 分支）直接
 * `ZipArchive::new(File::open(path)?)`，由 zip 解析器判定内容是否合法。
 * 即前端这一层**不是安全边界**，加严只会误伤用户，放宽不引入风险。
 */

/** 去掉注释，避免注释里提到的代码被误判成真实代码。 */
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

/** 用真实的 isBackupFileName 实现构造可调用函数。 */
function realIsBackupFileName(source) {
    const body = extractExportedFunction(source, 'isBackupFileName');
    return new Function(`return function isBackupFileName(name) { ${body} };`)();
}

test('local backup restore accepts any casing of the .zip extension', async () => {
    const code = stripComments(await readFile(LOCAL, 'utf8'));

    // 结构断言：不许再出现裸的 endsWith('zip')
    assert.doesNotMatch(code, /endsWith\('zip'\)/, "a bare endsWith('zip') is case-sensitive and also matches 'myzip'");
    // 必须是不区分大小写的**扩展名**匹配
    assert.match(code, /\/\\\.zip\$\/i/, 'the extension check must be a case-insensitive /\\.zip$/i');
    assert.match(code, /export function isBackupFileName\(name\)/, 'the predicate must be exported and testable');
    assert.match(code, /if \(isBackupFileName\(selected\)\)/, 'the call site must use the predicate');
});

test('real isBackupFileName: both false-reject and false-accept are fixed', async () => {
    const source = await readFile(LOCAL, 'utf8');
    const isBackup = realIsBackupFileName(source);

    // 该收的必须收（含各种大小写）
    for (const name of [
        '/tmp/backup.zip',
        '/tmp/backup.ZIP',
        '/tmp/backup.Zip',
        '/tmp/BACKUP.ZIP',
        'C:\\Users\\me\\Desktop\\os-2026-1-1-0-0-0.zip',
        'C:\\Users\\me\\Desktop\\os-2026-1-1-0-0-0.ZIP',
        '  /tmp/spaced.zip  ',
    ]) {
        assert.equal(isBackup(name), true, `${name} must be accepted`);
    }

    // 不该收的必须拒
    for (const name of [
        '/tmp/myzip', // 后缀不是扩展名
        '/tmp/backup.tar.gz',
        '/tmp/a.zip.bak',
        '/tmp/zip',
        '/tmp/backup.zipper',
        '',
        null,
        undefined,
    ]) {
        assert.equal(isBackup(name), false, `${String(name)} must be rejected`);
    }
});

test('the call site still throws Invalid File and still restores', async () => {
    const code = stripComments(await readFile(LOCAL, 'utf8'));

    // 拒绝路径与恢复路径都不能丢
    assert.match(code, /throw 'Invalid File';/, 'the rejection path must remain');
    assert.match(
        code,
        /invoke\('local', \{\s*operate: 'get',\s*path: selected,\s*\}\)/,
        'the restore invoke must remain'
    );
    assert.match(code, /return finishRestore\(\);/, 'finishRestore must still be returned');
});
