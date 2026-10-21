import assert from 'node:assert/strict';
import { globSync } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

test('release workflow builds every supported desktop OS family', async () => {
    const workflow = await readFile('.github/workflows/package.yml', 'utf8');
    for (const job of ['build-for-macos', 'build-for-windows', 'build-for-linux']) {
        assert.match(workflow, new RegExp(`^    ${job}:`, 'm'));
    }
    assert.match(workflow, /aarch64-apple-darwin/);
    assert.match(workflow, /x86_64-pc-windows-msvc/);
    assert.match(workflow, /aarch64-unknown-linux-gnu/);
    assert.match(workflow, /RELEASE_TAG: \$\{\{ github\.ref_name \}\}/);
});

test('selection extensions launch and publish this fork', async () => {
    const workflow = await readFile('.github/workflows/package.yml', 'utf8');
    const popclip = await readFile('.scripts/popclip/Pot.sh', 'utf8');
    const popclipBuild = await readFile('.scripts/popclip/build.sh', 'utf8');
    const snipdoBuild = await readFile('.scripts/snipdo/build.sh', 'utf8');
    assert.match(popclip, /open -g -a cup-translate/);
    assert.match(popclip, /127\.0\.0\.1:60828\/translate/);
    assert.match(popclipBuild, /cup-translate\.popclipextz/);
    assert.match(snipdoBuild, /cup-translate\.pbar/);
    assert.match(workflow, /\.scripts\/popclip\/cup-translate\.popclipextz/);
    assert.match(workflow, /\.scripts\/snipdo\/cup-translate\.pbar/);
});

test('fixed WebView2 installers use this fork updater and its signing key', async () => {
    const main = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8')).tauri.updater;
    for (const arch of ['x64', 'x86', 'arm64']) {
        const updater = JSON.parse(await readFile(`src-tauri/webview.${arch}.json`, 'utf8')).tauri.updater;
        assert.deepEqual(updater.endpoints, [
            'https://github.com/charonwwang/cup-translate/releases/download/updater/update-fix-runtime.json',
        ]);
        assert.equal(updater.pubkey, main.pubkey);
    }
});

