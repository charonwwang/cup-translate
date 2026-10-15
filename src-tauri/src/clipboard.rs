use crate::window::text_translate;
use std::sync::Mutex;
use tauri::{ClipboardManager, Manager};

pub struct ClipboardMonitorEnableWrapper(pub Mutex<String>);

pub fn start_clipboard_monitor(app_handle: tauri::AppHandle) {
    // 这是 500ms 轮询的阻塞型循环，用普通线程而非 async 任务：
    // async 任务里调用 std::thread::sleep 会阻塞 tokio 工作线程，
    // 多次开关剪贴板监控会耗尽 async runtime 线程池。
    std::thread::spawn(move || {
        let mut pre_text = "".to_string();
        loop {
            let handle = app_handle.app_handle();
            let state = handle.state::<ClipboardMonitorEnableWrapper>();
            if let Ok(clipboard_monitor) = state.0.try_lock() {
                if clipboard_monitor.contains("true") {
                    if let Ok(Some(v)) = app_handle.clipboard_manager().read_text() {
                        if v != pre_text {
                            text_translate(v.clone());
                            pre_text = v;
                        }
                    }
                } else {
                    break;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
    });
}
