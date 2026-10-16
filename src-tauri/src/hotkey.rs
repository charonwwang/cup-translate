use crate::config::{get_str, set};
use crate::window::{
    clipboard_translate, input_translate, ocr_recognize, ocr_translate, selection_translate,
};
use crate::APP;
use log::{info, warn};
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, GlobalShortcutManager};

/// 已注册快捷键的记账表：`配置键 -> 实际注册的 accelerator`。
///
/// Tauri 的 `GlobalShortcutManager::register()` **不会**替换同名的旧绑定，
/// 而底层 `global-hotkey` 对「已被占用的 accelerator」会直接返回错误。
/// 因此改快捷键时若不先解绑旧值，会出现两种用户可见的故障：
///
/// 1. 旧快捷键仍然生效（注册新键成功，旧键从未解绑）；
/// 2. 新值恰好仍是旧值时注册报错，前端弹出「注册失败」但功能其实是好的。
///
/// 这里记录真实注册值，供改键前精确解绑。
static REGISTERED: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

/// 取出某个配置键当前实际注册的 accelerator（若有）。
fn registered_accelerator(name: &str) -> Option<String> {
    let guard = REGISTERED.lock().ok()?;
    guard.as_ref()?.get(name).cloned()
}

/// 写入/清除记账。`accelerator` 为 None 表示该键当前无绑定。
fn set_registered_accelerator(name: &str, accelerator: Option<String>) {
    let Ok(mut guard) = REGISTERED.lock() else {
        warn!("set_registered_accelerator: registry mutex poisoned");
        return;
    };
    let map = guard.get_or_insert_with(HashMap::new);
    match accelerator {
        Some(value) => {
            map.insert(name.to_string(), value);
        }
        None => {
            map.remove(name);
        }
    }
}

/// 解绑某个配置键此前注册的快捷键（若有），返回被解绑的 accelerator。
/// 调用方在「新键注册失败」时可据此回滚，避免用户两头落空。
fn unregister_previous(app_handle: &AppHandle, name: &str) -> Option<String> {
    let previous = registered_accelerator(name)?;
    set_registered_accelerator(name, None);
    if previous.is_empty() {
        return None;
    }
    if let Err(e) = app_handle
        .global_shortcut_manager()
        .unregister(previous.as_str())
    {
        // 旧绑定可能已被系统或其他模块释放，记日志但不阻断新键注册
        warn!(
            "Failed to unregister previous shortcut {} for {}: {:?}",
            previous, name, e
        );
        return None;
    }
    info!("Unregistered previous shortcut: {} for {}", previous, name);
    Some(previous)
}

/// 清空记账表。用于「全部解绑」场景，避免记账与真实绑定状态不一致。
pub fn clear_registered_accelerators() {
    let Ok(mut guard) = REGISTERED.lock() else {
        warn!("clear_registered_accelerators: registry mutex poisoned");
        return;
    };
    if let Some(map) = guard.as_mut() {
        map.clear();
    }
}

/// 决定某个配置键最终要注册的 accelerator。
///
/// `stored` 是 config 里的值，`default_key` 是调用点给的默认值：
/// - `stored` 为 `Some`：一律以用户为准（**包括用户设置的 `""`，表示禁用**）。
/// - `stored` 为 `None`（首次运行）：用 `default_key` 作为默认值。
///
/// 关键点：`default_key` 只是**默认值**，永远不能覆盖用户已保存的设置。
/// 修复前 `default_key` 非空时会直接顶替 config 值，
/// 导致「剪贴板翻译」的硬编码 "Alt+Shift+T" 把用户清空后的禁用状态顶回来。
/// 抽成纯函数以便直接单测这套优先级。
fn resolve_hotkey(stored: Option<String>, default_key: &str) -> String {
    stored.unwrap_or_else(|| default_key.to_string())
}

/// 注册一个全局快捷键。
///
/// `key` 的语义是**默认值**，不是强制值——最终取值见 [`resolve_hotkey`]。
/// 首次运行（config 中无该键）时会把默认值写回 config，
/// 使设置页显示的内容与实际生效的快捷键一致。
fn resolve_requested_hotkey(
    stored: Option<String>,
    default: &str,
    requested: Option<&str>,
) -> String {
    requested
        .map(str::to_owned)
        .unwrap_or_else(|| resolve_hotkey(stored, default))
}

fn register<F>(app_handle: &AppHandle, name: &str, handler: F, key: &str) -> Result<(), String>
where
    F: Fn() + Send + 'static,
{
    register_requested(app_handle, name, handler, key, None)
}

