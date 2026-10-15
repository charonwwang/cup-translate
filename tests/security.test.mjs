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

    // 修复前的判据是 /if text\.trim\(\)\.is_empty\(\) \{[\s\S]*?return;/ ——
    // `[\s\S]*?` 会**跨块**匹配，实测一次匹配跨越 1053 个字符、
    // 从第 410 行的空选区块一直吃到后面**别的逻辑**里的 return;。
    // 于是它实际上只断言了「文件里某处有 is_empty、其后某处有 return」。
    // 实测：把真正的兜底 `if text.trim().is_empty() { ... return; }` 改成
    // `if false {`（空选区不再被忽略），本测试**仍然通过**。
    //
    // 现在改为精确锚定那个块：断言从 `if text.trim().is_empty()` 到它**自己**
    // 的 `return;` 之间，必须依次出现 warn + 本地化通知 + return，
    // 且这段区间内不得嵌套另一个 `if text.trim().is_empty()` 分支起点。
    const start = source.indexOf(
        'if text.trim().is_empty() {\n        warn!("selection_translate: no text selected");'
    );
    assert.notEqual(start, -1, 'the empty-selection bail-out must exist verbatim');

    const block = source.slice(start, source.indexOf('\n    }\n', start) + 7);
    // 1) 该块必须以 return; 结束（空选区不再继续往下走）
    assert.match(block, /return;\s*\}\s*$/, 'the empty-selection block must return');
    // 2) 通知文案必须走 notification.rs（本地化），不能硬编码
    assert.match(
        block,
        /crate::notification::text\(/,
        'the empty-selection notice must be localized through notification.rs'
    );
    // 3) 块内不得再出现第二个 is_empty 分支（那说明锚定跑偏了）
    assert.equal(
        block.split('is_empty()').length - 1,
        1,
        'the anchored block should contain exactly one is_empty() check'
    );

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
