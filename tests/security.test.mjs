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

// ── 本轮新增：macOS 抓图失败不得拿旧图冒充新图 ──

/**
 * 背景（实测，本机 macOS）：
 *   `ocr_recognize()` / `ocr_translate()` 原来这样调用 screencapture：
 *
 *       if let Ok(_output) = std::process::Command::new("/usr/sbin/screencapture")
 *           .arg("-i").arg("-r").arg(path).output()
 *       { recognize_window(); }
 *
 *   `Ok` 只表示「进程被成功创建并运行完毕」，**与退出码无关**
 *   —— 与 `tts.rs` 里被修掉的 `is_ok()` 是同一类错误。
 *
 *   实测 `screencapture -x <path>`：
 *     · 失败时退出码为 1，stderr = `could not create image from display`
 *       （屏幕录制权限未授予时即如此）；
 *     · 失败时**不创建**目标文件；
 *     · 若目标路径**已存在**，失败时**原样保留**（放 12 字节 `old-content`
 *       进去，失败后读回来仍是 `old-content`）。
 *
 *   而 `pot_screenshot_cut.png` 正是识别流程读取的文件
 *   （`cmd.rs::get_base64` 与各 `recognize/*` 服务都读它）。
 *   所以旧代码的后果是：抓图失败 -> 仍然进入识别 -> **识别上一张截图**，
 *   用户看到与本次操作无关的结果，且没有任何错误提示。
 *
 * 修复：抽出 `remove_stale_screenshot()`（抓图前清掉旧文件）+
 * `macos_capture_screenshot()`（检查退出码，失败返回 false 不再往下走）。
 * 行为契约由 Rust 单测 `stale_screenshot_is_removed_before_capturing`
 * 与 `a_real_removal_failure_is_reported_not_swallowed` 覆盖；
 * 这里锁「两个调用点都不得退回忽略退出码的写法」。
 */
test('macOS screenshot capture never treats a spawned process as a success', async () => {
    const source = await readFile('src-tauri/src/window.rs', 'utf8');
    const code = source
        .replace(/^\s*\/\/\/.*$/gm, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .split(/#\[cfg\(all\(test/)[0];

    // 不得再用 `if let Ok(_output) = ...screencapture...` 这种忽略退出码的写法
    assert.doesNotMatch(
        code,
        /if let Ok\(_?\w*\) = std::process::Command::new\("\/usr\/sbin\/screencapture"\)/,
        'is_ok()-style matching ignores the exit code, so a failed capture still runs recognition'
    );
    // 抓图必须走统一的 helper
    assert.match(code, /fn macos_capture_screenshot\(path: &str\) -> bool/, 'capture must go through one helper');
    assert.match(code, /output\.status\.success\(\)/, 'the capture result must be judged by exit status');
    // 抓图前必须先删旧文件：这是「旧图冒充新图」的直接防线
    assert.match(
        code,
        /fn macos_capture_screenshot[\s\S]{0,400}?remove_stale_screenshot\(path\)/,
        'the stale screenshot must be removed before capturing'
    );
    // 两个入口都必须用同一个 helper（各一次）
    const uses = code.match(/if macos_capture_screenshot\(&path\)/g) ?? [];
    assert.equal(uses.length, 2, `both ocr_recognize and ocr_translate must use the helper, found ${uses.length}`);
    // 反向自检：确认剥注释后仍有实质内容
    assert.ok(code.length > 8000, `stripped source looks too small: ${code.length} bytes`);
});
