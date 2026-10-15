import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('privileged translation view never injects remote HTML', async () => {
    const source = await readFile('src/window/Translate/components/TargetArea/index.jsx', 'utf8');
    assert.equal(source.includes('dangerouslySetInnerHTML'), false);
    assert.match(source, /richTextToPlainText\(sentence\['source'\]\)/);
    assert.match(source, /richTextToPlainText\(sentence\['target'\]\)/);
});

test('desktop CSP does not disable browser web security', async () => {
    const config = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8'));
    const windows = config.tauri.windows ?? [];
    assert.equal(
        windows.some((window) => window.additionalBrowserArgs?.includes('--disable-web-security')),
        false
    );
    assert.doesNotMatch(config.tauri.security.csp, /default-src \*/);
    assert.match(config.tauri.security.csp, /default-src 'self'/);

    const rustWindowSource = await readFile('src-tauri/src/window.rs', 'utf8');
    assert.equal(rustWindowSource.includes('--disable-web-security'), false);
});

test('selection translation ignores an empty selection', async () => {
    const source = await readFile('src-tauri/src/window.rs', 'utf8');
    assert.match(source, /if text\.trim\(\)\.is_empty\(\) \{[\s\S]*?return;/);
    assert.match(source, /Failed to send selected text to translation window/);
});

test('local-server failure notifications use this app identifier', async () => {
    const source = await readFile('src-tauri/src/server.rs', 'utf8');
    assert.doesNotMatch(source, /com\.pot-spp\.com/);
    assert.match(source, /Notification::new\(&identifier\)/);
});

test('backups use the current app identifier and restored settings restart the app', async () => {
    const backend = await readFile('src-tauri/src/backup.rs', 'utf8');
    assert.doesNotMatch(backend, /com\.pot-app\.desktop/);
    assert.match(backend, /\.config\(\)[\s\S]*?\.tauri[\s\S]*?\.bundle[\s\S]*?\.identifier/);
    assert.match(backend, /fn restore_archive/);

    const restore = await readFile('src/window/Config/pages/Backup/utils/restore.js', 'utf8');
    assert.match(restore, /await invoke\('reload_store'\)/);
    assert.match(restore, /await relaunch\(\)/);
    const config = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8'));
    assert.equal(config.tauri.allowlist.process.relaunch, true);
});
