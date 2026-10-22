// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backup;
mod backup_path;
mod clipboard;
mod cmd;
mod config;
mod credentials;
mod error;
mod hotkey;
#[cfg(any(target_arch = "x86_64", all(target_arch = "aarch64", not(windows))))]
mod hy_mt;
mod kokoro;
mod lang_detect;
#[cfg(any(target_arch = "x86_64", all(target_arch = "aarch64", not(windows))))]
mod local_mt;
#[cfg(not(any(target_arch = "x86_64", all(target_arch = "aarch64", not(windows)))))]
#[path = "local_mt_unsupported.rs"]
mod local_mt;
mod local_mt_tasks;
mod model_checks;
mod notification;
#[cfg(any(
    all(target_os = "macos", target_arch = "aarch64"),
    all(
        target_os = "linux",
        any(target_arch = "x86_64", target_arch = "aarch64")
    ),
    all(windows, target_arch = "x86_64")
))]
mod piper;
#[cfg(not(any(
    all(target_os = "macos", target_arch = "aarch64"),
    all(
        target_os = "linux",
        any(target_arch = "x86_64", target_arch = "aarch64")
    ),
    all(windows, target_arch = "x86_64")
)))]
#[path = "piper_unsupported.rs"]
mod piper;
mod qwen_tts;
mod screenshot;
mod server;
mod system_ocr;
mod tray;
mod tts;
mod updater;
mod window;

use backup::*;
use clipboard::*;
use cmd::*;
use config::*;
use credentials::*;
use hotkey::*;
use kokoro::*;
use lang_detect::*;
use local_mt::*;
use local_mt_tasks::{local_mt_cancel_request, local_mt_prepare_request};
use log::{info, warn, LevelFilter};
use once_cell::sync::OnceCell;
use piper::*;
use model_checks::*;
use qwen_tts::*;
use screenshot::screenshot;
use server::*;
use std::sync::Mutex;
use system_ocr::*;
use tauri::api::notification::Notification;
use tauri::Manager;
use tauri_plugin_log::LogTarget;
use tray::*;
use tts::*;
use updater::check_update;
use window::config_window;
use window::updater_window;

// Global AppHandle
pub static APP: OnceCell<tauri::AppHandle> = OnceCell::new();

// Text to be translated
pub struct StringWrapper(pub Mutex<String>);

