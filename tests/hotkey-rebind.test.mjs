import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readHotkeySource = () => readFile('src-tauri/src/hotkey.rs', 'utf8');

test('rebinding a hotkey unregisters the previous accelerator first', async () => {
    // Tauri 的 GlobalShortcutManager::register() 不替换同名旧绑定：
    // 底层 global-hotkey 对已占用的 accelerator 直接报错。
    // 若改键前不先解绑，旧快捷键会一直生效（用户以为改成功了，其实没有）。
    const source = await readHotkeySource();
    assert.match(source, /fn unregister_previous\(app_handle: &AppHandle, name: &str\)/);
    assert.match(source, /\.global_shortcut_manager\(\)\s*\.unregister\(previous\.as_str\(\)\)/);

    // register() 必须在注册新键之前调用解绑
    const registerBody = source.slice(source.indexOf('fn register<F>'));
    const unregisterIdx = registerBody.indexOf('unregister_previous(app_handle, name);');
    const registerIdx = registerBody.indexOf('.register(hotkey.as_str(), handler)');
    assert.notEqual(unregisterIdx, -1, 'register() must call unregister_previous');
    assert.notEqual(registerIdx, -1, 'register() must register the new accelerator');
    assert.ok(
        unregisterIdx < registerIdx,
        'unregister_previous must run before registering the new accelerator',
    );
});

test('hotkey registry tracks real bindings so rebinds can be undone', async () => {
    // 记账表必须记录「配置键 -> 真实注册的 accelerator」，
    // 否则改键时无从得知该解绑哪一个键。
    const source = await readHotkeySource();
    assert.match(source, /static REGISTERED: Mutex<Option<HashMap<String, String>>>/);
    assert.match(source, /fn registered_accelerator\(name: &str\) -> Option<String>/);
    assert.match(source, /fn set_registered_accelerator\(name: &str, accelerator: Option<String>\)/);

    // 注册成功后写入记账
    assert.match(source, /set_registered_accelerator\(name, Some\(hotkey\.clone\(\)\)\)/);
    // 注册失败时不得写入记账（否则下次改键会去解绑一个不存在的键）
    const failBranch = source.slice(source.indexOf('Err(e) => {'));
    assert.doesNotMatch(
        failBranch.slice(0, failBranch.indexOf('Ok(())')),
        /set_registered_accelerator\(name, Some/,
    );
});

test('emptying a hotkey unbinds it instead of leaving the old key active', async () => {
    // 用户清空快捷键时，旧绑定必须被解绑（解绑发生在空值提前返回之前）
    const source = await readHotkeySource();
    const registerBody = source.slice(source.indexOf('fn register<F>'));
    const unregisterIdx = registerBody.indexOf('unregister_previous(app_handle, name);');
    const emptyReturnIdx = registerBody.indexOf('if hotkey.is_empty()');
    assert.notEqual(unregisterIdx, -1);
    assert.notEqual(emptyReturnIdx, -1);
    assert.ok(
        unregisterIdx < emptyReturnIdx,
        'the previous binding must be released even when the new value is empty',
    );
});

test('quitting keeps the hotkey registry consistent with real bindings', async () => {
    // unregister_all() 会释放全部绑定，记账表必须同步清空，
    // 否则记账与实际绑定漂移，后续改键会解绑到错误的对象。
    const source = await readFile('src-tauri/src/tray.rs', 'utf8');
    const quitBody = source.slice(source.indexOf('fn on_quit_click'));
    assert.match(quitBody, /unregister_all\(\)/);
    assert.match(quitBody, /clear_registered_accelerators\(\)/);

    const hotkey = await readHotkeySource();
    assert.match(hotkey, /pub fn clear_registered_accelerators\(\)/);
});