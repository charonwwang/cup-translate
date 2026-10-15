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

// Get daemon window instance
fn get_daemon_window() -> Window {
    let app_handle = APP.get().unwrap();
    match app_handle.get_window("daemon") {
        Some(v) => v,
        None => {
            warn!("Daemon window not found, create new daemon window!");
            WindowBuilder::new(
                app_handle,
                "daemon",
                tauri::WindowUrl::App("daemon.html".into()),
            )
            .title("Daemon")
            .visible(false)
            .build()
            .unwrap()
        }
    }
}

// Get monitor where the mouse is currently located.
// Returns None when no monitor can be resolved (e.g. hot-plug races, headless
// display edge cases) instead of panicking the whole app.
fn get_current_monitor(x: i32, y: i32) -> Option<Monitor> {
    info!("Mouse position: {}, {}", x, y);
    let daemon_window = get_daemon_window();
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

    let app_handle = APP.get().unwrap();
    match app_handle.get_window(label) {
        Some(v) => {
            info!("Window existence: {}", label);
            v.set_focus().unwrap();
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
            let window = builder.build().unwrap();

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
    window
        .set_min_size(Some(tauri::LogicalSize::new(800, 400)))
        .unwrap();
    window.set_size(tauri::LogicalSize::new(800, 600)).unwrap();
    window.center().unwrap();
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
    window.set_skip_taskbar(true).unwrap();
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

            window
                .set_position(tauri::PhysicalPosition::new(
                    mouse_position.x,
                    mouse_position.y,
                ))
                .unwrap();
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

pub fn selection_translate() {
    use selection::get_text;
    // Get Selected Text
    let text = get_text();
    if text.trim().is_empty() {
        // Do not replace the previous translation or flash an empty window when
        // the hotkey is pressed without an active selection.
        return;
    }

    let app_handle = APP.get().unwrap();
    // Write into State
    let state: tauri::State<StringWrapper> = app_handle.state();
    state.0.lock().unwrap().replace_range(.., &text);

    let window = translate_window();
    if let Err(error) = window.emit("new_text", text) {
        log::warn!(
            "Failed to send selected text to translation window: {}",
            error
        );
    }
}

pub fn input_translate() {
    let app_handle = APP.get().unwrap();
    // Clear State
    let state: tauri::State<StringWrapper> = app_handle.state();
    state
        .0
        .lock()
        .unwrap()
        .replace_range(.., "[INPUT_TRANSLATE]");
    let window = translate_window();
    let position_type = match get_str("translate_window_position") {
        Some(v) => v,
        None => "mouse".to_string(),
    };
    if position_type == "mouse" {
        window.center().unwrap();
    }

    window.emit("new_text", "[INPUT_TRANSLATE]").unwrap();
}

pub fn text_translate(text: String) {
    let app_handle = APP.get().unwrap();
    // Clear State
    let state: tauri::State<StringWrapper> = app_handle.state();
    state.0.lock().unwrap().replace_range(.., &text);
    let window = translate_window();
    window.emit("new_text", text).unwrap();
}

pub fn image_translate() {
    let app_handle = APP.get().unwrap();
    let state: tauri::State<StringWrapper> = app_handle.state();
    state
        .0
        .lock()
        .unwrap()
        .replace_range(.., "[IMAGE_TRANSLATE]");
    let window = translate_window();
    window.emit("new_text", "[IMAGE_TRANSLATE]").unwrap();
}

pub fn recognize_window() {
    let (window, exists) = build_window("recognize", "Recognize");
    if exists {
        window.emit("new_image", "").unwrap();
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

    window.set_skip_taskbar(true).unwrap();
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
    window.set_fullscreen(true).unwrap();

    window.set_always_on_top(true).unwrap();
    window
}

pub fn ocr_recognize() {
    #[cfg(target_os = "macos")]
    {
        let app_handle = APP.get().unwrap();
        let mut app_cache_dir_path = cache_dir().expect("Get Cache Dir Failed");
        app_cache_dir_path.push(&app_handle.config().tauri.bundle.identifier);
        if !app_cache_dir_path.exists() {
            // 创建目录
            fs::create_dir_all(&app_cache_dir_path).expect("Create Cache Dir Failed");
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
        let app_handle = APP.get().unwrap();
        let mut app_cache_dir_path = cache_dir().expect("Get Cache Dir Failed");
        app_cache_dir_path.push(&app_handle.config().tauri.bundle.identifier);
        if !app_cache_dir_path.exists() {
            // 创建目录
            fs::create_dir_all(&app_cache_dir_path).expect("Create Cache Dir Failed");
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
    window
        .set_min_size(Some(tauri::LogicalSize::new(600, 400)))
        .unwrap();
    window.set_size(tauri::LogicalSize::new(600, 400)).unwrap();
    window.center().unwrap();
}
