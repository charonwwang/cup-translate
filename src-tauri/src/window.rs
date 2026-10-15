#[cfg(target_os = "macos")]
use std::fs;

use crate::config::get_i64;
use crate::config::get_str;
use crate::config::set;
use crate::StringWrapper;
use crate::APP;
#[cfg(target_os = "macos")]
use dirs::cache_dir;
use log::{info, warn};
use tauri::Manager;
use tauri::Monitor;
use tauri::Window;
use tauri::WindowBuilder;
#[cfg(any(target_os = "macos", target_os = "windows"))]
use window_shadows::set_shadow;

// Get daemon window instance. Returns None when AppHandle is not yet initialized
// (should not happen after setup) instead of panicking.
fn get_daemon_window() -> Option<Window> {
    let app_handle = APP.get()?;
    match app_handle.get_window("daemon") {
        Some(v) => Some(v),
        None => {
            warn!("Daemon window not found, create new daemon window!");
            match WindowBuilder::new(
                app_handle,
                "daemon",
                tauri::WindowUrl::App("daemon.html".into()),
            )
            .title("Daemon")
            .visible(false)
            .build()
            {
                Ok(v) => Some(v),
                Err(e) => {
                    warn!("Failed to create daemon window: {e:?}");
                    None
                }
            }
        }
    }
}

// Get monitor where the mouse is currently located.
// Returns None when no monitor can be resolved (e.g. hot-plug races, headless
// display edge cases) instead of panicking the whole app.
fn get_current_monitor(x: i32, y: i32) -> Option<Monitor> {
    info!("Mouse position: {}, {}", x, y);
    let daemon_window = get_daemon_window()?;
    let monitors = match daemon_window.available_monitors() {
        Ok(v) => v,
        Err(e) => {
            warn!("available_monitors failed: {e:?}, falling back to primary");
            Vec::new()
        }
    };

    for m in monitors {
        let size = m.size();
        let position = m.position();

        if x >= position.x
            && x <= (position.x + size.width as i32)
            && y >= position.y
            && y <= (position.y + size.height as i32)
        {
            info!("Current Monitor: {:?}", m);
            return Some(m);
        }
    }
    warn!("Current Monitor not found, using primary monitor");
    daemon_window.primary_monitor().ok().flatten()
}

/// 解析当前窗口所在显示器；无可用显示器时退回 DPI=1.0 的逻辑尺寸估算，
/// 避免 monitor 查询失败直接 panic。
fn window_monitor_or_default(window: &tauri::Window) -> Option<Monitor> {
    window.current_monitor().ok().flatten()
}

/// 无可用显示器时的保守 DPI（逻辑坐标即物理坐标）
const FALLBACK_DPI: f64 = 1.0;

/// 安全写入 StringWrapper 状态；AppHandle 未初始化或锁中毒时记录警告而非 panic。
fn set_text_state(text: &str) {
    let Some(app_handle) = APP.get() else {
        warn!("set_text_state: app not initialized, dropping text state");
        return;
    };
    let state: tauri::State<StringWrapper> = app_handle.state();
    let lock_result = state.0.lock();
    match lock_result {
        Ok(mut guard) => {
            guard.replace_range(.., text);
        }
        Err(_) => warn!("set_text_state: string state mutex poisoned, dropping text state"),
    }
}

// Creating a window on the mouse monitor
fn build_window(label: &str, title: &str) -> (Window, bool) {
    use mouse_position::mouse_position::{Mouse, Position};

    let mouse_position = match Mouse::get_mouse_position() {
        Mouse::Position { x, y } => Position { x, y },
        Mouse::Error => {
            warn!("Mouse position not found, using (0, 0) as default");
            Position { x: 0, y: 0 }
        }
    };
    // 解析不到显示器（多屏热插拔竞态等）时退回 (0,0)，不 panic
    let position = get_current_monitor(mouse_position.x, mouse_position.y)
        .map(|m| *m.position())
        .unwrap_or(tauri::PhysicalPosition { x: 0, y: 0 });

    let Some(app_handle) = APP.get() else {
        // AppHandle 未初始化时无法创建窗口，返回 daemon 窗口兜底（不会发生于 setup 后）
        warn!("build_window({label}): app not initialized, returning daemon fallback");
        return (get_daemon_window().expect("daemon window unavailable"), true);
    };
    match app_handle.get_window(label) {
        Some(v) => {
            info!("Window existence: {}", label);
            if let Err(e) = v.set_focus() {
                warn!("Failed to focus window {label}: {e:?}");
            }
            (v, true)
        }
        None => {
            info!("Window not existence, Creating new window: {}", label);
            let mut builder = tauri::WindowBuilder::new(
                app_handle,
                label,
                tauri::WindowUrl::App("index.html".into()),
            )
            .position(position.x.into(), position.y.into())
            .focused(true)
            .title(title)
            .visible(false);

            #[cfg(target_os = "macos")]
            {
                builder = builder
                    .title_bar_style(tauri::TitleBarStyle::Overlay)
                    .hidden_title(true);
            }
            #[cfg(not(target_os = "macos"))]
            {
                builder = builder.transparent(true).decorations(false);
            }
            let window = match builder.build() {
                Ok(v) => v,
                Err(e) => {
                    warn!("Failed to build window {label}: {e:?}, returning daemon fallback");
                    return (get_daemon_window().expect("daemon window unavailable"), true);
                }
            };

            if label != "screenshot" {
                #[cfg(not(target_os = "linux"))]
                set_shadow(&window, true).unwrap_or_default();
            }
            let _ = window.current_monitor();
            (window, false)
        }
    }
}

