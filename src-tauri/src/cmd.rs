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

/// 解压前检查**落盘位置**是否已被一个符号链接占位。
///
/// 背景：`zip::ZipArchive::extract` 内部是 `fs::File::create(directory.join(name))`
/// （zip 0.6.6 src/read.rs:467），而 `File::create` 会**跟随已存在的符号链接**。
/// 上面已经拒绝了 zip **内部**的 symlink 条目，但若目标目录里预先放了一个
/// 指向别处的 symlink，解压依然能顺着它覆写插件目录**之外**的任意文件。
/// 两侧都要防，否则这道校验是单边的。
///
/// 返回 true 表示路径已被 symlink 占位，调用方应拒绝安装。
/// 注意：路径不存在，或已存在的是**普通文件/目录**（正常重装插件的情形）
/// 都返回 false，不改变既有语义。
fn target_is_symlinked(path: &std::path::Path) -> bool {
    path.symlink_metadata()
        .is_ok_and(|meta| meta.file_type().is_symlink())
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
        // 落盘目标若已被 symlink 占位，extract 会顺着它写到插件目录之外
        // （见 target_is_symlinked 的说明）。必须在解压前拦下。
        if target_is_symlinked(&plugin_path) {
            return Err(Error::Error(
                "Invalid Plugin: target path is a symbolic link".into(),
            ));
        }
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

    #[test]
    fn symlinked_install_targets_are_detected() {
        use super::target_is_symlinked;
        let base = std::env::temp_dir().join(format!("ct-cmd-symlink-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();

        // 不存在的路径：不拦截（首次安装的正常情形）
        let fresh = base.join("plugin-fresh");
        assert!(!target_is_symlinked(&fresh));

        // 普通文件 / 目录：不拦截（重装插件的正常情形）
        let file = base.join("plugin-file");
        std::fs::write(&file, b"x").unwrap();
        assert!(!target_is_symlinked(&file));
        let dir = base.join("plugin-dir");
        std::fs::create_dir_all(&dir).unwrap();
        assert!(!target_is_symlinked(&dir));

        // symlink：必须拦截
        #[cfg(unix)]
        {
            let link = base.join("plugin-link");
            std::os::unix::fs::symlink(&file, &link).unwrap();
            assert!(
                target_is_symlinked(&link),
                "a symlinked plugin target must be rejected"
            );
            // 目录形式的 symlink 同样要拦
            let dlink = base.join("plugin-dlink");
            std::os::unix::fs::symlink(&dir, &dlink).unwrap();
            assert!(target_is_symlinked(&dlink));
        }

        let _ = std::fs::remove_dir_all(&base);
    }

    /// 端到端复现：预置 symlink 后直接 extract 会覆写插件目录之外的文件。
    /// 这条测试锚定的是「zip crate 的真实行为」——即我们为什么要加那道检查；
    /// 若将来 zip 升级后不再跟随 symlink，这条会失败，提示我们可以放宽。
    #[cfg(unix)]
    #[test]
    fn zip_extract_would_follow_a_preexisting_symlink() {
        let base = std::env::temp_dir().join(format!("ct-cmd-extract-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let victim = base.join("victim.txt");
        let dest_dir = base.join("plugins").join("translate").join("plugin-evil");
        std::fs::create_dir_all(&dest_dir).unwrap();
        std::fs::write(&victim, b"ORIGINAL").unwrap();

        // 在落盘目录里放一个指向外部文件的 symlink
        std::os::unix::fs::symlink(&victim, dest_dir.join("main.js")).unwrap();
        // 注意：dest_dir 本身是真实目录（所以 target_is_symlinked 为 false，
        // 这正是我们要拦住的那个 symlink 的真实形态——它在目录**内部**）；
        // 真正被检查的是「解压时会被写到的那个文件路径」。
        assert!(!super::target_is_symlinked(&dest_dir));
        assert!(super::target_is_symlinked(&dest_dir.join("main.js")));

        // 构造一个含 main.js 的 zip，并按 extract 的方式落盘
        let zip_path = base.join("evil.potext");
        {
            let mut writer = zip::ZipWriter::new(std::fs::File::create(&zip_path).unwrap());
            let options: zip::write::FileOptions<()> =
                zip::write::FileOptions::default().unix_permissions(0o644);
            use std::io::Write;
            writer.start_file("main.js", options).unwrap();
            writer.write_all(b"EVIL").unwrap();
            writer.finish().unwrap();
        }
        let mut archive = zip::ZipArchive::new(std::fs::File::open(&zip_path).unwrap()).unwrap();
        archive.extract(&dest_dir).unwrap();

        // 记录 zip 的真实行为：它确实跟随了 symlink
        let after = std::fs::read(&victim).unwrap();
        assert_eq!(
            after, b"EVIL",
            "zip 0.6.6 extract follows pre-existing symlinks; if this changed, \
             revisit target_is_symlinked in install_plugin"
        );

        let _ = std::fs::remove_dir_all(&base);
    }
}