/// 决定本次启动使用的语言检测引擎，并把 `bing` 迁移掉。
///
/// 抽成纯函数是为了可单测：这段逻辑**决定要不要调用 `init_lang_detect()`**，
/// 判错会让本地检测在首次使用时才加载模型（用户可感知的卡顿），
/// 而且它会**真的改写用户配置**（`set`），与 `config.rs::should_keep_instance`
/// 属于同一类「改错就等于静默改用户数据」的逻辑，值得有测试守着。
///
/// 规则：
/// - `Some("bing")` -> `"local"`（该引擎已删除，见 `main` 中的说明）
/// - `Some(其它字符串)` -> 原样返回（尊重用户选择）
/// - `Some(非字符串)` -> `"local"`（类型异常，退回默认）
/// - `None`（键不存在）-> `"local"`
fn resolve_detect_engine(stored: Option<serde_json::Value>) -> String {
    match stored {
        Some(engine) => match engine.as_str() {
            // 已删除的检测引擎：迁移到 local
            Some("bing") => "local".to_string(),
            Some(other) => other.to_string(),
            // 非字符串（null / 数字 / 对象）：退回默认，不 panic
            None => "local".to_string(),
        },
        None => "local".to_string(),
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, cwd| {
            // 文案按 app_language 本地化（见 notification.rs）。
            // body 仍用 cwd：那是本次尝试的启动路径，属于诊断信息，不需要翻译。
            let text = notification::text(notification::NotificationKind::AlreadyRunning);
            if let Err(e) = Notification::new(&app.config().tauri.bundle.identifier)
                .title(text.title)
                .body(cwd)
                .icon("cup-translate")
                .show()
            {
                warn!("Failed to show already-running notification: {e:?}");
            }
        }))
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(LevelFilter::Info)
                .targets([LogTarget::LogDir, LogTarget::Stdout])
                .build(),
        )
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_fs_watch::init())
        .system_tray(tauri::SystemTray::new())
        .setup(|app| {
            info!("============== Start App ==============");
            #[cfg(target_os = "macos")]
            {
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
                let trusted = macos_accessibility_client::accessibility::application_is_trusted();
                info!("MacOS Accessibility Trusted: {}", trusted);
            }
            // Global AppHandle
            APP.get_or_init(|| app.handle());
            // Init Config
            info!("Init Config Store");
            init_config(app);
            // Check First Run
            if is_first_run() {
                // Open Config Window
                info!("First Run, opening config window");
                config_window();
            }
            app.manage(StringWrapper(Mutex::new("".to_string())));
            // Update Tray Menu
            update_tray(app.app_handle(), "".to_string(), "".to_string());
            // Start http server
            start_server();
            // Register Global Shortcut
            match register_shortcut("all") {
                Ok(()) => {}
                Err(e) => {
                    // 同上：标题本地化，body 保留原始错误（诊断信息）。
                    let text =
                        notification::text(notification::NotificationKind::HotkeyRegisterFailed);
                    if let Err(ne) = Notification::new(app.config().tauri.bundle.identifier.clone())
                        .title(text.title)
                        .body(&e)
                        .icon("cup-translate")
                        .show()
                    {
                        warn!("Failed to show shortcut registration notification: {ne:?}");
                    }
                }
            }
            if get("proxy_enable").and_then(|value| value.as_bool()) == Some(true)
                && set_proxy().is_err()
            {
                warn!("Proxy configuration is invalid; proxy was not enabled");
            }
            // Check Update
            check_update(app.handle());
            // 语言检测默认走本地（lingua），与前端默认值保持一致：
            // 键缺失时写入默认值并初始化，切换到 local 时同样需要初始化
            //
            // 老配置里可能残留 `bing`：该检测引擎已删除（取 token 的端点实测 404，
            // 与被删除的 translate/bing 同一端点，且失败时静默返回 'en'）。
            // 迁移到 `local` 而不是放任它落到前端的 default 分支 —— 两者结果相同，
            // 但在这里改掉能让配置本身自洽，用户下次打开设置页看到的就是实际生效值。
            let detect_engine = resolve_detect_engine(get("translate_detect_engine"));
            // 把迁移后的值落盘，让配置自洽（用户下次打开设置页看到的就是实际生效值）。
            // 只在「读取到的值与生效值不同」时写，避免每次启动都无谓改写配置文件。
            if get("translate_detect_engine")
                .as_ref()
                .and_then(|v| v.as_str())
                != Some(detect_engine.as_str())
            {
                set("translate_detect_engine", &detect_engine);
            }
            if detect_engine == "local" {
                std::thread::spawn(init_lang_detect);
            }
            let clipboard_monitor = match get_bool("clipboard_monitor") {
                Some(v) => v,
                None => {
                    set("clipboard_monitor", false);
                    false
                }
            };
            app.manage(ClipboardMonitorEnableWrapper(Mutex::new(
                clipboard_monitor.to_string(),
            )));
            start_clipboard_monitor(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            reload_store,
            get_text,
            cut_image,
            get_base64,
            copy_img,
            system_ocr,
            set_proxy,
            unset_proxy,
            run_binary,
            open_devtools,
            register_shortcut_by_frontend,
            accessibility_permission,
            update_tray,
            updater_window,
            screenshot,
            lang_detect,
            webdav,
            local,
            install_plugin,
            font_list,
            aliyun,
            local_mt_model_status,
            local_mt_install_control,
            local_mt_device_check,
            kokoro_model_status,
            kokoro_download,
            kokoro_cancel,
            kokoro_uninstall,
            kokoro_speak,
            kokoro_preview,
            piper_catalog,
            piper_download,
            piper_cancel,
            piper_uninstall,
            piper_speak,
            piper_preview,
            tts_inventory,
            qwen_tts_request,
            native_speech_device_check,
            qwen_device_check,
            qwen_install,
            qwen_cancel,
            qwen_status,
            qwen_stop,
            local_mt_download_model,
            local_mt_import_model,
            local_mt_delete_model,
            local_mt_unload_model,
            local_mt_translate,
            local_mt_prepare_request,
            local_mt_cancel_request,
            tts_speak,
            seal_service_config,
            read_service_secret,
            save_config_atomic
        ])
        .on_system_tray_event(tray_event_handler)
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        // 窗口关闭不退出
        .run(|_app_handle, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                api.prevent_exit();
            }
        });
}

#[cfg(test)]
mod resolve_detect_engine_tests {
    use super::resolve_detect_engine;
    use serde_json::json;

    /// 已删除的引擎必须被迁移到 local —— 否则它会落到前端的 default 分支，
    /// 虽然结果相同，但配置里留着一个不存在的引擎名会让设置页显示错值。
    #[test]
    fn removed_bing_engine_migrates_to_local() {
        assert_eq!(resolve_detect_engine(Some(json!("bing"))), "local");
    }

    /// 仍需尊重用户对**其它**引擎的选择，不能借迁移之名一律改成 local。
    #[test]
    fn other_engines_are_preserved_verbatim() {
        for engine in ["baidu", "google", "tencent", "niutrans", "yandex", "local"] {
            assert_eq!(
                resolve_detect_engine(Some(json!(engine))),
                engine,
                "`{engine}` must be preserved"
            );
        }
    }

    /// `yandex` 虽在部分地区返回 403，但那是地区封锁、端点仍存在，
    /// **不能**与 bing 同处置（这是本轮特意区分的一点）。
    #[test]
    fn yandex_is_not_treated_as_removed() {
        assert_eq!(resolve_detect_engine(Some(json!("yandex"))), "yandex");
    }

    /// 键缺失 -> 默认 local（与前端 `?? 'local'` 一致）。
    #[test]
    fn missing_key_defaults_to_local() {
        assert_eq!(resolve_detect_engine(None), "local");
    }

    /// 类型异常（null / 数字 / 对象 / 数组）不能让启动 panic，退回默认。
    #[test]
    fn non_string_values_fall_back_to_local() {
        for value in [json!(null), json!(42), json!({}), json!(["local"])] {
            assert_eq!(
                resolve_detect_engine(Some(value.clone())),
                "local",
                "non-string value {value} must fall back to local"
            );
        }
    }

    /// 空字符串是**有效**的 serde 字符串，会原样返回；
    /// 这里记录该行为，避免将来误以为它会被当作缺失处理。
    #[test]
    fn empty_string_is_returned_as_is_and_is_not_a_valid_engine() {
        assert_eq!(resolve_detect_engine(Some(json!(""))), "");
    }
}
