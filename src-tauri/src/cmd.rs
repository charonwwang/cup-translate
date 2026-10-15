use crate::config::get;
use crate::config::StoreWrapper;
use crate::error::Error;
use crate::StringWrapper;
use crate::APP;
use log::{error, info};
use serde_json::{json, Value};
use std::io::Read;
use tauri::Manager;

const PLUGIN_TYPES: &[&str] = &["recognize", "translate", "tts", "collection"];

/// info.json 解压大小上限，防止恶意 .potext 用 zip 炸弹撑爆内存
const MAX_PLUGIN_INFO_BYTES: u64 = 64 * 1024;

/// 纯函数：检查 zip 条目是否为符号链接（用于单元测试，不依赖全局状态）
fn is_symlink_entry(unix_mode: Option<u32>) -> bool {
    unix_mode.is_some_and(|mode| mode & 0o170000 == 0o120000)
}

fn valid_plugin_type(value: &str) -> bool {
    PLUGIN_TYPES.contains(&value)
}

fn valid_plugin_name(value: &str) -> bool {
    value.starts_with("plugin")
        && !value.is_empty()
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
}

fn crop_in_bounds(
    left: u32,
    top: u32,
    width: u32,
    height: u32,
    image_width: u32,
    image_height: u32,
) -> bool {
    width > 0
        && height > 0
        && left
            .checked_add(width)
            .is_some_and(|right| right <= image_width)
        && top
            .checked_add(height)
            .is_some_and(|bottom| bottom <= image_height)
}

#[tauri::command]
pub fn get_text(state: tauri::State<StringWrapper>) -> String {
    match state.0.lock() {
        Ok(guard) => guard.to_string(),
        Err(_) => {
            log::warn!("get_text: string state mutex poisoned, returning empty");
            String::new()
        }
    }
}

#[tauri::command]
pub fn reload_store() {
    let Some(app_handle) = APP.get() else {
        log::warn!("reload_store: app not initialized, skipping");
        return;
    };
    let state = app_handle.state::<StoreWrapper>();
    let load_result = match state.0.lock() {
        Ok(mut store) => store.load(),
        Err(_) => {
            log::warn!("reload_store: store mutex poisoned, skipping");
            return;
        }
    };
    if let Err(e) = load_result {
        log::warn!("reload_store: failed to reload store: {e:?}");
    }
}

#[tauri::command]
pub fn cut_image(
    left: u32,
    top: u32,
    width: u32,
    height: u32,
    app_handle: tauri::AppHandle,
) -> Result<(), Error> {
    use dirs::cache_dir;
    info!("Cut image: {}x{}+{}+{}", width, height, left, top);
    let mut app_cache_dir_path =
        cache_dir().ok_or_else(|| Error::Error("Get Cache Dir Failed".into()))?;
    app_cache_dir_path.push(&app_handle.config().tauri.bundle.identifier);
    app_cache_dir_path.push("pot_screenshot.png");
    let img = image::open(&app_cache_dir_path)?;
    if !crop_in_bounds(left, top, width, height, img.width(), img.height()) {
        return Err(Error::Error(
            "Screenshot crop is outside image bounds".into(),
        ));
    }
    let img2 = img.crop_imm(left, top, width, height);
    app_cache_dir_path.pop();
    app_cache_dir_path.push("pot_screenshot_cut.png");
    img2.save(&app_cache_dir_path)?;
    Ok(())
}

#[tauri::command]
pub fn get_base64(app_handle: tauri::AppHandle) -> String {
    use base64::{engine::general_purpose, Engine as _};
    use dirs::cache_dir;
    use std::fs::File;
    use std::io::Read;
    let Some(mut app_cache_dir_path) = cache_dir() else {
        error!("Get Cache Dir Failed");
        return String::new();
    };
    app_cache_dir_path.push(&app_handle.config().tauri.bundle.identifier);
    app_cache_dir_path.push("pot_screenshot_cut.png");
    if !app_cache_dir_path.exists() {
        return "".to_string();
    }
    let mut file = match File::open(app_cache_dir_path) {
        Ok(file) => file,
        Err(error) => {
            error!("Failed to open cropped screenshot: {}", error);
            return String::new();
        }
    };
    let mut vec = Vec::new();
    match file.read_to_end(&mut vec) {
        Ok(_) => {}
        Err(e) => {
            error!("{:?}", e.to_string());
            return "".to_string();
        }
    }
    let base64 = general_purpose::STANDARD.encode(&vec);
    base64.replace("\r\n", "")
}

