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

/// 判断点 (x, y) 是否落在某个显示器的矩形内。
///
/// 显示器覆盖的是**半开区间** `[position, position + size)`：
/// 宽 1920、起点 0 的屏幕占用像素 0..=1919，像素 1920 属于右边那块屏。
/// 因此右边界必须用 `<` 而不是 `<=`。
///
/// 修复前用的是 `x <= position.x + size.width`，会把**下一块屏幕的第一个像素**
/// 也算进当前屏幕。左右并排双屏时，鼠标停在这条共用边界上
/// （例如左屏 `x=0,w=1920`、右屏 `x=1920`，鼠标 `x=1920`）
/// 会因遍历顺序先命中左屏，于是翻译窗口显示在左屏右缘，而不是鼠标所在的右屏。
///
/// 用 i64 做加法：`position.x + size.width` 在 i32 下可能回绕
/// （release 静默、debug panic）。现实中多屏坐标远达不到 i32 上限，
/// 但用 i64 可让回绕在结构上不可能发生，代价为零。
fn point_in_monitor(x: i32, y: i32, position_x: i32, position_y: i32, width: u32, height: u32) -> bool {
    let left = position_x as i64;
    let top = position_y as i64;
    let right = left + width as i64;
    let bottom = top + height as i64;
    let px = x as i64;
    let py = y as i64;

    px >= left && px < right && py >= top && py < bottom
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

        if point_in_monitor(x, y, position.x, position.y, size.width, size.height) {
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
            // 文案按 app_language 本地化：修复前这里永远发中文，
            // 把界面切成英文的用户会收到看不懂的通知（见 notification.rs）。
            let text = crate::notification::text(crate::notification::NotificationKind::SelectionTranslateEmpty);
            let _ = tauri::api::notification::Notification::new(&identifier)
                .title(text.title)
                .body(text.body)
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
            let text = crate::notification::text(crate::notification::NotificationKind::ClipboardTranslateEmpty);
            let _ = tauri::api::notification::Notification::new(&identifier)
                .title(text.title)
                .body(text.body)
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

/// macOS 专用：调用 `/usr/sbin/screencapture` 抓图，并**如实报告成败**。
///
/// 修复前的写法是 `if let Ok(_output) = Command::new(...).output() { ... }`，
/// 它只判断「进程是否被成功创建并运行完毕」，**完全不看退出码**——
/// 与 `tts.rs` 那个 `is_ok()` 是同一类错误（`Ok` 与退出码无关）。
///
/// 实测（本机 macOS，`screencapture -x /tmp/probe.png`）：
///   · 截图失败时退出码为 **1**，stderr 为 `could not create image from display`
///     （屏幕录制权限未授予时就会这样）；
///   · 失败时**不创建**目标文件；
///   · 更关键：若目标路径**已存在**（上一次成功截图的产物），
///     失败时该文件**原样保留**，内容一字未改（实测把 12 字节的
///     `old-content` 放进去，失败后读回来仍是 `old-content`）。
///
/// 于是旧代码的后果是：截图失败 -> 仍然调用 `recognize_window()` /
/// `image_translate()` -> 前端读到的还是**上一张截图**，
/// 用户看到的是与本次操作无关的识别结果，且没有任何错误提示。
///
/// 因此这里做两件事：
///   1. 抓图**前**先删掉目标文件，消除「旧图冒充新图」的可能；
///   2. 抓图**后**检查退出码，失败就返回 false，由调用方放弃后续流程。
///
/// **可达性诚实说明**：我实测到的是「screencapture 在失败时返回 1 且保留旧文件」
/// 这一**行为事实**；我没有在真实 GUI 会话里走完「用户选中截图 -> 识别出旧图」
/// 的全流程（需要屏幕录制权限与真人交互）。「用户按 Esc 取消」这一常见情形
/// 同样无法在本环境复现（`-i` 会阻塞等待交互）。
/// 删除可能残留的旧截图，避免「旧图冒充新图」。
///
/// 抽成独立函数是为了**可测**：`macos_capture_screenshot` 本身要求真实
/// `screencapture` 与交互式 GUI 会话，无法在单测里跑；而「先删旧文件」
/// 这一步恰好是修复的核心，且完全可以在测试里用临时文件验证。
///
/// 文件本来就不存在（首次截图）不算错误，静默通过。
fn remove_stale_screenshot(path: &str) -> std::io::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

fn macos_capture_screenshot(path: &str) -> bool {
    if let Err(e) = remove_stale_screenshot(path) {
        warn!("capture: cannot remove the stale screenshot: {e:?}");
    }

    match std::process::Command::new("/usr/sbin/screencapture")
        .arg("-i")
        .arg("-r")
        .arg(path)
        .output()
    {
        Ok(output) if output.status.success() => true,
        Ok(output) => {
            warn!(
                "capture: screencapture exited with {:?}, skipping recognition (stderr: {})",
                output.status.code(),
                String::from_utf8_lossy(&output.stderr).trim()
            );
            false
        }
        Err(e) => {
            warn!("capture: cannot run screencapture: {e:?}, skipping recognition");
            false
        }
    }
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
        if macos_capture_screenshot(&path) {
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
        if macos_capture_screenshot(&path) {
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
    use super::{point_in_monitor, remove_stale_screenshot, restore_action, RestoreAction};

    // 左右并排双屏：左屏起点 0、宽 1920；右屏起点 1920、宽 1920
    const LEFT_X: i32 = 0;
    const RIGHT_X: i32 = 1920;
    const W: u32 = 1920;
    const H: u32 = 1080;

    #[test]
    fn a_point_well_inside_a_monitor_belongs_to_it() {
        assert!(point_in_monitor(500, 500, LEFT_X, 0, W, H));
        assert!(point_in_monitor(2500, 500, RIGHT_X, 0, W, H));
    }

    #[test]
    fn the_last_pixel_of_a_monitor_still_belongs_to_it() {
        // 宽 1920 覆盖 0..=1919，所以 1919 属于左屏
        assert!(point_in_monitor(1919, 1079, LEFT_X, 0, W, H));
    }

    #[test]
    fn the_shared_border_pixel_belongs_to_the_right_monitor_only() {
        // 核心用例：x=1920 是右屏的第一个像素。
        // 修复前用 `x <= position.x + size.width`，左屏判定区间成了 [0, 1920]，
        // 会把这一像素**也**算作左屏的；遍历顺序下先命中左屏，
        // 于是翻译窗口弹在左屏右缘，而不是鼠标真正所在的右屏。
        assert!(
            !point_in_monitor(1920, 500, LEFT_X, 0, W, H),
            "x=1920 is the first pixel of the right monitor, not inside the left one"
        );
        assert!(
            point_in_monitor(1920, 500, RIGHT_X, 0, W, H),
            "x=1920 must belong to the right monitor"
        );
    }

    #[test]
    fn a_left_edge_border_pixel_does_not_leak_into_the_monitor_on_its_left() {
        // 对称检查：右屏起点 1920，那么 1919（左屏最后一个像素）不属于右屏
        assert!(!point_in_monitor(1919, 500, RIGHT_X, 0, W, H));
    }

    #[test]
    fn monitors_above_or_left_of_the_origin_still_work() {
        // 副屏常在原点左上（负坐标），半开区间的负值一侧同样要正确。
        // 这块屏起点 -1920、宽 1920，覆盖 [-1920, 0)。
        assert!(point_in_monitor(-500, -500, -1920, -1080, W, H));
        assert!(point_in_monitor(-1920, -1080, -1920, -1080, W, H), "top-left corner is inside");
        assert!(point_in_monitor(-1, -500, -1920, -1080, W, H), "last column before 0 is inside");
        // 右/下边界是开的：x=0 属于原点那块屏，不属于这块
        assert!(!point_in_monitor(0, -500, -1920, -1080, W, H));
        assert!(!point_in_monitor(-1, 0, -1920, -1080, W, H));
        // 左侧越界
        assert!(!point_in_monitor(-1921, -500, -1920, -1080, W, H));
    }

    #[test]
    fn large_coordinates_do_not_overflow() {
        // i32 下的 `position.x + width` 会回绕；改成 i64 后必须仍然正确。
        // 取起点接近 i32 上限的显示器：left + width 会超过 i32::MAX。
        let left = i32::MAX - 100;
        assert!(point_in_monitor(i32::MAX, 0, left, 0, 200, 100));
        // i32::MAX 之后的坐标在 i32 里不存在，用 MAX 本身验证仍属该屏
        assert!(!point_in_monitor(left - 1, 0, left, 0, 200, 100));
    }

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

    /// 截图失败时 `screencapture` **不会**删除已存在的目标文件 ——
    /// 实测：把一个 12 字节的旧文件放在目标路径，抓图失败后读回来内容不变。
    /// 而旧代码只看 `Ok(_output)`（忽略退出码），失败后**照样**进入识别流程，
    /// 前端读到的就是这张旧图（`pot_screenshot_cut.png` 被
    /// cmd.rs::get_base64 与各 recognize 服务共同读取）。
    /// 因此抓图前必须先把旧文件清掉。
    #[test]
    fn stale_screenshot_is_removed_before_capturing() {
        let dir = std::env::temp_dir().join("cup-translate-test-stale-shot");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("pot_screenshot_cut.png");
        let path_str = path.to_string_lossy().to_string();

        // 1) 预置一张「旧图」
        std::fs::write(&path, b"old-content").expect("write fixture");
        assert!(path.exists(), "precondition: the stale file must exist");

        // 2) 清理（模拟抓图前的那一步）
        remove_stale_screenshot(&path_str).expect("removing a stale file must succeed");

        // 3) 旧图必须没了，否则识别流程会读到它
        assert!(
            !path.exists(),
            "the stale screenshot must be gone, otherwise it can be mistaken for this capture"
        );

        // 4) 再次调用（文件已不存在）必须仍然是 Ok —— 首次截图就是这种情况，
        //    不能因为「没有旧文件可删」就报错或放弃截图。
        remove_stale_screenshot(&path_str).expect("a missing file is not an error");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 删除失败（这里是权限问题）必须**冒泡为 Err**，由调用方记日志；
    /// 不能被静默吞掉，否则「旧图还在」这件事无人知晓。
    #[test]
    fn a_real_removal_failure_is_reported_not_swallowed() {
        let dir = std::env::temp_dir().join("cup-translate-test-undeletable");
        let _ = std::fs::create_dir_all(&dir);
        // 目录本身无法用 remove_file 删掉 -> 得到一个真实的非 NotFound 错误
        let path_str = dir.to_string_lossy().to_string();
        let result = remove_stale_screenshot(&path_str);
        assert!(
            result.is_err(),
            "removing a non-empty directory must surface an error, got {result:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
