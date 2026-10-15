import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

const MAIN_RS = 'src-tauri/src/main.rs';
const SRC_RS_DIR = 'src-tauri/src';
const SRC_DIR = 'src';

/**
 * 背景：Tauri 的命令必须**同时**满足两件事才能被前端调用：
 *   1) 用 `#[tauri::command]` 标注（否则 generate_handler! 编译不过）
 *   2) 登记进 `main.rs` 的 `tauri::generate_handler![...]`
 *
 * 漏登记的后果不是编译错误，而是**运行时**失败：
 * 前端 `invoke('xxx')` 抛出「command xxx not found」，
 * 而这条路径通常没有自动化覆盖（GUI 行为无 e2e）。
 *
 * 反向的错法同样存在：前端调用了从未定义的命令名（例如改名后漏改一处），
 * 同样只在运行时才暴露。这类「跨语言契约」正是本项目既往缺陷的高发区
 * （参见 CLAUDE.md §4.1：local_mt 加了前端忘了加 Rust，用户配置活不过一次重启）。
 *
 * 这些测试把两个方向都钉死。
 */

/** 取出 main.rs 中 generate_handler![...] 里登记的命令名。 */
async function registeredCommands() {
    const source = await readFile(MAIN_RS, 'utf8');
    const start = source.indexOf('generate_handler![');
    assert.notEqual(start, -1, 'main.rs should call tauri::generate_handler!');
    const end = source.indexOf(']', start);
    return source
        .slice(start, end)
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter((s) => /^[a-z_][a-z0-9_]*$/.test(s));
}

/** 扫描 src-tauri/src 下所有 `#[tauri::command]` 定义的函数名。 */
async function definedCommands() {
    const files = await readdir(SRC_RS_DIR);
    const names = new Set();
    for (const file of files.filter((f) => f.endsWith('.rs'))) {
        const source = await readFile(`${SRC_RS_DIR}/${file}`, 'utf8');
        const lines = source.split('\n');
        for (let i = 0; i < lines.length; i += 1) {
            if (!lines[i].includes('#[tauri::command')) continue;
            // 命令属性与 fn 之间可能夹着 #[cfg(...)] 等属性行
            for (let j = i + 1; j < Math.min(i + 6, lines.length); j += 1) {
                const m = lines[j].match(/pub\s+(?:async\s+)?fn\s+([a-z_][a-z0-9_]*)/);
                if (m) {
                    names.add(m[1]);
                    break;
                }
            }
        }
    }
    return names;
}

/** 扫描前端所有 invoke('...') / invoke(`...`) 的命令名。 */
async function invokedCommands() {
    const names = new Set();
    async function walk(dir) {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
            const path = `${dir}/${entry.name}`;
            if (entry.isDirectory()) {
                await walk(path);
            } else if (/\.(js|jsx|ts)$/.test(entry.name)) {
                const source = await readFile(path, 'utf8');
                for (const m of source.matchAll(/invoke\(\s*['"`]([a-z_][a-z0-9_]*)['"`]/g)) {
                    names.add(m[1]);
                }
            }
        }
    }
    await walk(SRC_DIR);
    return names;
}

test('every #[tauri::command] is registered in generate_handler', async () => {
    const defined = await definedCommands();
    const registered = new Set(await registeredCommands());

    assert.ok(defined.size >= 20, `expected a substantial command surface, found ${defined.size}`);

    const missing = [...defined].filter((name) => !registered.has(name)).sort();
    assert.deepEqual(
        missing,
        [],
        `these commands are defined but never registered, so invoke() would fail at runtime: ${missing.join(', ')}`
    );
});

test('every command the frontend invokes is actually registered', async () => {
    const invoked = await invokedCommands();
    const registered = new Set(await registeredCommands());

    assert.ok(invoked.size >= 15, `expected the frontend to invoke many commands, found ${invoked.size}`);

    const missing = [...invoked].filter((name) => !registered.has(name)).sort();
    assert.deepEqual(
        missing,
        [],
        `the frontend invokes these unregistered commands (runtime "command not found"): ${missing.join(', ')}`
    );
});

test('generate_handler contains no duplicate or unknown entries', async () => {
    const source = await readFile(MAIN_RS, 'utf8');
    const start = source.indexOf('generate_handler![');
    const end = source.indexOf(']', start);
    const raw = source
        .slice(start + 'generate_handler!['.length, end)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

    // 重复登记是无声的：编译通过，但说明有人复制粘贴出错
    const seen = new Set();
    const duplicates = raw.filter((name) => (seen.has(name) ? true : (seen.add(name), false)));
    assert.deepEqual(duplicates, [], `duplicate registrations: ${duplicates.join(', ')}`);

    // 每个条目都应当是一个真实定义的命令
    const defined = await definedCommands();
    const unknown = raw.filter((name) => !defined.has(name));
    assert.deepEqual(unknown, [], `registered but not defined with #[tauri::command]: ${unknown.join(', ')}`);
});
