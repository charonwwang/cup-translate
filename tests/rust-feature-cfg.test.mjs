import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

import { stripComments } from './helpers/source.mjs';

/**
 * Rust 的 feature 门控**必须**写成 `#[cfg(feature = "x")]`，
 * 不能写成 `#[cfg(x)]` —— 后者**永远为假**，而且不报任何错。
 *
 * 为什么这条护栏值得存在（本轮实测的根因）：
 *   `src-tauri/src/updater.rs` 通篇用的是 `#[cfg(updater)]`。
 *   cargo 传给 rustc 的是 `--cfg 'feature="updater"'`，
 *   它定义的是**名为 `feature`、值为 `"updater"`** 的 cfg，
 *   而**不是**名为 `updater` 的 cfg。于是 `#[cfg(updater)]` 恒为假：
 *
 *   · 真实实现（tauri::updater::builder(...).check()）**整段不参与编译**；
 *   · `check_update()` 永远走文件末尾的空实现 `{}`；
 *   · 「启动时检查更新」静默失效 —— 编译通过、运行不报错、日志无异常，
 *     只是功能不存在。这类「幽灵功能」靠读代码很难发现。
 *
 * 三条独立证据（修复前）：
 *   1) 往 `#[cfg(updater)]` 块里插唯一标记 `CUP_MARKER_CFG_PROBE`，
 *      重新编译后二进制里**找不到**该标记；
 *      把同一标记放进 `#[cfg(feature = "updater")]` 块则能找到。
 *   2) 二进制里 `"New version available"` / `"Failed to check update"`
 *      各出现 **0** 次（`log` 宏在 release 下**不会**被优化掉，
 *      已用一个最小 crate 单独验证过，故 0 次说明代码确实没编进去）。
 *   3) 真实配置里删掉 `check_update` 后启动，该键**没有被补回**
 *      （真实实现会 `set("check_update", true)`）；
 *      而同批的 `translate_detect_engine` / `clipboard_monitor` 都被正常补回。
 *
 * 修复后：
 *   1) 标记能找到；2) 两个字符串各出现 1 次；
 *   3) `check_update` 被补回为 `true`，且日志出现
 *      `[WARN][cup_translate::updater] Failed to check update: ...`
 *      （模块真的在跑；取不到 release JSON 是因为尚未发版，属预期）。
 */

const RUST_SRC = 'src-tauri/src';
const CARGO_TOML = 'src-tauri/Cargo.toml';

/** 列出 src-tauri/src 下的 .rs 文件。 */
async function rustFiles() {
    return (await readdir(RUST_SRC)).filter((f) => f.endsWith('.rs'));
}

/**
 * 取 Cargo.toml 的 [features] 段里定义的 feature 名。
 * 只看 [features] 段，避免把 [dependencies] 里的 `features = [...]` 混进来。
 */
