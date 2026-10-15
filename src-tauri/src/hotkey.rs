use crate::config::{get_str, set};
use crate::window::{clipboard_translate, input_translate, ocr_recognize, ocr_translate, selection_translate};
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
        warn!("Failed to unregister previous shortcut {} for {}: {:?}", previous, name, e);
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
fn register<F>(app_handle: &AppHandle, name: &str, handler: F, key: &str) -> Result<(), String>
where
    F: Fn() + Send + 'static,
{
    let stored = get_str(name);
    let is_first_run = stored.is_none();
    let hotkey = resolve_hotkey(stored, key);
    if is_first_run {
        // 落地默认值，避免「界面显示为空、实际却已绑定」
        set(name, hotkey.clone());
    }

    // 改键场景：先解绑该配置键的旧绑定，否则旧快捷键会一直生效。
    // 记下解绑掉的值，一旦新键注册失败就把它装回去——
    // 否则用户会「旧键没了、新键也没生效」，等于凭空丢了一个快捷键
    // （新键被别的功能或别的程序占用时很容易触发）。
    let previous = unregister_previous(app_handle, name);

    if hotkey.is_empty() {
        return Ok(());
    }

    match app_handle
        .global_shortcut_manager()
        .register(hotkey.as_str(), handler)
    {
        Ok(()) => {
            set_registered_accelerator(name, Some(hotkey.clone()));
            info!("Registered global shortcut: {} for {}", hotkey, name);
        }
        Err(e) => {
            warn!("Failed to register global shortcut: {} for {} {:?}", hotkey, name, e);
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
            "",
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
            register(
                app_handle,
                "hotkey_selection_translate",
                selection_translate,
                "",
            )?;
            register(
                app_handle,
                "hotkey_clipboard_translate",
                clipboard_translate,
                "Alt+Shift+T",
            )?;
            register(app_handle, "hotkey_input_translate", input_translate, "")?;
            register(app_handle, "hotkey_ocr_recognize", ocr_recognize, "")?;
            register(app_handle, "hotkey_ocr_translate", ocr_translate, "")?;
        }
        _ => {}
    }
    Ok(())
}

#[tauri::command]
pub fn register_shortcut_by_frontend(name: &str, shortcut: &str) -> Result<(), String> {
    let app_handle = APP.get().ok_or("App is not initialized")?;
    match name {
        "hotkey_selection_translate" => register(
            app_handle,
            "hotkey_selection_translate",
            selection_translate,
            shortcut,
        )?,
        "hotkey_clipboard_translate" => register(
            app_handle,
            "hotkey_clipboard_translate",
            clipboard_translate,
            shortcut,
        )?,
        "hotkey_input_translate" => register(
            app_handle,
            "hotkey_input_translate",
            input_translate,
            shortcut,
        )?,
        "hotkey_ocr_recognize" => {
            register(app_handle, "hotkey_ocr_recognize", ocr_recognize, shortcut)?
        }
        "hotkey_ocr_translate" => {
            register(app_handle, "hotkey_ocr_translate", ocr_translate, shortcut)?
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{handler_factory, resolve_hotkey};

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
