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
        return [...source.matchAll(/^export const (\w+) = _\w+;/gm)].map((entry) => entry[1]).sort();
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