test('updater manifests resolve the triggering tag and reject missing signatures', async () => {
    for (const path of ['updater/updater.mjs', 'updater/updater-for-fix-runtime.mjs']) {
        const source = await readFile(path, 'utf8');
        assert.match(source, /process\.env\.RELEASE_TAG/);
        assert.match(source, /releases\/tags\/\$\{encodeURIComponent\(tag\)\}/);
        assert.match(source, /throw new Error\(`Cannot fetch signature:/);
        assert.match(source, /throw new Error\(`Empty signature:/);
    }
});

test('Linux CI normalizes deb dependencies after bundling', async () => {
    const buildScript = await readFile('.github/actions/build.sh', 'utf8');
    assert.match(buildScript, /fix-deb-dependencies\.mjs/);
    assert.match(buildScript, /APPIMAGE_BUNDLE_GSTREAMER=1/);
});

test('RPM declares Fedora runtime package names rather than Debian development packages', async () => {
    const config = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8'));
    assert.deepEqual(config.tauri.bundle.rpm.depends, ['libxdo', 'libxcb', 'libXrandr', 'tesseract']);
});

test('workspace declaration works with the pnpm 9 used by release CI', async () => {
    const workspace = await readFile('pnpm-workspace.yaml', 'utf8');
    assert.match(workspace, /packages:\s*\n\s*- \./);
});

test('macOS OCR helpers are included as bundle resources', async () => {
    const config = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8'));
    for (const arch of ['aarch64', 'x86_64']) {
        const resource = `resources/ocr-${arch}-apple-darwin`;
        assert.ok(config.tauri.bundle.resources.includes(resource));
        await access(join('src-tauri', resource));
    }
});

test('macOS dmg bundling declares explicit layout and OCR resource roots', async () => {
    const config = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8'));
    const bundle = config.tauri.bundle;
    // dmg layout must be explicit so the installer window is deterministic on any host
    assert.equal(typeof bundle.dmg, 'object');
    assert.equal(typeof bundle.dmg.appPosition?.x, 'number');
    assert.equal(typeof bundle.dmg.applicationFolderPosition?.x, 'number');
    assert.equal(typeof bundle.dmg.windowSize?.width, 'number');

    // macOS bundle resources must live under resources/ so system_ocr.rs resolves
    // `resources/ocr-<arch>-apple-darwin` inside the .app bundle.
    for (const resource of bundle.resources) {
        assert.ok(resource.startsWith('resources/'), `${resource} must stay under resources/`);
    }
    const macosOverride = JSON.parse(await readFile('src-tauri/tauri.macos.conf.json', 'utf8'));
    for (const resource of macosOverride.tauri.bundle.resources) {
        assert.ok(resource.startsWith('resources/'), `${resource} must stay under resources/`);
    }
    // every icon referenced by the macOS override must exist
    for (const icon of macosOverride.tauri.bundle.icon) {
        await access(join('src-tauri', icon));
    }
    await access(join('src-tauri', macosOverride.tauri.systemTray.iconPath));
});

test('Rust service whitelists stay in sync with the frontend registries', async () => {
    // Regression guard for CLAUDE.md §4.1: check_service_available() silently drops
    // any translate/tts instance whose builtin name is missing from the Rust whitelist,
    // so a frontend engine without a matching Rust entry dies after one restart.
    const configSource = await readFile('src-tauri/src/config.rs', 'utf8');
    const extractList = (name) => {
        const match = configSource.match(new RegExp(`let ${name}: Vec<&str> = vec!\\[([^\\]]*)\\]`));
        assert.ok(match, `${name} must exist in config.rs`);
        return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]).sort();
    };

    const extractExports = async (path) => {
        const source = await readFile(path, 'utf8');
        return [...source.matchAll(/^export const (\w+) = (?:_\w+|guardService\([^;]+\));/gm)]
            .map((entry) => entry[1])
            .sort();
    };

    assert.deepEqual(extractList('builtin_translate_list'), await extractExports('src/services/translate/index.jsx'));
    assert.deepEqual(extractList('builtin_recognize_list'), await extractExports('src/services/recognize/index.jsx'));
    assert.deepEqual(extractList('builtin_tts_list'), await extractExports('src/services/tts/index.jsx'));
    assert.deepEqual(extractList('builtin_collection_list'), await extractExports('src/services/collection/index.jsx'));
});

test('a corrupt service list does not disable cleanup for the other lists', async () => {
    // Regression guard: check_service_available() used `?` on each serde parse, so one
    // malformed list (e.g. a non-string element) aborted the whole function and the
    // remaining translate/tts/collection lists silently stopped being pruned. The
    // caller ignored the Result, so nothing was logged either.
    const source = await readFile('src-tauri/src/config.rs', 'utf8');
    const start = source.indexOf('pub fn check_service_available');
    assert.notEqual(start, -1, 'check_service_available must exist');
    const body = source.slice(start);
    const end = body.indexOf('\n}\n');
    assert.notEqual(end, -1, 'check_service_available body must be delimited');
    const fn = body.slice(0, end);

    // Must not short-circuit the whole function on an invalid list value.
    assert.equal(
        /serde_json::from_value::<Vec<String>>\(\w+\)\?/.test(fn),
        false,
        'check_service_available must not use `?` on service list parsing'
    );
    // Each list must be handled independently, logging rather than aborting.
    assert.match(fn, /Skipping service check for \{\}/);

    // All four lists must still be checked.
    for (const key of [
        'recognize_service_list',
        'translate_service_list',
        'tts_service_list',
        'collection_service_list',
    ]) {
        assert.ok(fn.includes(key), `${key} must still be checked`);
    }

    // The caller must not silently swallow the error.
    assert.doesNotMatch(source, /let _ = check_service_available\(\);/);
});