pub fn config_window() {
    let (window, _exists) = build_window("config", "Config");
    if let Err(e) = window.set_min_size(Some(tauri::LogicalSize::new(800, 400))) {
        warn!("Failed to set config window min size: {e:?}");
    }
    if let Err(e) = window.set_size(tauri::LogicalSize::new(800, 600)) {
        warn!("Failed to set config window size: {e:?}");
    }
    if let Err(e) = window.center() {
        warn!("Failed to center config window: {e:?}");
    }
}

fn translate_window() -> Window {
    use mouse_position::mouse_position::{Mouse, Position};
    // Mouse physical position
    let mut mouse_position = match Mouse::get_mouse_position() {
        Mouse::Position { x, y } => Position { x, y },
        Mouse::Error => {
            warn!("Mouse position not found, using (0, 0) as default");
            Position { x: 0, y: 0 }
        }
    };
    let (window, exists) = build_window("translate", "Translate");
    if exists {
        return window;
    }
    if let Err(e) = window.set_skip_taskbar(true) {
        warn!("Failed to set translate window skip_taskbar: {e:?}");
    }
    // Get Translate Window Size
    let width = match get_i64("translate_window_width") {
        Some(v) => v,
        None => {
            set("translate_window_width", 350);
            350
        }
    };
    let height = match get_i64("translate_window_height") {
        Some(v) => v,
        None => {
            set("translate_window_height", 420);
            420
        }
    };

    let monitor = window_monitor_or_default(&window);
    let dpi = monitor.as_ref().map_or(FALLBACK_DPI, |m| m.scale_factor());

    let _ = window.set_size(tauri::PhysicalSize::new(
        (width as f64) * dpi,
        (height as f64) * dpi,
    ));

    let position_type = get_str("translate_window_position").unwrap_or_else(|| "mouse".to_string());

    match (position_type.as_str(), monitor) {
        ("mouse", Some(monitor)) => {
            // Adjust window position
            let monitor_size = monitor.size();
            let monitor_size_width = monitor_size.width as f64;
            let monitor_size_height = monitor_size.height as f64;
            let monitor_position = monitor.position();
            let monitor_position_x = monitor_position.x as f64;
            let monitor_position_y = monitor_position.y as f64;

            if mouse_position.x as f64 + width as f64 * dpi
                > monitor_position_x + monitor_size_width
            {
                mouse_position.x -= (width as f64 * dpi) as i32;
                if (mouse_position.x as f64) < monitor_position_x {
                    mouse_position.x = monitor_position_x as i32;
                }
            }
            if mouse_position.y as f64 + height as f64 * dpi
                > monitor_position_y + monitor_size_height
            {
                mouse_position.y -= (height as f64 * dpi) as i32;
                if (mouse_position.y as f64) < monitor_position_y {
                    mouse_position.y = monitor_position_y as i32;
                }
            }

            if let Err(e) =
                window.set_position(tauri::PhysicalPosition::new(mouse_position.x, mouse_position.y))
            {
                warn!("Failed to set translate window position: {e:?}");
            }
        }
        _ => {
            let position_x = get_i64("translate_window_position_x").unwrap_or_default();
            let position_y = get_i64("translate_window_position_y").unwrap_or_default();
            let _ = window.set_position(tauri::PhysicalPosition::new(
                (position_x as f64) * dpi,
                (position_y as f64) * dpi,
            ));
        }
    }

    window
}

