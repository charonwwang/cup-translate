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
    let cmd_key: CGKeyCode = 0x37;
    let key_down = CGEvent::new_keyboard_event(source.clone(), cmd_key, true).expect("create key down");
    key_down.set_flags(core_graphics::event::CGEventFlags::CGEventFlagCommand);
    key_down.post(CGEventTapLocation::HID);
    let c_key: CGKeyCode = 0x08;
    let c_down = CGEvent::new_keyboard_event(source.clone(), c_key, true).expect("create c down");
    c_down.set_flags(core_graphics::event::CGEventFlags::CGEventFlagCommand);
    c_down.post(CGEventTapLocation::HID);
    let c_up = CGEvent::new_keyboard_event(source.clone(), c_key, false).expect("create c up");
    c_up.post(CGEventTapLocation::HID);
    let cmd_up = CGEvent::new_keyboard_event(source, cmd_key, false).expect("create cmd up");
    cmd_up.post(CGEventTapLocation::HID);
    std::thread::sleep(std::time::Duration::from_millis(80));
}

/// 兜底取词：模拟 Cmd+C 把选区写进剪贴板，读出后**把剪贴板还原如初**。
///
/// 为什么必须还原：模拟 Cmd+C 会覆盖用户剪贴板。用户只是想划词翻译，
/// 却发现自己原先复制的内容被换成了刚划中的文字——属于静默的数据丢失。
///
/// 还原语义（见 [`restore_action`]）：
/// - 原本有文本 -> 写回原文本；
/// - 原本没有文本（空剪贴板 / 只有图片或文件）-> **清空**剪贴板。
///   修复前这两种「无文本」的情况会被 `.filter(|s| !s.is_empty())` 归成 None，
///   于是跳过还原，选区文字被留在剪贴板里；
///   即「划词翻译凭空往剪贴板塞了一段文本」，正是本函数要消除的副作用。
///
/// 返回取到的选区文本；没取到则返回 None（此时同样会还原剪贴板）。
#[cfg(target_os = "macos")]
fn copy_selection_via_cgevent() -> Option<String> {
    let mut clipboard = arboard::Clipboard::new().ok();

    // 区分「原本就没有文本」与「压根读不到剪贴板」：
    // 前者要清空还原，后者无从还原（保持现状，不做破坏性操作）。
    let saved: Option<Option<String>> = clipboard
        .as_mut()
        .map(|c| c.get_text().ok())
        .map(|maybe_text| maybe_text.filter(|s| !s.is_empty()));

    simulate_copy_with_cg_event();
    std::thread::sleep(std::time::Duration::from_millis(100));

    let mut selection: Option<String> = None;
    if let Some(c) = clipboard.as_mut() {
        if let Ok(clip_text) = c.get_text() {
            if !clip_text.trim().is_empty() {
                info!("selection_translate: got text via CGEvent copy");
                selection = Some(clip_text);
            }
        }
    }

    if let (Some(c), Some(saved)) = (clipboard.as_mut(), saved) {
        // saved: Option<String>；包装成 Option<Option<&str>> 以保留三层语义
        match restore_action(Some(saved.as_deref())) {
            RestoreAction::SetText(text) => match c.set_text(text) {
                Ok(()) => info!("selection_translate: clipboard text restored"),
                Err(e) => warn!("selection_translate: failed to restore clipboard: {e:?}"),
            },
            RestoreAction::Clear => match c.clear() {
                Ok(()) => info!("selection_translate: clipboard cleared back to its original empty state"),
                Err(e) => warn!("selection_translate: failed to clear clipboard: {e:?}"),
            },
            RestoreAction::Nothing => {}
        }
    }

    selection
}

/// 还原剪贴板时该做什么。抽成纯函数以便单测（无需真实剪贴板）。
///
/// 参数是备份的**三层**结果，不能提前压平：
/// - `None`：压根读不到剪贴板 -> 不做破坏性操作
/// - `Some(None)`：读到了但没有文本（空 / 只有图片或文件）-> 清空
/// - `Some(Some(text))`：原本就有文本 -> 写回
///
/// 注意别把参数写成 `Option<Option<String>>` 再 `as_deref()`：
/// 那会把 `Some(None)` 与 `None` 合并成同一个 `None`，
/// 使「原本为空」这条路径退化成「不还原」，修复就白做了。
#[cfg(target_os = "macos")]
#[derive(Debug, PartialEq, Eq)]
enum RestoreAction<'a> {
    /// 把原文本写回去
    SetText(&'a str),
    /// 原本没有文本，清空剪贴板
    Clear,
    /// 原本读不到剪贴板，不做任何破坏性操作
    Nothing,
}