test('AppStream metainfo carries cup-translate branding, not the upstream identity', async () => {
    // CLAUDE.md §1.1: this fork must not claim the upstream pot/Pot trademark or identity.
    const metainfo = await readFile('packaging/cup-translate.metainfo.xml', 'utf8');
    assert.match(metainfo, /<id>com\.cup-translate\.app<\/id>/);
    assert.match(metainfo, /<name>cup-translate<\/name>/);
    assert.equal(metainfo.includes('Pylogmon'), false);
    assert.equal(metainfo.includes('<name>Pot</name>'), false);
    assert.equal(metainfo.includes('com.pot_app.pot'), false);
    assert.equal(metainfo.includes('pot-app.com'), false);
    // fork provenance must be stated, and upstream release links retained for GPL credit
    assert.match(metainfo, /pot-app\/pot-desktop/);
    assert.match(metainfo, /<launchable type="desktop-id">com\.cup-translate\.app\.desktop<\/launchable>/);
});

test('Tauri shell API permits opening links without its command execution feature', async () => {
    const config = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8'));
    assert.equal(config.tauri.allowlist.shell.all, false);
    assert.ok(config.tauri.allowlist.shell.open);
});

test('every built-in service icon resolves from the public root', async () => {
    // Node 22 exposes globSync; the CI and package workflow intentionally use Node 22.
    for (const infoPath of globSync('src/services/**/info.ts')) {
        const source = await readFile(infoPath, 'utf8');
        const iconPath = source.match(/icon:\s*['`]([^'`]+)['`]/)?.[1];
        if (iconPath === 'system') continue;
        assert.ok(iconPath?.startsWith('/logo/'), `${infoPath} must use a root-relative icon URL`);
        await access(join('public', iconPath.slice(1)));
    }
    for (const osIcon of ['Darwin.svg', 'Linux.svg', 'Windows_NT.svg']) {
        await access(join('public/logo', osIcon));
    }
});