#[tauri::command]
pub fn copy_img(app_handle: tauri::AppHandle, width: usize, height: usize) -> Result<(), Error> {
    use arboard::{Clipboard, ImageData};
    use dirs::cache_dir;
    use image::ImageReader;
    use std::borrow::Cow;

    let mut app_cache_dir_path =
        cache_dir().ok_or_else(|| Error::Error("Get Cache Dir Failed".into()))?;
    app_cache_dir_path.push(&app_handle.config().tauri.bundle.identifier);
    app_cache_dir_path.push("pot_screenshot_cut.png");
    let data = ImageReader::open(app_cache_dir_path)?.decode()?;
    if (width, height) != (data.width() as usize, data.height() as usize) {
        return Err(Error::Error(
            "Screenshot dimensions changed before copying".into(),
        ));
    }
    let rgba = data.to_rgba8().into_raw();

    let img = ImageData {
        width,
        height,
        bytes: Cow::from(rgba),
    };
    Clipboard::new()?.set_image(img)?;
    Ok(())
}

#[tauri::command]
pub fn set_proxy() -> Result<bool, ()> {
    let host = get("proxy_host")
        .and_then(|value| value.as_str().map(str::to_owned))
        .filter(|value| !value.is_empty())
        .ok_or(())?;
    let port = get("proxy_port")
        .and_then(|value| value.as_u64())
        .and_then(|value| u16::try_from(value).ok())
        .filter(|value| *value != 0)
        .ok_or(())?;
    let no_proxy = get("no_proxy")
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_default();
    let proxy = format!("http://{}:{}", host, port);

    std::env::set_var("http_proxy", &proxy);
    std::env::set_var("https_proxy", &proxy);
    std::env::set_var("all_proxy", &proxy);
    std::env::set_var("no_proxy", &no_proxy);
    Ok(true)
}

#[tauri::command]
pub fn unset_proxy() -> Result<bool, ()> {
    std::env::remove_var("http_proxy");
    std::env::remove_var("https_proxy");
    std::env::remove_var("all_proxy");
    std::env::remove_var("no_proxy");
    Ok(true)
}

#[tauri::command]
pub fn install_plugin(path_list: Vec<String>) -> Result<i32, Error> {
    let mut success_count = 0;

    for path in path_list {
        let path = std::path::Path::new(&path);
        if path.extension().and_then(|extension| extension.to_str()) != Some("potext") {
            continue;
        }
        let file_name = path
            .file_stem()
            .and_then(|name| name.to_str())
            .ok_or_else(|| Error::Error("Invalid Plugin: invalid file name".into()))?;
        if !valid_plugin_name(file_name) {
            return Err(Error::Error(
                "Invalid Plugin: file name must start with plugin and contain only letters, numbers, '-' or '_'"
                    .into(),
            ));
        }

        let mut zip = zip::ZipArchive::new(std::fs::File::open(path)?)?;
        // 拒绝符号链接条目：zip.extract 在 Unix 上会照常创建 symlink，
        // 恶意 .potext 可借此指向任意系统文件（restore_archive 已做同样校验，
        // install_plugin 此前漏掉，见 cmd.rs tests::plugin_archive_rejects_symlink_entries）。
        for index in 0..zip.len() {
            let entry = zip.by_index(index)?;
            if is_symlink_entry(entry.unix_mode()) {
                return Err(Error::Error("Invalid Plugin: contains a symbolic link".into()));
            }
        }
        #[allow(unused_mut)]
        let mut plugin_type: String;
        if let Ok(info) = zip.by_name("info.json") {
            let mut content = String::new();
            // 限制 info.json 大小，防止 zip 炸弹
            info.take(MAX_PLUGIN_INFO_BYTES).read_to_string(&mut content)?;
            let json: serde_json::Value = serde_json::from_str(&content)?;
            plugin_type = json["plugin_type"]
                .as_str()
                .ok_or(Error::Error("can't find plugin type in info.json".into()))?
                .to_string();
        } else {
            return Err(Error::Error("Invalid Plugin: miss info.json".into()));
        }
        if zip.by_name("main.js").is_err() {
            return Err(Error::Error("Invalid Plugin: miss main.js".into()));
        }
        if !valid_plugin_type(&plugin_type) {
            return Err(Error::Error(
                "Invalid Plugin: unsupported plugin type".into(),
            ));
        }
        let config_path = dirs::config_dir()
            .ok_or_else(|| Error::Error("Get Config Dir Error".into()))?;
        let app_handle = APP
            .get()
            .ok_or_else(|| Error::Error("App is not initialized".into()))?;
        let config_path =
            config_path.join(app_handle.config().tauri.bundle.identifier.clone());
        let config_path = config_path.join("plugins");
        let config_path = config_path.join(plugin_type);
        let plugin_path = config_path.join(file_name);
        std::fs::create_dir_all(&config_path)?;
        zip.extract(&plugin_path)?;

        success_count += 1;
    }
    Ok(success_count)
}

