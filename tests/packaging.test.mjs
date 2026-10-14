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