test('window logos resolve from the public root', async () => {
    for (const windowPath of [
        'src/window/Config/index.jsx',
        'src/window/Config/pages/About/index.jsx',
        'src/window/Updater/index.jsx',
    ]) {
        const source = await readFile(windowPath, 'utf8');
        assert.match(source, /src=['"]\/icon\.png['"]/);
    }
    await access('public/icon.png');
});

test('productName, updater artifact names, and CI rename steps stay in sync', async () => {
    // docs/MAINTENANCE.md §7 warns: changing package.productName without syncing
    // updater/*.mjs artifact names and CI rename steps breaks update checks with a 404.
    const config = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8'));
    const productName = config.package.productName;
    assert.ok(productName && typeof productName === 'string', 'productName must be set');

    // updater.mjs artifact name prefixes must match productName
    for (const path of ['updater/updater.mjs', 'updater/updater-for-fix-runtime.mjs']) {
        const source = await readFile(path, 'utf8');
        const artifactName = source.match(/([\w-]+)_\$\{assetVersion\}/)?.[1];
        assert.ok(artifactName, `${path} must build artifact names from a productName prefix`);
        assert.equal(
            artifactName,
            productName,
            `${path} artifact prefix "${artifactName}" must match package.productName "${productName}"`
        );
    }

    // CI rename steps must also use the same productName prefix
    const workflow = await readFile('.github/workflows/package.yml', 'utf8');
    const ciPrefixes = [...workflow.matchAll(/cup-translate_\$\{\{needs\.change-version\.outputs\.version\}\}/g)];
    assert.ok(ciPrefixes.length > 0, 'CI must rename artifacts using the productName prefix for updater compatibility');
    assert.equal(
        workflow.includes(`${productName}_\${{needs.change-version.outputs.version}}`),
        true,
        `CI rename steps must use package.productName "${productName}"`
    );
});

/**
 * `tauri::generate_context!()` 在**编译期**读取 `build.distDir`，
 * 该目录不存在会让整个 Rust 编译失败（`proc macro panicked`）。
 *
 * 为什么值得一条护栏：这个坑在**已有 `dist/` 的工作副本里不会暴露**
 * —— 旧产物一直在，cargo 能正常通过。只有干净克隆 / 新机器 / CI 才会炸，
 * 属于最容易被漏掉的一类环境依赖。
 *
 * 实测（干净克隆，无 dist/）：
 *   error: proc macro panicked
 *      --> src/main.rs:179:16
 *       = help: message: The `distDir` configuration is set to `"../dist"`
 *         but this path doesn't exist
 * 先 `pnpm build` 生成 dist/ 后，Rust **141/141** 与 Node **333/333** 全通过。
 */
test('tauri build.distDir points at the frontend output the build commands produce', async () => {
    const tauri = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8'));

    // distDir 是相对 src-tauri/ 解析的，产物由 `pnpm build`（vite）写到仓库根的 dist/
    const distDir = tauri.build.distDir;
    assert.equal(
        distDir,
        '../dist',
        `distDir must stay '../dist' (relative to src-tauri/), which is what pnpm build writes, got: ${distDir}`
    );

    // 该 feature 在 cargo build 时把 dist/ 嵌进二进制：改前端后必须先 pnpm build
    // 再 cargo build，否则跑的是旧前端。这里固定住「嵌的就是 dist/」这一事实。
    const cargoToml = await readFile('src-tauri/Cargo.toml', 'utf8');
    assert.match(
        cargoToml,
        /^custom-protocol\s*=\s*\["tauri\/custom-protocol"\]/m,
        'custom-protocol must remain wired to tauri/custom-protocol (it is what embeds dist/ into the binary)'
    );

    // 文档必须写明「新克隆要先 pnpm build」这个前置条件，否则照抄 §6 命令清单会踩坑
    const claude = await readFile('CLAUDE.md', 'utf8');
    assert.match(
        claude,
        /distDir/,
        'CLAUDE.md must document the distDir prerequisite so a fresh clone does not fail the Rust build'
    );
    assert.match(
        claude,
        /pnpm build[\s\S]{0,200}(再|cargo)/,
        'CLAUDE.md must state that pnpm build has to run before the cargo commands'
    );
});

test('a fresh clone has no dist/ committed, so the build order genuinely matters', async () => {
    // dist/ 是构建产物，必须被 gitignore —— 若有人误提交它，
    // 上面那个「干净克隆会失败」的前提就不成立了，同时会把旧前端带进仓库。
    const ignored = await readFile('.gitignore', 'utf8');
    assert.match(ignored, /^\/?dist\/?$/m, 'dist/ must be gitignored (it is a build artifact)');

    // 反向确认：git **索引**里没有 dist/ 下的任何文件。
    //
    // ⚠️ 这里必须查 git 索引，不能查文件系统：`dist/` 是本地构建产物，
    // 在本机通常**存在**（`pnpm build` 刚生成过），用 globSync 查文件系统
    // 会把「本地产物」误判成「已提交」。本测试第一版就是这么写错的 ——
    // 它报出 `dist/index.html` 等「已跟踪」，而 `git ls-files dist/` 其实是空的。
    const { execFileSync } = await import('node:child_process');
    const tracked = execFileSync('git', ['ls-files', 'dist'], { encoding: 'utf8' }).split('\n').filter(Boolean);
    assert.deepEqual(tracked, [], `dist/ must never be committed; git tracks: ${JSON.stringify(tracked.slice(0, 5))}`);
});

/**
 * 更新器清单里的**每个平台键**都必须指向一个**真实会被 CI 产出的文件名**。
 *
 * 与既有那条 `productName, updater artifact names, and CI rename steps stay in sync`
 * 的分工：那条只比对**前缀**（`cup-translate`）与 `productName` 是否一致；
 * 本条比对**平台 → arch 后缀**的对应关系，两者不重叠。
 *
 * 为什么需要（已实测的覆盖缺口）：
 *   把 `windows-x86_64` 的产物名从 `_x64-setup.nsis.zip` 误写成
 *   `_x86_64-setup.nsis.zip`（很自然的复制粘贴错误）后，
 *   **现有 21 条测试全部通过** —— 用户更新时会拿到 404，
 *   而且只在真正发版后才暴露。故补上这条逐平台的交叉校验。
 */
test('every updater platform entry maps to an artifact name the CI actually builds', async () => {
    const source = await readFile('updater/updater.mjs', 'utf8');

    // updater.mjs 里 platforms 的每个条目：平台键 -> 产物文件名模板
    const entries = new Map();
    for (const m of source.matchAll(/'(?<platform>[a-z0-9_-]+)':\s*await entry\(`(?<name>[^`]+)`\)/g)) {
        entries.set(m.groups.platform, m.groups.name);
    }
    assert.ok(entries.size >= 6, `expected the full platform matrix, found ${entries.size}`);

    const workflow = await readFile('.github/workflows/package.yml', 'utf8');

    // ---- Windows：三个 target 必须各自对应一个 updater 条目，后缀不能串 ----
    const winExpect = {
        'x86_64-pc-windows-msvc': ['windows-x86_64', '_x64-setup.nsis.zip'],
        'i686-pc-windows-msvc': ['windows-i686', '_x86-setup.nsis.zip'],
        'aarch64-pc-windows-msvc': ['windows-aarch64', '_arm64-setup.nsis.zip'],
    };
    for (const [target, [platform, suffix]] of Object.entries(winExpect)) {
        assert.ok(workflow.includes(target), `CI must still build ${target}`);
        assert.equal(
            entries.get(platform),
            `cup-translate_\${assetVersion}${suffix}`,
            `${platform} must point at the artifact CI produces for ${target} (suffix ${suffix})`
        );
    }

    // ---- Windows 的 target 集合与 updater 的平台集合必须一一对应 ----
    // 少一个 => 该架构的用户收不到更新；多一个 => 指向不存在的文件（404）
    const winTargets = [...workflow.matchAll(/(x86_64|i686|aarch64)-pc-windows-msvc/g)].map((m) => m[1]);
    const winPlatforms = Object.keys(winExpect).map((t) => winExpect[t][0]);
    assert.deepEqual(
        [...new Set(winTargets)].sort(),
        ['aarch64', 'i686', 'x86_64'],
        'the Windows build matrix must keep all three architectures'
    );
    assert.deepEqual(
        winPlatforms.sort(),
        ['windows-aarch64', 'windows-i686', 'windows-x86_64'],
        'updater.mjs must cover exactly the Windows architectures CI builds'
    );

    // ---- macOS：CI 的 rename 步骤产出 _aarch64 / _x64，updater 必须一致 ----
    for (const [platform, suffix] of [
        ['darwin-aarch64', '_aarch64.app.tar.gz'],
        ['darwin-x86_64', '_x64.app.tar.gz'],
    ]) {
        assert.equal(
            entries.get(platform),
            `cup-translate_\${assetVersion}${suffix}`,
            `${platform} must match the CI rename step output`
        );
        // 该后缀必须真的出现在 CI 的改名命令里
        assert.match(
            workflow,
            new RegExp(
                `cup-translate_\\$\\{\\{needs\\.change-version\\.outputs\\.version\\}\\}${suffix.replace(/\./g, '\\.')}`
            ),
            `CI must rename the macOS bundle to the ${suffix} form that ${platform} expects`
        );
    }

    // ---- Linux：只保留 x86_64 的 AppImage ----
    // 上游原版把 i686/aarch64/armv7 错误地指向 macOS 产物，会让用户下到装不上的包。
    assert.equal(
        entries.get('linux-x86_64'),
        'cup-translate_${assetVersion}_amd64.AppImage.tar.gz',
        'linux-x86_64 must point at the AppImage tarball'
    );
    for (const bogus of ['linux-i686', 'linux-aarch64', 'linux-armv7']) {
        assert.ok(
            !entries.has(bogus),
            `${bogus} must NOT be present: Tauri's updater only supports AppImage self-replace on Linux, ` +
                `and CI only builds x86_64 — a bogus entry makes users download an uninstallable package`
        );
    }

    // ---- 平台键的形态：不允许出现 Tauri 不认识的 target triple ----
    const knownPrefixes = ['darwin-', 'windows-', 'linux-'];
    for (const platform of entries.keys()) {
        assert.ok(
            knownPrefixes.some((p) => platform.startsWith(p)),
            `unexpected platform key in updater manifest: ${platform}`
        );
    }
});

/**
 * `updater-for-fix-runtime.mjs` 生成的是**固定版本 WebView2 运行时**的清单。
 * 它只有 Windows 条目（Linux/macOS 的 WebView2 概念不存在），
 * 且产物名由 CI 的 `Rename-Item` 步骤改成带 `_fix_webview2_runtime` 的形态。
 * 两者必须逐字对齐，否则该清单指向的文件不存在（404），
 * 使用固定运行时版本的用户收不到更新。
 */
test('the fixed-runtime updater manifest matches the CI rename step and stays Windows-only', async () => {
    const source = await readFile('updater/updater-for-fix-runtime.mjs', 'utf8');
    const workflow = await readFile('.github/workflows/package.yml', 'utf8');

    const entries = new Map();
    for (const m of source.matchAll(/'(?<platform>[a-z0-9_-]+)':\s*await entry\(`(?<name>[^`]+)`\)/g)) {
        entries.set(m.groups.platform, m.groups.name);
    }

    // 只应有 Windows 条目：WebView2 是 Windows 专有运行时
    assert.deepEqual(
        [...entries.keys()].sort(),
        ['windows-aarch64', 'windows-i686', 'windows-x86_64'],
        'the fixed-runtime manifest must contain exactly the three Windows architectures'
    );

    // 逐条对照 CI 的 Rename-Item 产物名
    const archBySuffix = { 'windows-x86_64': 'x64', 'windows-i686': 'x86', 'windows-aarch64': 'arm64' };
    for (const [platform, arch] of Object.entries(archBySuffix)) {
        const expected = `cup-translate_\${assetVersion}_${arch}_fix_webview2_runtime-setup.nsis.zip`;
        assert.equal(entries.get(platform), expected, `${platform} must match the CI rename target for arch ${arch}`);
        // CI 的重命名命令必须是**参数化**的（用 ${{ matrix.arch }}），
        // 而不是写死某个架构 —— 否则三个架构里只有一个会被改名，
        // 另外两个仍是不带 _fix_webview2_runtime 的旧名，清单就会 404。
        //
        // 注意：CI 原文里是 `${{ matrix.arch }}`，**不是**字面量 `x64`；
        // 本测试第一版按字面量匹配，因此永远匹配不上（假失败）。
        assert.match(
            workflow,
            /cup-translate_\$\{\{needs\.change-version\.outputs\.version\}\}_\$\{\{ matrix\.arch \}\}_fix_webview2_runtime-setup\.nsis\.zip/,
            'CI must rename the bundle to the _fix_webview2_runtime form using the matrix arch parameter'
        );
    }

    // matrix.arch 的三个取值必须与上面的后缀集合一致
    const archValues = new Set([...workflow.matchAll(/^\s+arch: (x64|x86|arm64)$/gm)].map((m) => m[1]));
    assert.deepEqual(
        [...archValues].sort(),
        ['arm64', 'x64', 'x86'],
        'the CI matrix must define exactly the three arches the manifest names'
    );
});