/// 用 CGEvent 模拟 Cmd+C（不需要 Automation 权限，只需 Accessibility）
#[cfg(target_os = "macos")]
fn simulate_copy_with_cg_event() {
    use core_graphics::event::{CGEvent, CGEventTapLocation, CGKeyCode};
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
    let source =
        CGEventSource::new(CGEventSourceStateID::HIDSystemState).expect("create event source");
    // Cmd down
    let cmd_key: CGKeyCode = 0x37; // kVK_Command
    let key_down = CGEvent::new_keyboard_event(source.clone(), cmd_key, true).expect("create key down");
    key_down.set_flags(core_graphics::event::CGEventFlags::CGEventFlagCommand);
    key_down.post(CGEventTapLocation::HID);
    // C key down + up
    let c_key: CGKeyCode = 0x08; // kVK_ANSI_C
    let c_down = CGEvent::new_keyboard_event(source.clone(), c_key, true).expect("create c down");
    c_down.set_flags(core_graphics::event::CGEventFlags::CGEventFlagCommand);
    c_down.post(CGEventTapLocation::HID);
    let c_up = CGEvent::new_keyboard_event(source.clone(), c_key, false).expect("create c up");
    c_up.post(CGEventTapLocation::HID);
    // Cmd up
    let cmd_up = CGEvent::new_keyboard_event(source, cmd_key, false).expect("create cmd up");
    cmd_up.post(CGEventTapLocation::HID);
    // 等待剪贴板更新
    std::thread::sleep(std::time::Duration::from_millis(80));
}

pub fn selection_translate() {
    use selection::get_text;
    // 短暂延迟让 AX API 有时间注册选区（快捷键触发瞬间选区可能还未就绪）
    std::thread::sleep(std::time::Duration::from_millis(50));
    // Get Selected Text via AX API
    let mut text = get_text();
    // 重试一次：首次可能因时序问题读不到
    if text.trim().is_empty() {
        std::thread::sleep(std::time::Duration::from_millis(100));
        text = get_text();
    }

    // 兜底 1：用 CGEvent 模拟 Cmd+C（不需要 Automation 权限）
    if text.trim().is_empty() {
        info!("selection_translate: trying CGEvent Cmd+C fallback");
        #[cfg(target_os = "macos")]
        simulate_copy_with_cg_event();
        std::thread::sleep(std::time::Duration::from_millis(100));
        if let Ok(mut clipboard) = arboard::Clipboard::new() {
            if let Ok(clip_text) = clipboard.get_text() {
                if !clip_text.trim().is_empty() {
                    info!("selection_translate: got text via CGEvent copy");
                    text = clip_text;
                }
            }
        }
    }

    // 兜底 2：直接读剪贴板内容（用户已复制文本时）
    if text.trim().is_empty() {
        if let Ok(mut clipboard) = arboard::Clipboard::new() {
            if let Ok(clip_text) = clipboard.get_text() {
                if !clip_text.trim().is_empty() {
                    info!("selection_translate: fallback to clipboard content");
                    text = clip_text;
                }
            }
        }
    }

    if text.trim().is_empty() {
        // Do not replace the previous translation or flash an empty window when
        // the hotkey is pressed without an active selection.
        warn!("selection_translate: no text selected and clipboard is empty");
        // 提示用户：macOS 可能阻止了 AppleScript 模拟按键，需要授权
        let app_handle = APP.get();
        if let Some(handle) = app_handle {
            let identifier = handle.config().tauri.bundle.identifier.clone();
            let _ = tauri::api::notification::Notification::new(&identifier)
                .title("划词翻译")
                .body("未获取到选中文本。请先选中文字再按快捷键，或复制文字后按快捷键翻译。若持续失败，请在 系统设置→隐私与安全→自动化 中允许本应用控制「系统事件」。")
                .show();
        }
        return;
    }

    // Write into State
    set_text_state(&text);

    let window = translate_window();
    if let Err(error) = window.emit("new_text", text) {
        log::warn!(
            "Failed to send selected text to translation window: {}",
            error
        );
    }
}

pub fn input_translate() {
    // Clear State
    set_text_state("[INPUT_TRANSLATE]");
    let window = translate_window();
    let position_type = get_str("translate_window_position").unwrap_or_else(|| "mouse".to_string());
    if position_type == "mouse" {
        if let Err(e) = window.center() {
            warn!("Failed to center input_translate window: {e:?}");
        }
    }

    if let Err(e) = window.emit("new_text", "[INPUT_TRANSLATE]") {
        warn!("Failed to emit new_text to input_translate window: {e:?}");
    }
}

pub fn text_translate(text: String) {
    // Clear State
    set_text_state(&text);
    let window = translate_window();
    if let Err(e) = window.emit("new_text", text) {
        warn!("Failed to emit new_text to translate window: {e:?}");
    }
}

pub fn image_translate() {
    set_text_state("[IMAGE_TRANSLATE]");
    let window = translate_window();
    if let Err(e) = window.emit("new_text", "[IMAGE_TRANSLATE]") {
        warn!("Failed to emit new_text to image_translate window: {e:?}");
    }
}

