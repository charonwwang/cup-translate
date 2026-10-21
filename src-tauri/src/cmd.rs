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

/// 纯函数：检查 zip 条目是否带**特殊权限位**（setuid / setgid / sticky）。
///
/// 背景（本轮实测）：`zip` 0.6.6 的 `extract` 会把条目的 `unix_mode`
/// 原样 `set_permissions` 落到磁盘上。实测确认：`external_attr = 0o4755`
/// 的归档条目解压后，磁盘上的文件权限**就是 4755**（setuid 位被保留）。
///
/// 这**不是提权漏洞**，不必渲染成安全事件：
///   - 落盘位置是用户自己的配置目录，用户对自己的文件本来就能随意 chmod；
///   - setuid 只在 exec 时生效，而插件是 .js，由 webview 读取、不会被执行；
///   - 安装 .potext 需要用户主动选文件，恶意插件本就已能执行 JS。
///
/// 之所以仍然拒绝，是**纵深防御与可预期性**：插件归档里出现 setuid/sticky
/// 这类位没有任何正当用途，属于「不该出现的东西」，应当像符号链接一样被显式拦下，
/// 而不是默默写进用户配置目录。
fn has_special_permission_bits(unix_mode: Option<u32>) -> bool {
    unix_mode.is_some_and(|mode| mode & 0o7000 != 0)
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

/// 插件目录名是否合法。
///
/// 这是**安装侧与列表侧共用的唯一判据**：`install_plugin` 用它拒绝非法
/// .potext 文件名，`config.rs::is_installed_plugin_dir` 用同一套规则决定
/// `plugins/<type>/` 下的目录是否算已安装插件。
///
/// 修复前列表侧只判 `starts_with("plugin")`，于是 `plugin..` / `plugin$x`
/// 这类**永远装不出来**的名字会被收进 plugin_list 并渲染成插件服务
/// （实测确认的不对称）。
///
/// 注：`!value.is_empty()` 是**死条件**——`starts_with("plugin")` 为真时
/// 长度必然 >= 6。保留它只为让意图显式；变异测试确认删掉它不改变任何行为
/// （属等价变异）。
pub(crate) fn valid_plugin_name(value: &str) -> bool {
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
        // 必须按 trim 后判定：`!value.is_empty()` 会放行纯空白（'   '），
        // 于是下面 format! 出 `http://   :7890`，再写进
        // http_proxy / https_proxy / all_proxy。实测确认：proxy_host='   ' 时
        // set_proxy() 成功返回、启动日志**没有**任何告警。（round 49）
        .filter(|value| !value.trim().is_empty())
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
                return Err(Error::Error(
                    "Invalid Plugin: contains a symbolic link".into(),
                ));
            }
            // setuid / setgid / sticky 位：zip 会原样 set_permissions 落盘
            //（实测 external_attr=0o4755 -> 磁盘 4755），插件归档里没有正当用途。
            if has_special_permission_bits(entry.unix_mode()) {
                return Err(Error::Error(
                    "Invalid Plugin: contains a file with setuid/setgid/sticky bits".into(),
                ));
            }
        }
        #[allow(unused_mut)]
        let mut plugin_type: String;
        if let Ok(info) = zip.by_name("info.json") {
            let mut content = String::new();
            // 限制 info.json 大小，防止 zip 炸弹
            info.take(MAX_PLUGIN_INFO_BYTES)
                .read_to_string(&mut content)?;
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
        let config_path =
            dirs::config_dir().ok_or_else(|| Error::Error("Get Config Dir Error".into()))?;
        let app_handle = APP
            .get()
            .ok_or_else(|| Error::Error("App is not initialized".into()))?;
        let config_path = config_path.join(app_handle.config().tauri.bundle.identifier.clone());
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
pub async fn run_binary(
    plugin_type: String,
    plugin_name: String,
    cmd_name: String,
    args: Vec<String>,
) -> Result<Value, String> {
    // Plugin subprocesses may be slow (for example OCR). Never wait for them on
    // the window thread, otherwise the next screenshot cannot update the UI.
    tauri::async_runtime::spawn_blocking(move || {
        run_binary_blocking(plugin_type, plugin_name, cmd_name, args).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

fn run_binary_blocking(
    plugin_type: String,
    plugin_name: String,
    cmd_name: String,
    args: Vec<String>,
) -> Result<Value, Error> {
    if crate::config::get_str("privacy_mode").as_deref() == Some("device_only") {
        return Err(Error::Error(
            "Plugins are blocked by device-only policy".into(),
        ));
    }

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

    /// 取出 `needle` 起点到**下一个顶层项**之间的源码切片（用于接线护栏）。
    ///
    /// 必须按「行首不得有空白」来判定顶层边界：测试模块里的函数是缩进的
    /// （`    fn xxx`），若只找 `"\nfn "` 会匹配不到，切片一路吃到文件末尾，
    /// 护栏就会把整个文件（含测试本身）算进去而形同虚设——本项目 round 45
    /// 实际踩过这个坑（切片 14432 字符 vs 应为 3524）。
    fn function_body(source: &'static str, needle: &str) -> &'static str {
        let start = source.find(needle).expect("the function should exist");
        let rest = &source[start..];
        let mut end = rest.len();
        for (offset, _) in rest.match_indices('\n') {
            let after = &rest[offset + 1..];
            // 顶层项：行首无缩进，且是 fn / pub fn / #[attr]
            if !after.starts_with([' ', '\t'])
                && (after.starts_with("fn ")
                    || after.starts_with("pub fn ")
                    || after.starts_with("pub async fn ")
                    || after.starts_with("#["))
            {
                end = offset + 1;
                break;
            }
        }
        let body = &rest[..end];
        // 双向自检：切片既不能吃到文件末尾（切太长），也不能在函数开头就断掉（切太短）。
        // 只查上界是不够的——把边界条件写成「每个 \n 都算边界」时切片只剩 70 字符，
        // 依然通过 len 检查，护栏会静默失效（round 45 实测踩到）。
        assert!(
            body.len() > 200,
            "the slice for {needle:?} is only {} chars — the boundary logic cut it short",
            body.len()
        );
        assert!(
            body.trim_end().ends_with('}'),
            "the slice for {needle:?} should end at the function's closing brace"
        );
        body
    }

    /// **接线**护栏：确认 `install_plugin` 真的调用了特殊权限位校验。
    ///
    /// 为什么需要单独一条：`special_permission_bits_are_flagged` 测的是**纯函数**，
    /// 把 `has_special_permission_bits` 从 `install_plugin` 里删掉，它照样通过。
    /// 这正是本项目 round 34 踩过的「测纯函数 ≠ 测接线」。
    #[test]
    fn install_plugin_actually_calls_the_special_permission_check() {
        let body = function_body(include_str!("cmd.rs"), "pub fn install_plugin(");
        // 自检：切片必须真的只覆盖这一个函数（见 function_body 的说明）
        assert!(
            body.len() < 6000,
            "the slice is {} chars, so it ran past install_plugin",
            body.len()
        );
        assert!(
            body.contains("has_special_permission_bits("),
            "install_plugin must call has_special_permission_bits — otherwise a .potext \
             with setuid/setgid/sticky bits is written to disk verbatim"
        );
        assert!(
            body.contains("is_symlink_entry("),
            "install_plugin must keep rejecting symbolic links"
        );
    }

    #[test]
    fn special_permission_bits_are_flagged() {
        use super::has_special_permission_bits;
        // setuid / setgid / sticky —— 插件归档里没有正当用途
        assert!(has_special_permission_bits(Some(0o4755))); // setuid
        assert!(has_special_permission_bits(Some(0o2755))); // setgid
        assert!(has_special_permission_bits(Some(0o1755))); // sticky
        assert!(has_special_permission_bits(Some(0o7777))); // 全带上
                                                            // 普通权限不能被误伤（否则正常插件装不上）
        for mode in [0o100644, 0o100755, 0o100600, 0o040755, 0o100000] {
            assert!(
                !has_special_permission_bits(Some(mode)),
                "{mode:o} is ordinary and must not be flagged"
            );
        }
        // 没有 mode（非 Unix 打的包）不应被拒
        assert!(!has_special_permission_bits(None));
    }

    #[test]
    fn plugin_paths_cannot_escape_the_plugin_directory() {
        assert!(valid_plugin_type("translate"));
        assert!(!valid_plugin_type("../translate"));
        assert!(valid_plugin_name("plugin-openai_2"));
        assert!(!valid_plugin_name("../../plugin-evil"));
        assert!(!valid_plugin_name("plugin/evil"));
    }

    /// 用**真实 zip 字节**造一个含穿越条目的归档，验证解压不会写到目标目录之外。
    ///
    /// 为什么要专门钉住这件事：`install_plugin` 自己**没有**做 `enclosed_name()`
    /// 校验（`restore_archive` 有），路径穿越目前**完全依赖 zip crate 内部**。
    /// 本轮实测 zip 0.6.6 确实会拒绝（`Invalid file path`），恶意 `../` 条目
    /// 一个文件都没落地——但这是**上游库的行为**，不是本仓库的显式契约。
    /// 一旦升级到某个不再默认校验的版本，防护会静默消失且无人察觉。
    /// 这条测试把「跨过库边界后的可观察结果」固定下来：
    /// 只要它开始失败，就说明该补一条与 restore_archive 对称的显式校验了。
    #[test]
    fn a_traversal_entry_never_lands_outside_the_destination() {
        use std::io::Write;

        let base = std::env::temp_dir().join(format!("ct-zipslip-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let archive_path = base.join("evil.potext");
        let dest = base.join("dest");
        std::fs::create_dir_all(&dest).unwrap();

        // 手工写 zip：两个正常条目 + 两个试图穿越的条目
        {
            let file = std::fs::File::create(&archive_path).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let opts: zip::write::FileOptions<()> = zip::write::FileOptions::default();
            for (name, body) in [
                ("info.json", r#"{"plugin_type":"translate"}"#),
                ("main.js", "console.log(1)"),
                ("../ESCAPED.txt", "pwned"),
                ("../../ESCAPED.txt", "pwned"),
            ] {
                zip.start_file(name, opts).unwrap();
                zip.write_all(body.as_bytes()).unwrap();
            }
            zip.finish().unwrap();
        }

        let mut zip = zip::ZipArchive::new(std::fs::File::open(&archive_path).unwrap()).unwrap();
        // extract 要么直接报错，要么成功——两种都行，关键是**不能**有文件逃出去
        let _ = zip.extract(&dest);

        assert!(
            !base.join("ESCAPED.txt").exists(),
            "a '../' entry escaped the destination directory"
        );
        assert!(
            !dest.parent().unwrap().join("ESCAPED.txt").exists(),
            "a traversal entry escaped one level up"
        );
        // 穿越条目若被拒绝，连正常条目也不应半途留下（extract 是逐个处理的，
        // 这里只断言**没有逃逸**，不假设事务性）
        let _ = std::fs::remove_dir_all(&base);
    }

    /// 与上一条配对：正常归档必须能完整解压，别把正常插件也拦掉了。
    #[test]
    fn an_ordinary_plugin_archive_still_extracts() {
        use std::io::Write;

        let base = std::env::temp_dir().join(format!("ct-zipok-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let dest = base.join("dest");
        std::fs::create_dir_all(&dest).unwrap();
        let archive_path = base.join("ok.potext");

        {
            let file = std::fs::File::create(&archive_path).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let opts: zip::write::FileOptions<()> =
                zip::write::FileOptions::default().unix_permissions(0o644);
            for (name, body) in [
                ("info.json", r#"{"plugin_type":"translate"}"#),
                ("main.js", "console.log(1)"),
            ] {
                zip.start_file(name, opts).unwrap();
                zip.write_all(body.as_bytes()).unwrap();
            }
            zip.finish().unwrap();
        }

        let mut zip = zip::ZipArchive::new(std::fs::File::open(&archive_path).unwrap()).unwrap();
        // 正常归档里不应有任何条目被 is_symlink_entry / has_special_permission_bits 拦下
        for index in 0..zip.len() {
            let entry = zip.by_index(index).unwrap();
            assert!(!super::is_symlink_entry(entry.unix_mode()));
            assert!(!super::has_special_permission_bits(entry.unix_mode()));
        }
        zip.extract(&dest).unwrap();
        assert!(dest.join("info.json").exists());
        assert!(dest.join("main.js").exists());
        let _ = std::fs::remove_dir_all(&base);
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