fn register_requested<F>(
    app_handle: &AppHandle,
    name: &str,
    handler: F,
    key: &str,
    requested: Option<&str>,
) -> Result<(), String>
where
    F: Fn() + Send + 'static,
{
    let stored = get_str(name);
    let is_first_run = stored.is_none();
    let hotkey = resolve_requested_hotkey(stored, key, requested);
    if is_first_run && requested.is_none() {
        // 落地默认值，避免「界面显示为空、实际却已绑定」
        set(name, hotkey.clone());
    }

    // 改键场景：先解绑该配置键的旧绑定，否则旧快捷键会一直生效。
    // 记下解绑掉的值，一旦新键注册失败就把它装回去——
    // 否则用户会「旧键没了、新键也没生效」，等于凭空丢了一个快捷键
    // （新键被别的功能或别的程序占用时很容易触发）。
    if registered_accelerator(name).as_deref() == Some(hotkey.as_str()) {
        if requested.is_some() {
            set(name, hotkey.clone());
        }
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    if !hotkey.is_empty() { probe_macos_shortcut(&hotkey)?; }
    let previous = unregister_previous(app_handle, name);

    if hotkey.is_empty() {
        if requested.is_some() {
            set(name, hotkey.clone());
        }
        return Ok(());
    }

    match app_handle
        .global_shortcut_manager()
        .register(hotkey.as_str(), handler)
    {
        Ok(()) => {
            set_registered_accelerator(name, Some(hotkey.clone()));
            if requested.is_some() {
                set(name, hotkey.clone());
            }
            info!("Registered global shortcut: {} for {}", hotkey, name);
        }
        Err(e) => {
            warn!(
                "Failed to register global shortcut: {} for {} {:?}",
                hotkey, name, e
            );
            // 回滚：把旧快捷键重新注册回去，保证用户至少不丢原有绑定
            if let Some(previous) = previous {
                if let Some(handler) = handler_factory(name) {
                    match app_handle
                        .global_shortcut_manager()
                        .register(previous.as_str(), handler)
                    {
                        Ok(()) => {
                            set_registered_accelerator(name, Some(previous.clone()));
                            info!(
                                "Restored previous shortcut after failed rebind: {} for {}",
                                previous, name
                            );
                        }
                        Err(restore_error) => warn!(
                            "Failed to restore previous shortcut {} for {}: {:?}",
                            previous, name, restore_error
                        ),
                    }
                }
            }
            return Err(e.to_string());
        }
    };
    Ok(())
}

/// 按配置键返回对应的处理函数，用于注册失败后的回滚重注册。
/// 与 `register_shortcut` 里的映射保持一致：新增快捷键时必须同步这里，
/// 否则该键在回滚时会「恢复失败」（只记 warning，不影响主流程）。
fn handler_factory(name: &str) -> Option<fn()> {
    match name {
        "hotkey_selection_translate" => Some(selection_translate as fn()),
        "hotkey_clipboard_translate" => Some(clipboard_translate as fn()),
        "hotkey_input_translate" => Some(input_translate as fn()),
        "hotkey_ocr_recognize" => Some(ocr_recognize as fn()),
        "hotkey_ocr_translate" => Some(ocr_translate as fn()),
        _ => None,
    }
}

// Register global shortcuts
pub fn register_shortcut(shortcut: &str) -> Result<(), String> {
    let app_handle = APP.get().ok_or("App is not initialized")?;
    match shortcut {
        "hotkey_selection_translate" => register(
            app_handle,
            "hotkey_selection_translate",
            selection_translate,
            "Alt+T",
        )?,
        "hotkey_clipboard_translate" => register(
            app_handle,
            "hotkey_clipboard_translate",
            clipboard_translate,
            "Alt+Shift+T",
        )?,
        "hotkey_input_translate" => {
            register(app_handle, "hotkey_input_translate", input_translate, "")?
        }
        "hotkey_ocr_recognize" => register(app_handle, "hotkey_ocr_recognize", ocr_recognize, "")?,
        "hotkey_ocr_translate" => register(app_handle, "hotkey_ocr_translate", ocr_translate, "")?,
        "all" => {
            let actions: [(&str, fn(), &str); 5] = [
                ("hotkey_selection_translate", selection_translate, "Alt+T"),
                (
                    "hotkey_clipboard_translate",
                    clipboard_translate,
                    "Alt+Shift+T",
                ),
                ("hotkey_input_translate", input_translate, ""),
                ("hotkey_ocr_recognize", ocr_recognize, ""),
                ("hotkey_ocr_translate", ocr_translate, ""),
            ];
            let mut errors = Vec::new();
            for (name, handler, default) in actions {
                if let Err(error) = register(app_handle, name, handler, default) {
                    errors.push(format!("{name}: {error}"));
                }
            }
            if !errors.is_empty() {
                return Err(errors.join("\n"));
            }
        }
        _ => {}
    }
    Ok(())
}

#[tauri::command]
pub fn register_shortcut_by_frontend(name: &str, shortcut: &str) -> Result<(), String> {
    let app_handle = APP.get().ok_or("App is not initialized")?;
    match name {
        "hotkey_selection_translate" => register_requested(
            app_handle,
            "hotkey_selection_translate",
            selection_translate,
            shortcut,
            Some(shortcut),
        )?,
        "hotkey_clipboard_translate" => register_requested(
            app_handle,
            "hotkey_clipboard_translate",
            clipboard_translate,
            shortcut,
            Some(shortcut),
        )?,
        "hotkey_input_translate" => register_requested(
            app_handle,
            "hotkey_input_translate",
            input_translate,
            shortcut,
            Some(shortcut),
        )?,
        "hotkey_ocr_recognize" => register_requested(
            app_handle,
            "hotkey_ocr_recognize",
            ocr_recognize,
            shortcut,
            Some(shortcut),
        )?,
        "hotkey_ocr_translate" => register_requested(
            app_handle,
            "hotkey_ocr_translate",
            ocr_translate,
            shortcut,
            Some(shortcut),
        )?,
        _ => return Err(format!("Unknown shortcut action: {name}")),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{handler_factory, resolve_hotkey};

    #[test]
    fn submitted_shortcut_overrides_old_config_only_when_explicit() {
        assert_eq!(
            super::resolve_requested_hotkey(Some("Alt+T".into()), "Alt+T", Some("Alt+K")),
            "Alt+K"
        );
        assert_eq!(
            super::resolve_requested_hotkey(Some("Alt+T".into()), "Alt+T", Some("")),
            ""
        );
        assert_eq!(
            super::resolve_requested_hotkey(Some("Alt+K".into()), "Alt+T", None),
            "Alt+K"
        );
        assert_eq!(
            super::resolve_requested_hotkey(None, "Alt+T", None),
            "Alt+T"
        );
    }

    #[test]
    fn user_config_always_wins_over_the_default() {
        // 核心不变量：默认值只在「config 里没有这个键」时才生效。
        let stored = Some("Ctrl+Alt+K".to_string());
        assert_eq!(resolve_hotkey(stored, "Alt+Shift+T"), "Ctrl+Alt+K");
    }

    #[test]
    fn an_explicitly_empty_config_disables_the_hotkey() {
        // 用户把快捷键清空 = 想禁用。这是修复的关键点：
        // 旧实现里非空默认值会覆盖掉这个 ""，
        // 导致「剪贴板翻译」清空后下次启动又被 Alt+Shift+T 顶回来，
        // 界面显示为空却实际生效，且无法关闭。
        let stored = Some(String::new());
        assert_eq!(
            resolve_hotkey(stored, "Alt+Shift+T"),
            "",
            "an empty stored value must disable the shortcut, not be overridden by the default"
        );
    }

    #[test]
    fn the_default_applies_only_on_first_run() {
        assert_eq!(resolve_hotkey(None, "Alt+Shift+T"), "Alt+Shift+T");
        assert_eq!(resolve_hotkey(None, ""), "");
    }

    #[test]
    fn default_never_overrides_regardless_of_its_value() {
        // 无论默认值多「像」用户会想要的键，都不能越过 config
        for default in ["Alt+T", "Alt+Shift+T", "", "Ctrl+Q"] {
            assert_eq!(resolve_hotkey(Some("F9".into()), default), "F9");
        }
    }

    /// 所有可配置的快捷键名。`register_shortcut`、`register_shortcut_by_frontend`
    /// 与 `handler_factory` 三处必须同时覆盖这些名字。
    const HOTKEY_NAMES: [&str; 5] = [
        "hotkey_selection_translate",
        "hotkey_clipboard_translate",
        "hotkey_input_translate",
        "hotkey_ocr_recognize",
        "hotkey_ocr_translate",
    ];

    #[test]
    fn every_hotkey_name_can_be_restored_after_a_failed_rebind() {
        // 回滚依赖 handler_factory 能找到处理函数。漏掉某个名字时，
        // 该键在「新键被占用」的失败路径下无法恢复旧绑定，
        // 用户会静默丢掉一个快捷键，且只留一条 warning 日志。
        for name in HOTKEY_NAMES {
            assert!(
                handler_factory(name).is_some(),
                "{name} must have a handler so a failed rebind can be rolled back"
            );
        }
        assert!(handler_factory("not_a_hotkey").is_none());
    }
}

#[tauri::command]
pub fn accessibility_permission(request: bool) -> bool {
    #[cfg(target_os = "macos")]
    {
        if request && !macos_accessibility_client::accessibility::application_is_trusted() {
            return macos_accessibility_client::accessibility::application_is_trusted_with_prompt();
        }
        return macos_accessibility_client::accessibility::application_is_trusted();
    }
    #[cfg(not(target_os = "macos"))]
    { let _ = request; true }
}

// The bundled tao 0.16 backend discards Carbon registration errors. Probe first
// so occupied keys cannot be falsely reported as saved. The old binding remains.
#[cfg(target_os = "macos")]
fn probe_macos_shortcut(shortcut: &str) -> Result<(), String> {
    use std::ffi::c_void;
    #[repr(C)]
    struct HotKeyId { signature: u32, id: u32 }
    #[link(name = "Carbon", kind = "framework")]
    extern "C" {
        fn GetApplicationEventTarget() -> *mut c_void;
        fn RegisterEventHotKey(key: u32, modifiers: u32, id: HotKeyId, target: *mut c_void, options: u32, reference: *mut *mut c_void) -> i32;
        fn UnregisterEventHotKey(reference: *mut c_void) -> i32;
    }
    let mut modifiers = 0;
    let mut key = None;
    for part in shortcut.split('+') {
        match part.to_ascii_lowercase().as_str() {
            "ctrl" | "control" => modifiers |= 4096,
            "shift" => modifiers |= 512,
            "alt" | "option" => modifiers |= 2048,
            "command" | "cmd" | "super" | "meta" | "commandorcontrol" | "cmdorctrl" => modifiers |= 256,
            value => key = macos_keycode(value),
        }
    }
    let key = key.ok_or("Unsupported shortcut key; choose a letter, digit, function key or navigation key")?;
    unsafe {
        let mut reference = std::ptr::null_mut();
        let status = RegisterEventHotKey(key, modifiers, HotKeyId { signature: u32::from_be_bytes(*b"cupP"), id: 1 }, GetApplicationEventTarget(), 0, &mut reference);
        if status != 0 { return Err(format!("Shortcut unavailable or occupied (macOS status {status})")); }
        if !reference.is_null() { UnregisterEventHotKey(reference); }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn macos_keycode(key: &str) -> Option<u32> {
    let keys = ["a","s","d","f","h","g","z","x","c","v","§","b","q","w","e","r","y","t","1","2","3","4","6","5","=","9","7","-","8","0",
        "]","o","u","[","i","p","enter","l","j","'","k",";","\\",",","/","n","m",".","tab","space","`","backspace"];
    if let Some(index) = keys.iter().position(|value| *value == key) { return Some(index as u32); }
    match key {
        "esc" | "escape" => Some(53), "delete" => Some(117),
        "left" => Some(123), "right" => Some(124), "down" => Some(125), "up" => Some(126),
        "home" => Some(115), "end" => Some(119), "pageup" => Some(116), "pagedown" => Some(121),
        "f1" => Some(122), "f2" => Some(120), "f3" => Some(99), "f4" => Some(118), "f5" => Some(96), "f6" => Some(97), "f7" => Some(98), "f8" => Some(100), "f9" => Some(101), "f10" => Some(109), "f11" => Some(103), "f12" => Some(111),
        _ => None,
    }
}

#[cfg(all(test, target_os = "macos"))]
mod macos_probe_tests {
    #[test]
    fn carbon_probe_detects_an_occupied_hotkey() {
        use std::ffi::c_void;
        #[repr(C)]
        struct Id { signature: u32, id: u32 }
        #[link(name = "Carbon", kind = "framework")]
        extern "C" {
            fn GetApplicationEventTarget() -> *mut c_void;
            fn RegisterEventHotKey(key: u32, modifiers: u32, id: Id, target: *mut c_void, options: u32, reference: *mut *mut c_void) -> i32;
            fn UnregisterEventHotKey(reference: *mut c_void) -> i32;
        }
        unsafe {
            let mut reference = std::ptr::null_mut();
            let status = RegisterEventHotKey(111, 4096 | 512 | 2048, Id {signature: u32::from_be_bytes(*b"cupT"), id: 99}, GetApplicationEventTarget(), 0, &mut reference);
            let probe = super::probe_macos_shortcut("Ctrl+Shift+Alt+F12");
            if status == 0 && !reference.is_null() { UnregisterEventHotKey(reference); }
            assert!(probe.is_err(), "occupied shortcut must not be accepted");
        }
    }

    #[test]
    fn keycodes_match_apple_virtual_keys() {
        assert_eq!(super::macos_keycode("t"), Some(17));
        assert_eq!(super::macos_keycode("space"), Some(49));
        assert_eq!(super::macos_keycode("enter"), Some(36));
        assert_eq!(super::macos_keycode("f12"), Some(111));
        assert_eq!(super::macos_keycode("unknown"), None);
    }
}
