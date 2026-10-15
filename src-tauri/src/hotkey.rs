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

/// 解绑某个配置键此前注册的快捷键（若有）。
fn unregister_previous(app_handle: &AppHandle, name: &str) {
    let Some(previous) = registered_accelerator(name) else {
        return;
    };
    set_registered_accelerator(name, None);
    if previous.is_empty() {
        return;
    }
    if let Err(e) = app_handle
        .global_shortcut_manager()
        .unregister(previous.as_str())
    {
        // 旧绑定可能已被系统或其他模块释放，记日志但不阻断新键注册
        warn!("Failed to unregister previous shortcut {} for {}: {:?}", previous, name, e);
    } else {
        info!("Unregistered previous shortcut: {} for {}", previous, name);
    }
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

fn register<F>(app_handle: &AppHandle, name: &str, handler: F, key: &str) -> Result<(), String>
where
    F: Fn() + Send + 'static,
{
    let hotkey = {
        if key.is_empty() {
            match get_str(name) {
                Some(v) => v,
                None => {
                    set(name, "");
                    String::new()
                }
            }
        } else {
            key.to_string()
        }
    };

    // 改键场景：先解绑该配置键的旧绑定，否则旧快捷键会一直生效
    unregister_previous(app_handle, name);

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
            return Err(e.to_string());
        }
    };
    Ok(())
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
