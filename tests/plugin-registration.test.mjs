import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const MAIN_RS = 'src-tauri/src/main.rs';
const CARGO_TOML = 'src-tauri/Cargo.toml';
const PACKAGE_JSON = 'package.json';

/**
 * 前端用到的 Tauri 插件，必须在 `main.rs` 里**真的注册过**。
 *
 * 为什么需要这条护栏：
 *   前端的插件调用（`tauri-plugin-autostart-api` / `tauri-plugin-store-api` …）
 *   最终都是 `await invoke('plugin:<name>|<cmd>')`。如果对应的 `.plugin(...)`
 *   注册被删掉，**每次调用都会 reject**。
 *
 *   而本仓库最近几轮恰恰在给这些调用补 `.catch`（useConfig 的 store.get、
 *   开机自启的 isEnabled/enable/disable）。补了 `.catch` 之后，**注册缺失会被
 *   错误处理悄悄吞掉**：界面退化成默认值、日志里一行 warning，看起来「一切正常」，
 *   但功能其实从未生效。
 *   也就是说——**错误处理越完善，越需要一条测试确认插件确实注册了**，
 *   否则「优雅降级」就变成了「静默失效」。这正是本文件的动机。
 *
 * 权威来源的选择（这一条是踩坑后改的）：
 *   最初我扫描 `src/` 找 `plugin:xxx|`，结果**一处都找不到** ——
 *   因为该字面量并不在前端源码里，而在 `node_modules` 的插件包内
 *   （例如 `tauri-plugin-store-api/dist-js/index.mjs:35` 的
 *   `invoke("plugin:store|get")`）。前端源码里出现它的地方**只有我写的注释**，
 *   剥离注释后自然为空。
 *   所以「前端需要哪些插件」的权威来源是 **`package.json`** 里的
 *   `tauri-plugin-*-api` 依赖：装了哪个 API 包，就说明前端在调哪个插件。
 */

/** 从 package.json 读出前端依赖的 Tauri 插件（`tauri-plugin-<name>-api`）。 */
async function frontendPluginNames() {
    const pkg = JSON.parse(await readFile(PACKAGE_JSON, 'utf8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const names = new Set();
    for (const dep of Object.keys(deps)) {
        const m = /^tauri-plugin-([a-z0-9-]+)-api$/.exec(dep);
        if (m) names.add(m[1]);
    }
    return names;
}

/** 剥掉 `//` 行注释：注释里提到插件名不算「已注册」。 */
function stripLineComments(source) {
    return source.replace(/^\s*\/\/.*$/gm, '');
}

test('every plugin the frontend depends on is registered in main.rs', async () => {
    const names = await frontendPluginNames();
    assert.ok(names.size >= 3, `expected several tauri-plugin-*-api dependencies in package.json, found ${names.size}`);

    const mainCode = stripLineComments(await readFile(MAIN_RS, 'utf8'));

    const missing = [];
    for (const name of names) {
        // Cargo 包名里的 `-` 在 Rust 标识符里写作 `_`
        const ident = name.replaceAll('-', '_');
        if (!new RegExp(`tauri_plugin_${ident}\\s*::`).test(mainCode)) missing.push(name);
    }
    assert.deepEqual(
        missing,
        [],
        `these plugins are used by the frontend but never registered in main.rs: ${JSON.stringify(missing)}`
    );
});

test('every plugin crate registered in main.rs is declared in Cargo.toml', async () => {
    const mainCode = stripLineComments(await readFile(MAIN_RS, 'utf8'));
    const used = new Set([...mainCode.matchAll(/tauri_plugin_([a-z0-9_]+)\s*::/g)].map((m) => m[1]));
    assert.ok(used.size >= 3, `expected several plugin crates in main.rs, found ${used.size}`);

    const cargo = await readFile(CARGO_TOML, 'utf8');
    const missing = [];
    for (const ident of used) {
        // Rust 标识符 `tauri_plugin_fs_watch` -> Cargo 包名 `tauri-plugin-fs-watch`。
        // 注意必须带上 `tauri-plugin-` 前缀：crate 行本身就以它开头，
        // 只拼 `fs-watch` 会匹配不到（这里踩过一次）。
        const crate = `tauri-plugin-${ident.replace(/^tauri_plugin_/, '').replaceAll('_', '-')}`;
        if (!new RegExp(`^\\s*${crate}\\s*=`, 'm').test(cargo)) missing.push(crate);
    }
    assert.deepEqual(
        missing,
        [],
        `these plugin crates are used in main.rs but not declared in Cargo.toml: ${JSON.stringify(missing)}`
    );
});

test('the autostart and store plugins keep the registration the frontend depends on', async () => {
    // 这两条是最近补过错误处理的对象：正因为补了 .catch，注册一旦消失会「静默降级」
    // 而不是报错，所以单独钉住，并把**初始化参数**一并钉住。
    const mainCode = stripLineComments(await readFile(MAIN_RS, 'utf8'));

    assert.match(
        mainCode,
        /tauri_plugin_autostart\s*::\s*init\(/,
        'the autostart plugin must be registered; the settings switch depends on it'
    );
    assert.match(
        mainCode,
        /MacosLauncher::LaunchAgent/,
        'the macOS launcher kind must stay explicit (LaunchAgent, not AppleScript)'
    );
    assert.match(
        mainCode,
        /tauri_plugin_store\s*::\s*Builder::default\(\)\.build\(\)/,
        'the store plugin must be registered; useConfig reads every setting through it'
    );
});

test('removing a registration is actually detected (the guard is not vacuous)', async () => {
    // 反向自检：把源码里的 autostart 注册删掉后，第 1 条测试的判据必须变红。
    // 这里不写文件，只在内存里模拟，确认判据对删除是敏感的。
    const mainCode = stripLineComments(await readFile(MAIN_RS, 'utf8'));
    assert.match(mainCode, /tauri_plugin_autostart\s*::/, 'precondition: autostart is registered');

    const deleted = mainCode.replace(/tauri_plugin_autostart\s*::[\s\S]*?\)\)/m, '');
    assert.doesNotMatch(
        deleted,
        /tauri_plugin_autostart\s*::/,
        'the guard pattern must stop matching once the registration is removed'
    );
});

test('the frontend plugin list is derived from package.json, not hand-written', async () => {
    // 元测试：守住「权威来源」这件事本身。
    const names = await frontendPluginNames();
    assert.ok(names.has('autostart'), 'autostart must be detected from package.json');
    assert.ok(names.has('store'), 'store must be detected from package.json');
    // 反向：一个不存在的插件名不应凭空出现
    assert.ok(!names.has('definitely-not-a-plugin'), 'the list must not contain made-up entries');
});
