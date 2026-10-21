use log::info;

#[tauri::command]
pub fn screenshot(x: i32, y: i32) -> Result<(), String> {
    use crate::APP;
    use dirs::cache_dir;
    use screenshots::{Compression, Screen};
    use std::fs;
    info!("Screenshot screen with position: x={}, y={}", x, y);
    let screens = Screen::all().map_err(|error| error.to_string())?;
    // 记下枚举到的显示器：前端用 Tauri 的 currentMonitor() 取坐标，
    // 后端用 screenshots crate 的 Screen::all() 枚举，两者是**不同的库**。
    // 正常情况下都报告显示器左上角坐标、能对上；一旦对不上（例如某个库在
    // HiDPI 下返回逻辑坐标而非物理坐标），用户只会看到「截图失败」，
    // 无从判断是坐标不一致还是真的没有显示器。把实际枚举结果一并带出，
    // 让这个跨库契约在出问题时可以被诊断——不改变任何行为。
    let mut found: Vec<(i32, i32)> = Vec::with_capacity(screens.len());
    for screen in screens {
        let info = screen.display_info;
        info!("Screen: {:?}", info);
        found.push((info.x, info.y));
        if info.x == x && info.y == y {
            let handle = APP.get().ok_or("Application is not initialized")?;
            let mut app_cache_dir_path = cache_dir().ok_or("Get Cache Dir Failed")?;
            app_cache_dir_path.push(&handle.config().tauri.bundle.identifier);
            fs::create_dir_all(&app_cache_dir_path).map_err(|error| error.to_string())?;
            app_cache_dir_path.push("pot_screenshot.png");

            let image = screen.capture().map_err(|error| error.to_string())?;
            let buffer = image
                .to_png(Compression::Fast)
                .map_err(|error| error.to_string())?;
            fs::write(app_cache_dir_path, buffer).map_err(|error| error.to_string())?;
            return Ok(());
        }
    }
    // 附带实际枚举到的显示器坐标与数量，便于区分「坐标不一致」与「真没有显示器」。
    Err(no_screen_message(x, y, &found))
}

/// 构造「找不到显示器」的错误信息。
///
/// 单独抽成函数是为了能直接测：这条信息是跨库契约（前端 Tauri 的
/// currentMonitor() vs 后端 screenshots 的 Screen::all()）出错时**唯一**的线索，
/// 必须同时包含请求坐标、枚举数量与实际枚举到的坐标，缺一不可。
fn no_screen_message(x: i32, y: i32, found: &[(i32, i32)]) -> String {
    format!(
        "No screen found at position ({x}, {y}); enumerated {} screen(s) at {found:?}",
        found.len()
    )
}

#[cfg(test)]
mod tests {
    use super::no_screen_message;

    #[test]
    fn no_screen_error_reports_requested_and_enumerated_positions() {
        // 没有枚举到任何显示器
        let none = no_screen_message(0, 0, &[]);
        assert!(
            none.contains("(0, 0)"),
            "must state the requested position: {none}"
        );
        assert!(
            none.contains("0 screen"),
            "must state how many were enumerated: {none}"
        );

        // 枚举到了显示器但坐标不匹配（典型的跨库坐标不一致）
        let mismatch = no_screen_message(1920, 0, &[(0, 0), (1920, 1080)]);
        assert!(
            mismatch.contains("(1920, 0)"),
            "must state the requested position: {mismatch}"
        );
        assert!(
            mismatch.contains("2 screen"),
            "must state the count: {mismatch}"
        );
        // 实际枚举到的坐标必须出现，否则无法判断是不是坐标对不上
        assert!(
            mismatch.contains("(0, 0)"),
            "must list enumerated positions: {mismatch}"
        );
        assert!(
            mismatch.contains("(1920, 1080)"),
            "must list enumerated positions: {mismatch}"
        );

        // 负坐标（副屏在主屏左侧）也要如实反映
        let negative = no_screen_message(-1920, 0, &[(-1920, 0)]);
        assert!(
            negative.contains("(-1920, 0)"),
            "must handle negative coordinates: {negative}"
        );
    }
}