function declaredFeatures(cargoToml) {
    const start = cargoToml.indexOf('[features]');
    assert.notEqual(start, -1, 'Cargo.toml must have a [features] section');
    // 到下一个顶层 [section] 为止
    const rest = cargoToml.slice(start + '[features]'.length);
    const nextSection = rest.search(/^\[/m);
    const body = nextSection === -1 ? rest : rest.slice(0, nextSection);

    const names = new Set();
    for (const line of body.split('\n')) {
        const m = /^\s*([a-zA-Z0-9_-]+)\s*=/.exec(line);
        if (m) names.add(m[1]);
    }
    return names;
}

test('no Rust source uses #[cfg(some_feature)] instead of #[cfg(feature = "some_feature")]', async () => {
    // 只有「该名字确实是本 crate 声明的 feature」时才算错 ——
    // `#[cfg(unix)]` / `#[cfg(target_os = "linux")]` / `#[cfg(test)]`
    // 是合法的内建 cfg，不能误报。
    const features = declaredFeatures(await readFile(CARGO_TOML, 'utf8'));
    assert.ok(features.size >= 1, `expected at least one declared feature, found ${features.size}`);
    assert.ok(
        features.has('updater'),
        'the crate must declare an `updater` feature (see CLAUDE.md §3.3): ' + JSON.stringify([...features])
    );

    const offenders = [];
    for (const f of await rustFiles()) {
        const code = stripComments(await readFile(`${RUST_SRC}/${f}`, 'utf8'));
        // 匹配 `#[cfg(NAME)]` / `#[cfg(not(NAME))]` / `#[cfg(any(NAME))]` 这类
        // **裸标识符**形式；带 `=` 的（feature = "x"、target_os = "linux"）不算。
        for (const m of code.matchAll(/#\[cfg\(([^)]*)\)\]/g)) {
            for (const inner of m[1].split(/[(,)]/)) {
                const name = inner.trim();
                if (!/^[a-z_][a-z0-9_]*$/.test(name)) continue;
                // 内建 cfg 白名单
                if (
                    [
                        'test',
                        'unix',
                        'windows',
                        'debug_assertions',
                        'doc',
                        'doctest',
                        'target_os',
                        'target_arch',
                    ].includes(name)
                ) {
                    continue;
                }
                if (features.has(name)) {
                    offenders.push(`${f}: #[cfg(${name})] should be #[cfg(feature = "${name}")]`);
                }
            }
        }
    }
    assert.deepEqual(
        offenders,
        [],
        `a bare #[cfg(name)] is never true for a cargo feature, so the code silently disappears: ${JSON.stringify(offenders)}`
    );
});

test('updater.rs gates on the feature spelling, and keeps both cfg branches', async () => {
    const code = stripComments(await readFile(`${RUST_SRC}/updater.rs`, 'utf8'));

    // 真实实现必须由 `feature = "updater"` 门控
    assert.match(
        code,
        /#\[cfg\(feature = "updater"\)\]\s*pub fn check_update/,
        'the real implementation must be gated with #[cfg(feature = "updater")]'
    );
    // 反向桩也要在，否则 --no-default-features 下会缺少符号
    assert.match(
        code,
        /#\[cfg\(not\(feature = "updater"\)\)\]\s*pub fn check_update/,
        'the no-op stub must remain for builds without the feature'
    );
    // 两侧都必须存在，且**恰好各一个** —— 少一个会编译失败或行为错位
    const real = (code.match(/pub fn check_update/g) || []).length;
    assert.equal(real, 2, `expected exactly two check_update definitions, found ${real}`);
});

test('the updater feature is enabled by the default feature set', async () => {
    // 若只声明 feature 而不放进 default，那么 §2.1 的标准构建命令
    // （`cargo build --release --features custom-protocol`，不带 updater）
    // 仍不会启用它，缺陷会原样保留。
    const cargoToml = await readFile(CARGO_TOML, 'utf8');
    const start = cargoToml.indexOf('[features]');
    const rest = cargoToml.slice(start);
    const nextSection = rest.slice('[features]'.length).search(/^\[/m);
    const body = nextSection === -1 ? rest : rest.slice(0, nextSection + '[features]'.length);

    const m = /^\s*default\s*=\s*\[([^\]]*)\]/m.exec(body);
    assert.notEqual(m, null, '[features] must define a default list that enables updater');
    assert.match(
        m[1],
        /"updater"/,
        `default features must include "updater" so the standard build command enables it, got: ${m[1]}`
    );
});

test('tauri dependency also enables its own updater feature', async () => {
    // 这是**两个不同的东西**：tauri 依赖的 "updater" 让 `tauri::updater` 模块存在；
    // 本 crate 的 updater feature 决定 updater.rs 里哪一段参与编译。
    // 缺任何一个都会失败（前者编译错，后者静默不生效）。
    const cargoToml = await readFile(CARGO_TOML, 'utf8');
    const line = cargoToml.split('\n').find((l) => /^tauri\s*=/.test(l));
    assert.ok(line, 'Cargo.toml must declare the tauri dependency');
    assert.match(line, /"updater"/, `the tauri dependency must enable its own updater feature, got: ${line}`);
});

test('the guard actually detects the bare-cfg shape (not vacuous)', async () => {
    // 反向自检：确认上面的正则能识别出错误写法，避免护栏永真。
    const bad = '#[cfg(updater)]\npub fn check_update(app: tauri::AppHandle) {}';
    const features = declaredFeatures(await readFile(CARGO_TOML, 'utf8'));

    const found = [];
    for (const m of stripComments(bad).matchAll(/#\[cfg\(([^)]*)\)\]/g)) {
        for (const inner of m[1].split(/[(,)]/)) {
            const name = inner.trim();
            if (/^[a-z_][a-z0-9_]*$/.test(name) && features.has(name)) found.push(name);
        }
    }
    assert.deepEqual(found, ['updater'], 'the detector must flag #[cfg(updater)] as an offender');

    // 而正确写法不得被误报
    const good = '#[cfg(feature = "updater")]\npub fn check_update(app: tauri::AppHandle) {}';
    const goodFound = [];
    for (const m of stripComments(good).matchAll(/#\[cfg\(([^)]*)\)\]/g)) {
        for (const inner of m[1].split(/[(,)]/)) {
            const name = inner.trim();
            if (/^[a-z_][a-z0-9_]*$/.test(name) && features.has(name)) goodFound.push(name);
        }
    }
    assert.deepEqual(goodFound, [], 'the correct spelling must not be reported');
});