pub fn recognize_window() {
    let (window, exists) = build_window("recognize", "Recognize");
    if exists {
        if let Err(e) = window.emit("new_image", "") {
            warn!("Failed to emit new_image to recognize window: {e:?}");
        }
        return;
    }
    let width = match get_i64("recognize_window_width") {
        Some(v) => v,
        None => {
            set("recognize_window_width", 800);
            800
        }
    };
    let height = match get_i64("recognize_window_height") {
        Some(v) => v,
        None => {
            set("recognize_window_height", 400);
            400
        }
    };
    let monitor = window_monitor_or_default(&window);
    let dpi = monitor.as_ref().map_or(FALLBACK_DPI, |m| m.scale_factor());
    let _ = window.set_size(tauri::PhysicalSize::new(
        (width as f64) * dpi,
        (height as f64) * dpi,
    ));
    let _ = window.center();
    let _ = window.emit("new_image", "");
}

#[cfg(not(target_os = "macos"))]
fn screenshot_window() -> Window {
    let (window, _exists) = build_window("screenshot", "Screenshot");

    if let Err(e) = window.set_skip_taskbar(true) {
        warn!("Failed to set screenshot window skip_taskbar: {e:?}");
    }
    #[cfg(target_os = "macos")]
    {
        if let Some(monitor) = window_monitor_or_default(&window) {
            let size = monitor.size();
            let _ = window.set_decorations(false);
            let _ = window.set_size(*size);
        } else {
            warn!("No monitor for screenshot window, keeping default size");
        }
    }

    #[cfg(not(target_os = "macos"))]
    if let Err(e) = window.set_fullscreen(true) {
        warn!("Failed to set screenshot window fullscreen: {e:?}");
    }

    if let Err(e) = window.set_always_on_top(true) {
        warn!("Failed to set screenshot window always_on_top: {e:?}");
    }
    window
}

pub fn ocr_recognize() {
    #[cfg(target_os = "macos")]
    {
        let Some(app_handle) = APP.get() else {
            warn!("ocr_recognize: app not initialized, skipping");
            return;
        };
        let Some(mut app_cache_dir_path) = cache_dir() else {
            warn!("ocr_recognize: cannot resolve cache dir, skipping");
            return;
        };
        app_cache_dir_path.push(&app_handle.config().tauri.bundle.identifier);
        if !app_cache_dir_path.exists() {
            // 创建目录
            if let Err(e) = fs::create_dir_all(&app_cache_dir_path) {
                warn!("ocr_recognize: cannot create cache dir: {e:?}, skipping");
                return;
            }
        }
        app_cache_dir_path.push("pot_screenshot_cut.png");

        let path = app_cache_dir_path.to_string_lossy().replace("\\\\?\\", "");
        println!("Screenshot path: {}", path);
        if let Ok(_output) = std::process::Command::new("/usr/sbin/screencapture")
            .arg("-i")
            .arg("-r")
            .arg(path)
            .output()
        {
            recognize_window();
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let window = screenshot_window();
        let window_ = window.clone();
        window.listen("success", move |event| {
            recognize_window();
            window_.unlisten(event.id())
        });
    }
}
pub fn ocr_translate() {
    #[cfg(target_os = "macos")]
    {
        let Some(app_handle) = APP.get() else {
            warn!("ocr_translate: app not initialized, skipping");
            return;
        };
        let Some(mut app_cache_dir_path) = cache_dir() else {
            warn!("ocr_translate: cannot resolve cache dir, skipping");
            return;
        };
        app_cache_dir_path.push(&app_handle.config().tauri.bundle.identifier);
        if !app_cache_dir_path.exists() {
            // 创建目录
            if let Err(e) = fs::create_dir_all(&app_cache_dir_path) {
                warn!("ocr_translate: cannot create cache dir: {e:?}, skipping");
                return;
            }
        }
        app_cache_dir_path.push("pot_screenshot_cut.png");

        let path = app_cache_dir_path.to_string_lossy().replace("\\\\?\\", "");
        println!("Screenshot path: {}", path);
        if let Ok(_output) = std::process::Command::new("/usr/sbin/screencapture")
            .arg("-i")
            .arg("-r")
            .arg(path)
            .output()
        {
            image_translate();
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let window = screenshot_window();
        let window_ = window.clone();
        window.listen("success", move |event| {
            image_translate();
            window_.unlisten(event.id())
        });
    }
}

#[tauri::command(async)]
pub fn updater_window() {
    let (window, _exists) = build_window("updater", "Updater");
    if let Err(e) = window.set_min_size(Some(tauri::LogicalSize::new(600, 400))) {
        warn!("Failed to set updater window min size: {e:?}");
    }
    if let Err(e) = window.set_size(tauri::LogicalSize::new(600, 400)) {
        warn!("Failed to set updater window size: {e:?}");
    }
    if let Err(e) = window.center() {
        warn!("Failed to center updater window: {e:?}");
    }
}
