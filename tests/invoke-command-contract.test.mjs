import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

const MAIN_RS = 'src-tauri/src/main.rs';

/**
 * 前端 `invoke('<cmd>')` 调用的每个命令，都必须在 `main.rs` 的
 * `generate_handler![...]` 里注册过（否则运行时直接 reject）。
 *
 * 为什么现在需要这条（与 r88~r91 一脉相承）：
 *   最近几轮在给插件调用补 `.catch`。补完之后，「命令名写错 / 漏注册」这类
 *   原本会抛到控制台的错误，会被 `.catch` 优雅吃掉 —— 功能静默失效、
 *   界面退化，但没有任何显式报错。所以补错误处理的同时，
 *   必须有一条测试确认「前端要调的命令，Rust 侧确实存在且已注册」。
 *
 * ⚠️ 本文件里那个 `stripComments` 是**踩过两次坑**才写对的，请勿简化
 * ------------------------------------------------------------------
 * 坑 1（朴素的「正则一次性删块注释」写法，形如把 斜杠星号 到 星号斜杠 之间
 *   整段删除）：`src/utils/lang_detect.js` 里有一个 HTTP 请求头
 *   `accept`，其值是通配 MIME 类型（斜杠星号 两个字符），
 *   其中的 斜杠星号 被当成块注释开头，
 *   于是把后面 **800 多字符真实代码**（含 `local_detect` 与
 *   `invoke('lang_detect')`）整段吞掉。扫描结果因此**少了 `lang_detect`**，
 *   而 `lang_detect` 确实是前端在调的命令 —— 属于「扫描器吃掉了真实代码」。
 *   实测受影响文件：`lang_detect.js` 丢掉 `invoke('lang_detect')`。
 *
 * 坑 2（修坑 1 时的过度修正）：把字符串字面量**整段跳过且不保留内容**，
 *   于是 `invoke('lang_detect')` 里的命令名作为「字符串内容」也被丢掉了，
 *   扫描结果依旧为空。剥注释的目的只是「不看注释」，
 *   但 `invoke('...')` 的命令名**恰恰就在字符串里**，必须保留。
 *
 * 正确做法：状态机跟踪单引号 / 双引号 / 反引号与转义，字符串内容原样保留，
 * 只丢弃注释部分。下面的 `stripComments` 即为此实现。
 *
 * ⚠️ 连本注释本身都踩了同一个坑：最初我在注释里写了那个正则字面量，
 * 其中的 星号斜杠 序列让**这条块注释提前闭合**，整个测试文件直接
 * `SyntaxError: Invalid or unexpected token`。所以这里刻意只用文字描述。
 */

/** 剥掉注释，但**保留字符串字面量的内容**（命令名在字符串里，不能丢）。 */
function stripComments(source) {
    const out = [];
    let i = 0;
    const n = source.length;
    while (i < n) {
        if (source.startsWith('//', i)) {
            const j = source.indexOf('\n', i);
            i = j < 0 ? n : j;
            continue;
        }
        if (source.startsWith('/*', i)) {
            const j = source.indexOf('*/', i + 2);
            i = j < 0 ? n : j + 2;
            continue;
        }
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

/** 扫描 src/ 下所有前端源码，收集 `invoke('<cmd>')` 的命令名。 */
async function invokedCommands() {
    const files = [];
    const walk = async (dir) => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
            const full = `${dir}/${entry.name}`;
            if (entry.isDirectory()) await walk(full);
            else if (/\.(jsx?|ts)$/.test(entry.name)) files.push(full);
        }
    };
    await walk('src');

    const commands = new Map();
    for (const file of files) {
        const code = stripComments(await readFile(file, 'utf8'));
        for (const m of code.matchAll(/invoke\(\s*['"]([a-z0-9_]+)['"]/g)) {
            if (!commands.has(m[1])) commands.set(m[1], new Set());
            commands.get(m[1]).add(file);
        }
    }
    return commands;
}

/** 从 main.rs 的 generate_handler![...] 取出已注册的命令名。 */
async function registeredCommands() {
    const main = stripComments(await readFile(MAIN_RS, 'utf8'));
    const m = /generate_handler!\[([\s\S]*?)\]/.exec(main);
    assert.notEqual(m, null, 'main.rs must still call generate_handler![...]');
    return new Set(
        m[1]
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
    );
}

test('every command the frontend invokes is registered in generate_handler!', async () => {
    const commands = await invokedCommands();
    assert.ok(commands.size >= 15, `expected many invoke() calls, found ${commands.size}`);

    const registered = await registeredCommands();
    const missing = [...commands.keys()].filter((c) => !registered.has(c));
    assert.deepEqual(
        missing,
        [],
        `these commands are invoked from the frontend but never registered in main.rs: ${JSON.stringify(
            missing.map((c) => `${c} (${[...commands.get(c)].join(', ')})`)
        )}`
    );
});

test('every registered command is defined as a #[tauri::command]', async () => {
    // 反向：注册了但没定义 -> 根本编译不过；这条把契约提前固定下来，
    // 并顺带确认 `#[tauri::command(async)]` 这种变体也能被识别。
    const files = await readdir('src-tauri/src');
    const defined = new Set();
    for (const file of files.filter((f) => f.endsWith('.rs'))) {
        const src = await readFile(`src-tauri/src/${file}`, 'utf8');
        for (const m of src.matchAll(
            /#\[tauri::command(?:\([^)]*\))?\][\s\S]{0,300}?\n\s*pub\s+(?:async\s+)?fn\s+([a-z0-9_]+)/g
        )) {
            defined.add(m[1]);
        }
    }
    const registered = await registeredCommands();
    const undefinedCommands = [...registered].filter((c) => !defined.has(c));
    assert.deepEqual(
        undefinedCommands,
        [],
        `these commands are registered in main.rs but have no #[tauri::command] definition: ${JSON.stringify(
            undefinedCommands
        )}`
    );
});

test('the scanner keeps string contents so invoke() names are still found', async () => {
    // 元测试：直接钉住上面那个「踩过两次坑」的行为。
    // 1) accept: '*/*' 不得让扫描器把后续代码当成注释吞掉；
    // 2) 字符串里的命令名必须仍能被找到。
    const src = await readFile('src/utils/lang_detect.js', 'utf8');
    assert.ok(src.includes("'*/*'"), 'precondition: lang_detect.js still contains the wildcard MIME type');

    const code = stripComments(src);
    assert.ok(
        code.includes('local_detect'),
        "the '*/*' string must not swallow the rest of the file into a phantom comment"
    );
    assert.match(
        code,
        /invoke\(\s*['"]lang_detect['"]/,
        'the command name lives inside a string literal and must survive comment stripping'
    );
});

test('comment stripping actually removes comments', async () => {
    // 反向元测试：确认 stripComments 不是「什么都不做」。
    const src = 'const a = 1; // 这是行注释\n/* 块注释 */\nconst b = "keep me";';
    const code = stripComments(src);
    assert.doesNotMatch(code, /这是行注释|块注释/, 'comments must be removed');
    assert.match(code, /"keep me"/, 'string contents must be preserved');
    assert.match(code, /const a = 1;/, 'code must be preserved');
});

test('the frontend command set is derived from source, not hand-listed', async () => {
    // 元测试：命令清单来自真实扫描，不能是硬编码（避免「清单无法自证完整」）。
    const commands = await invokedCommands();
    for (const expected of ['get_text', 'font_list', 'install_plugin', 'run_binary']) {
        assert.ok(commands.has(expected), `${expected} must be discovered by the scan`);
    }
    assert.ok(!commands.has('definitely_not_a_command'), 'no fabricated commands');
});