#[tauri::command]
pub fn run_binary(
    plugin_type: String,
    plugin_name: String,
    cmd_name: String,
    args: Vec<String>,
) -> Result<Value, Error> {
    #[cfg(target_os = "windows")]
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    if !valid_plugin_type(&plugin_type) || !valid_plugin_name(&plugin_name) {
        return Err(Error::Error("Invalid plugin path".into()));
    }

    let config_path =
        dirs::config_dir().ok_or_else(|| Error::Error("Get Config Dir Error".into()))?;
    let app_handle = APP
        .get()
        .ok_or_else(|| Error::Error("App is not initialized".into()))?;
    let config_path = config_path.join(app_handle.config().tauri.bundle.identifier.clone());
    let config_path = config_path.join("plugins");
    let config_path = config_path.join(plugin_type);
    let plugin_path = config_path.join(plugin_name);

    #[cfg(target_os = "windows")]
    let mut cmd = Command::new(&cmd_name);
    #[cfg(target_os = "windows")]
    let cmd = cmd.creation_flags(0x08000000);
    #[cfg(not(target_os = "windows"))]
    let mut cmd = Command::new(&cmd_name);

    let output = cmd.args(args).current_dir(plugin_path).output()?;
    Ok(json!({
        "stdout": String::from_utf8_lossy(&output.stdout).to_string(),
        "stderr": String::from_utf8_lossy(&output.stderr).to_string(),
        "status": output.status.code().unwrap_or(-1),
    }))
}

#[tauri::command]
pub fn font_list() -> Result<Vec<String>, Error> {
    use font_kit::source::SystemSource;
    let source = SystemSource::new();

    Ok(source.all_families()?)
}

#[tauri::command]
pub fn open_devtools(window: tauri::Window) {
    if !window.is_devtools_open() {
        window.open_devtools();
    } else {
        window.close_devtools();
    }
}

#[cfg(test)]
mod tests {
    use super::{crop_in_bounds, valid_plugin_name, valid_plugin_type};

    #[test]
    fn screenshot_crop_rejects_empty_overflowing_and_out_of_bounds_rectangles() {
        assert!(crop_in_bounds(10, 20, 30, 40, 100, 100));
        assert!(!crop_in_bounds(10, 20, 0, 40, 100, 100));
        assert!(!crop_in_bounds(90, 20, 30, 40, 100, 100));
        assert!(!crop_in_bounds(u32::MAX, 20, 30, 40, 100, 100));
    }

    #[test]
    fn plugin_symlink_entries_are_rejected() {
        use super::is_symlink_entry;
        // 0o120000 是 Unix symlink 文件类型位（S_IFLNK）
        assert!(is_symlink_entry(Some(0o120777)));
        assert!(is_symlink_entry(Some(0o120000)));
        // 普通文件、目录、None 都不应被误判为 symlink
        assert!(!is_symlink_entry(Some(0o100644)));
        assert!(!is_symlink_entry(Some(0o040755)));
        assert!(!is_symlink_entry(None));
    }

    #[test]
    fn plugin_paths_cannot_escape_the_plugin_directory() {
        assert!(valid_plugin_type("translate"));
        assert!(!valid_plugin_type("../translate"));
        assert!(valid_plugin_name("plugin-openai_2"));
        assert!(!valid_plugin_name("../../plugin-evil"));
        assert!(!valid_plugin_name("plugin/evil"));
    }
}