/// 依据备份结果决定还原动作。`saved` 的三层语义见 [`RestoreAction`] 的文档。
#[cfg(target_os = "macos")]
fn restore_action(saved: Option<Option<&str>>) -> RestoreAction<'_> {
    match saved {
        Some(Some(text)) if !text.is_empty() => RestoreAction::SetText(text),
        // 备份成功但内容为空：必须清空，否则选区文字会残留在剪贴板里
        Some(Some(_)) | Some(None) => RestoreAction::Clear,
        None => RestoreAction::Nothing,
    }
}

/// 划词翻译：读取当前选中文本并翻译（不含剪贴板兜底）
pub fn selection_translate() {
    use selection::get_text;
    // 短暂延迟让 AX API 有时间注册选区
    std::thread::sleep(std::time::Duration::from_millis(50));
    let mut text = get_text();
    // 重试一次：首次可能因时序问题读不到
    if text.trim().is_empty() {
        std::thread::sleep(std::time::Duration::from_millis(100));
        text = get_text();
    }

    // 兜底：用 CGEvent 模拟 Cmd+C 获取选中文本（不需要 Automation 权限）
    if text.trim().is_empty() {
        info!("selection_translate: trying CGEvent Cmd+C fallback");
        if let Some(clip_text) = copy_selection_via_cgevent() {
            text = clip_text;
        }
    }

    if text.trim().is_empty() {
        warn!("selection_translate: no text selected");
        let app_handle = APP.get();
        if let Some(handle) = app_handle {
            let identifier = handle.config().tauri.bundle.identifier.clone();
            let _ = tauri::api::notification::Notification::new(&identifier)
                .title("划词翻译")
                .body("未获取到选中文本。请先选中文字再按快捷键。若持续失败，请在 系统设置→隐私与安全→自动化 中允许本应用控制「系统事件」。")
                .show();
        }
        return;
    }

    set_text_state(&text);
    let window = translate_window();
    if let Err(error) = window.emit("new_text", text) {
        log::warn!("Failed to send selected text to translation window: {}", error);
    }
}

/// 剪贴板翻译：读取剪贴板内容并翻译（独立于划词翻译）
pub fn clipboard_translate() {
    let text = if let Ok(mut clipboard) = arboard::Clipboard::new() {
        clipboard.get_text().unwrap_or_default()
    } else {
        String::new()
    };

    if text.trim().is_empty() {
        warn!("clipboard_translate: clipboard is empty");
        let app_handle = APP.get();
        if let Some(handle) = app_handle {
            let identifier = handle.config().tauri.bundle.identifier.clone();
            let _ = tauri::api::notification::Notification::new(&identifier)
                .title("剪贴板翻译")
                .body("剪贴板为空。请先复制文本（Cmd+C）再按快捷键。")
                .show();
        }
        return;
    }

    set_text_state(&text);
    let window = translate_window();
    if let Err(error) = window.emit("new_text", text) {
        log::warn!("Failed to send clipboard text to translation window: {}", error);
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

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::{restore_action, RestoreAction};

    #[test]
    fn saved_text_is_written_back() {
        assert_eq!(
            restore_action(Some(Some("user clipboard"))),
            RestoreAction::SetText("user clipboard")
        );
    }

    #[test]
    fn an_originally_empty_clipboard_is_cleared_not_left_dirty() {
        // 核心用例：备份成功但内容为空（空剪贴板 / 只有图片或文件）时，
        // 必须清空剪贴板。修复前这种情况被归成「无需还原」，
        // 于是 CGEvent 复制进来的选区文字被留在剪贴板里——
        // 用户只是划词翻译，剪贴板却凭空多出一段文本。
        assert_eq!(restore_action(Some(None)), RestoreAction::Clear);
    }

    #[test]
    fn an_empty_string_is_treated_as_no_text() {
        // get_text() 可能返回空串而非 None，语义同样是「原本没有文本」
        assert_eq!(restore_action(Some(Some(""))), RestoreAction::Clear);
    }

    #[test]
    fn an_unreadable_clipboard_is_left_alone() {
        // 读不到剪贴板时无从还原，不能做破坏性操作（清空可能毁掉用户的图片剪贴板）
        assert_eq!(restore_action(None), RestoreAction::Nothing);
    }

    #[test]
    fn the_three_backup_outcomes_stay_distinguishable() {
        // 回归护栏：若将来又引入 as_deref() 之类的压平，
        // Some(None) 会与 None 合并，这条会立刻失败。
        assert_ne!(restore_action(Some(None)), restore_action(None));
    }
}
