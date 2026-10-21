import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('macOS selection uses a bounded AX read without the upstream AppleScript fallback', async () => {
    const source = await readFile('src-tauri/src/window.rs', 'utf8');
    const start = source.indexOf('fn selected_text()');
    const end = source.indexOf('#[cfg(not(target_os = "macos"))]', start);
    const mac = source.slice(start, end);
    assert.match(mac, /focused_uielement\(\)/);
    assert.match(mac, /focused_application\(\)/);
    assert.match(mac, /set_messaging_timeout\(0\.25\)/);
    assert.doesNotMatch(mac, /selection::get_text|Command::new|osascript/);
    const selection = source.slice(
        source.indexOf('pub fn selection_translate()'),
        source.indexOf('pub fn clipboard_translate()')
    );
    assert.doesNotMatch(selection, /use selection::get_text|let mut text = get_text\(\)/);
});

test('the macOS selection fallback clears the clipboard before simulating Cmd+C', async () => {
    const source = await readFile('src-tauri/src/window.rs', 'utf8');
    const start = source.indexOf('fn copy_selection_via_cgevent()');
    assert.notEqual(start, -1, 'the CGEvent selection fallback must exist');
    const end = source.indexOf('/// 还原剪贴板时该做什么', start);
    assert.notEqual(end, -1, 'the fallback function boundary must be locatable');
    const body = source.slice(start, end);

    const clearAt = body.indexOf('c.clear()');
    const simulateAt = body.indexOf('simulate_copy_with_cg_event()');
    assert.notEqual(clearAt, -1, 'the fallback must clear the old clipboard before copying');
    assert.notEqual(simulateAt, -1, 'the fallback must simulate Cmd+C');
    assert.ok(clearAt < simulateAt, 'clearing must happen before the synthetic Cmd+C');

    assert.match(
        body,
        /failed to clear clipboard before CGEvent copy[\s\S]*return None;/,
        'a failed clear must abort instead of reading stale clipboard text'
    );
    assert.match(body, /for _ in 0\.\.4/, 'the fallback should poll briefly for the new clipboard text');
});

test('selection translation never directly falls back to the clipboard API', async () => {
    const source = await readFile('src-tauri/src/window.rs', 'utf8');
    const start = source.indexOf('pub fn selection_translate()');
    const body = source.slice(start, source.indexOf('pub fn clipboard_translate()', start));
    assert.doesNotMatch(body, /arboard::Clipboard|clipboard\.get_text/);
});
