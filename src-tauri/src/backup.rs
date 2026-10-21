use crate::{error::Error, APP};
use dirs::config_dir;
use log::info;
use reqwest_dav::{Auth, ClientBuilder, Depth};
use std::io::{Cursor, Read, Seek, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;
use walkdir::WalkDir;
use zip::read::ZipArchive;
use zip::write::SimpleFileOptions;

fn app_config_dir() -> Result<PathBuf, Error> {
    let base = config_dir().ok_or_else(|| Error::Error("Get Config Dir Error".into()))?;
    let identifier = &APP
        .get()
        .ok_or_else(|| Error::Error("App is not initialized".into()))?
        .config()
        .tauri
        .bundle
        .identifier;
    Ok(base.join(identifier))
}

/// 备份/恢复操作的 HTTP 超时（秒）：上传/下载可能传输大文件，给较宽松的上限，
/// 但仍避免网络卡死时永久挂起
const BACKUP_HTTP_TIMEOUT: Duration = Duration::from_secs(300);

/// 校验远端备份文件名。名字来自 WebDAV 服务器的 href（前端只取最后一段、
/// **不做百分号解码**），因此属于**外部输入**，必须严格校验。
///
/// 除了路径穿越（空、`/`、`\`、`.`、`..`），这里还拒绝**控制字符**。
/// 原因是实测得出的一条链路行为：名字最终被 `reqwest_dav` 用
/// `format!("{host}/{name}")` 拼成字符串再交给 `Url::parse`，而 `Url::parse` 会
/// **静默丢弃**原始换行 / 制表 / 回车（实测 `"a\nb.zip"` 变成 `"ab.zip"`），
/// 并把 NUL 编码成 `%00`。结果是「恢复」和「删除」实际操作的是
/// **另一个文件名**，而用户与日志看到的都是原始名字——轻则无谓的 404，
/// 重则删错文件。与其静默改名，不如在这里直接拒绝、让调用方拿到明确错误。
///
/// 注：`%2E%2E%2F` 这类**已编码**的形式会被 `Url::parse` 当作不透明片段原样保留，
/// 不会被解码成 `../`，因此不构成本文件需要额外处理的穿越风险
/// （真正的 `..` 段会先被上面的规则拒掉）。这里拒绝控制字符解决的是
/// 「静默改名」，不是「穿越」。
fn backup_name(name: Option<&str>) -> Result<&str, Error> {
    name.filter(|value| {
        !value.is_empty()
            && !value.contains('/')
            && !value.contains('\\')
            && *value != "."
            && *value != ".."
            // 控制字符（含 NUL / 换行 / 制表 / 回车 / DEL）：见上方说明
            && !value.chars().any(|c| c.is_control())
    })
    .ok_or_else(|| Error::Error("Invalid backup name".into()))
}

/// 逐组件规范化路径，消除中间的 `.` / `..`（不触碰前导 `..`，因为
/// enclosed_name() 已经拒绝那些）。用于把 `plugins/../x` 归一为 `x`
/// 再做白名单判断，避免借 plugins/ 前缀绕过。
fn normalize_components(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
}

fn restore_archive<R: Read + Seek>(
    mut archive: ZipArchive<R>,
    destination: &Path,
) -> Result<(), Error> {
    let mut config = String::new();
    archive
        .by_name("config.json")?
        .read_to_string(&mut config)?;
    if !serde_json::from_str::<serde_json::Value>(&config)?.is_object() {
        return Err(Error::Error(
            "Backup config.json must be a JSON object".into(),
        ));
    }

    for index in 0..archive.len() {
        let entry = archive.by_index(index)?;
        let path = entry
            .enclosed_name()
            .ok_or_else(|| Error::Error("Backup contains an unsafe path".into()))?;
        // 规范化路径后再做白名单判断，防止 `plugins/../escape.js` 这类借
        // plugins/ 前缀夹带非插件文件（enclosed_name() 不消除中间 `..`，
        // 直接 starts_with("plugins") 会误判通过，见 rejects_archive_path_traversal_and_symlinks）。
        let normalized = normalize_components(&path);
        if normalized != Path::new("config.json")
            && normalized != Path::new("history.db")
            && !normalized.starts_with("plugins")
        {
            return Err(Error::Error("Backup contains an unexpected file".into()));
        }
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err(Error::Error("Backup contains a symbolic link".into()));
        }
        // 与 cmd.rs::install_plugin 对称：zip 会把条目的 unix_mode 原样
        // set_permissions 落盘（实测 0o4755 -> 磁盘 4755），
        // setuid/setgid/sticky 在备份归档里同样没有正当用途。
        if entry.unix_mode().is_some_and(|mode| mode & 0o7000 != 0) {
            return Err(Error::Error(
                "Backup contains a file with setuid/setgid/sticky bits".into(),
            ));
        }
        // 单边的 symlink 校验是不够的：`archive.extract` 内部是
        // `fs::File::create(destination.join(name))`，会**跟随已存在的 symlink**。
        // 若恢复目标目录里预先被放了指向外部的 symlink，解压仍会覆写目录之外的文件。
        // 因此还要检查每个条目在**落盘位置**上是否已被 symlink 占位
        //（与 cmd.rs::install_plugin 的处理对称）。
        if destination
            .join(&normalized)
            .symlink_metadata()
            .is_ok_and(|meta| meta.file_type().is_symlink())
        {
            return Err(Error::Error(
                "Backup target is occupied by a symbolic link".into(),
            ));
        }
    }

    // Never extract the legacy plaintext config, even temporarily.
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index)?;
        let path = normalize_components(
            &entry
                .enclosed_name()
                .ok_or_else(|| Error::Error("Invalid archive path".into()))?,
        );
        if path == Path::new("config.json") {
            continue;
        }
        let target = destination.join(path);
        let mut parent = target.parent();
        while let Some(directory) = parent {
            if !directory.starts_with(destination) {
                break;
            }
            if directory
                .symlink_metadata()
                .is_ok_and(|m| m.file_type().is_symlink())
            {
                return Err(Error::Error("Backup ancestor is a symbolic link".into()));
            }
            parent = directory.parent();
        }
        if entry.is_dir() {
            std::fs::create_dir_all(&target)?;
        } else {
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::io::copy(&mut entry, &mut std::fs::File::create(&target)?)?;
        }
    }
    let mut restored: serde_json::Value = serde_json::from_str(&config)?;
    crate::credentials::scrub(&mut restored);
    std::fs::write(
        destination.join("config.json"),
        serde_json::to_vec(&restored)?,
    )?;
    Ok(())
}

fn make_archive<W: Write + Seek>(writer: W, config_dir_path: &Path) -> Result<W, Error> {
    let mut zip = zip::ZipWriter::new(writer);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    zip.start_file("config.json", options)?;
    let mut config: serde_json::Value =
        serde_json::from_reader(std::fs::File::open(config_dir_path.join("config.json"))?)?;
    crate::credentials::scrub(&mut config);
    zip.write_all(&serde_json::to_vec(&config)?)?;

    let history = config_dir_path.join("history.db");
    if history.exists() {
        zip.start_file("history.db", options)?;
        std::io::copy(&mut std::fs::File::open(history)?, &mut zip)?;
    }

    let plugins = config_dir_path.join("plugins");
    if plugins.exists() {
        for entry in WalkDir::new(plugins) {
            let entry = entry?;
            if !entry.file_type().is_file() {
                continue;
            }
            let path = entry.path();
            let file_name = path
                .strip_prefix(config_dir_path)?
                .to_str()
                .ok_or_else(|| Error::Error("Invalid backup file path".into()))?;
            info!("adding file {path:?} as {file_name:?} ...");
            zip.start_file(file_name, options)?;
            std::io::copy(&mut std::fs::File::open(path)?, &mut zip)?;
        }
    }

    Ok(zip.finish()?)
}

#[tauri::command(async)]
pub async fn webdav(
    operate: &str,
    url: String,
    username: String,
    password: String,
    name: Option<String>,
) -> Result<String, Error> {
    // build a client（reqwest_dav 内部用 reqwest 0.11，agent 需用其 re_exports 类型）
    let http_client = reqwest_dav::re_exports::reqwest::Client::builder()
        .timeout(BACKUP_HTTP_TIMEOUT)
        .build()?;
    let client = ClientBuilder::new()
        .set_agent(http_client.clone())
        .set_host(url.clone())
        .set_auth(Auth::Basic(username.clone(), password.clone()))
        .build()?;
    client.mkcol("/pot-app").await.unwrap_or_default();
    let client = ClientBuilder::new()
        .set_agent(http_client)
        .set_host(format!("{}/pot-app", url.trim_end_matches("/")))
        .set_auth(Auth::Basic(username, password))
        .build()?;
    match operate {
        "list" => {
            let res = client.list("/", Depth::Number(1)).await?;
            let result = serde_json::to_string(&res)?;
            Ok(result)
        }
        "get" => {
            let res = client
                .get(&format!("/{}", backup_name(name.as_deref())?))
                .await?;
            // 流式写入临时文件再恢复，避免大备份全量加载进内存。
            // TempBackupFile 在函数返回（含提前 `?` 与 panic）时自动删除临时文件，
            // 避免下载中断/内容非法时在临时目录留下大文件。
            let tmp = TempBackupFile::new("webdav");
            let mut tmp_file = std::fs::File::create(tmp.path())?;
            let mut resp = res;
            while let Some(chunk) = resp.chunk().await? {
                std::io::Write::write_all(&mut tmp_file, &chunk)?;
            }
            drop(tmp_file);
            let mut zip_file = std::fs::File::open(tmp.path())?;
            restore_archive(ZipArchive::new(&mut zip_file)?, &app_config_dir()?)?;
            Ok("".to_string())
        }
        "put" => {
            let config_dir_path = app_config_dir()?;
            let archive = make_archive(Cursor::new(Vec::new()), &config_dir_path)?.into_inner();
            match client
                .put(&format!("/{}", backup_name(name.as_deref())?), archive)
                .await
            {
                Ok(()) => Ok("".to_string()),
                Err(e) => Err(Error::Error(format!("WebDav Put Error: {}", e).into())),
            }
        }

        "delete" => match client
            .delete(&format!("/{}", backup_name(name.as_deref())?))
            .await
        {
            Ok(()) => Ok("".to_string()),
            Err(e) => Err(Error::Error(format!("WebDav Delete Error: {}", e).into())),
        },
        _ => Err(Error::Error(
            format!("WebDav Operate Error: {}", operate).into(),
        )),
    }
}

#[tauri::command(async)]
pub async fn local(operate: &str, path: String) -> Result<String, Error> {
    match operate {
        "put" => {
            let config_dir_path = app_config_dir()?;
            make_archive(std::fs::File::create(&path)?, &config_dir_path)?;
            Ok("".to_string())
        }
        "get" => {
            let mut zip_file = std::fs::File::open(&path)?;
            restore_archive(ZipArchive::new(&mut zip_file)?, &app_config_dir()?)?;
            Ok("".to_string())
        }
        _ => Err(Error::Error(
            format!("Local Operate Error: {}", operate).into(),
        )),
    }
}

#[tauri::command(async)]
pub async fn aliyun(operate: &str, path: String, url: String) -> Result<String, Error> {
    if crate::config::get_str("privacy_mode").as_deref() == Some("device_only") {
        return Err(Error::Error(
            "External OCR upload is blocked by device-only policy".into(),
        ));
    }
    match operate {
        "put" => {
            // 注意：std::fs::read 会把整个备份加载进内存。reqwest 0.12 的
            // Body::from 不支持 std::fs::File（需 tokio::fs::File 或流式包装），
            // 备份上传是用户主动操作且体积有限（配置+插件，通常几 MB），暂接受
            // 此内存占用。下载方向已改流式写入临时文件（见 get 分支）。
            reqwest::Client::builder()
                .timeout(BACKUP_HTTP_TIMEOUT)
                .build()?
                .put(&url)
                .body(std::fs::read(&path)?)
                .send()
                .await?
                .error_for_status()?;
            Ok("".to_string())
        }
        "get" => {
            let res = reqwest::Client::builder()
                .timeout(BACKUP_HTTP_TIMEOUT)
                .build()?
                .get(&url)
                .send()
                .await?
                .error_for_status()?;
            // 流式写入临时文件再恢复，避免大备份全量加载进内存。
            // 同 webdav 分支：用 RAII 保证任何退出路径都会清理临时文件。
            let tmp = TempBackupFile::new("aliyun");
            let mut tmp_file = std::fs::File::create(tmp.path())?;
            let mut resp = res;
            while let Some(chunk) = resp.chunk().await? {
                std::io::Write::write_all(&mut tmp_file, &chunk)?;
            }
            drop(tmp_file);
            let mut zip_file = std::fs::File::open(tmp.path())?;
            restore_archive(ZipArchive::new(&mut zip_file)?, &app_config_dir()?)?;
            Ok("".to_string())
        }
        _ => Err(Error::Error(
            format!("Local Operate Error: {}", operate).into(),
        )),
    }
}

/// 下载落盘用的临时文件，Drop 时自动删除。
///
/// 备份包可能很大（含 history.db 与 plugins/），而下载过程有多个可失败点：
/// 网络中断、写盘失败、内容不是合法 zip。原实现只在 restore_archive 之后
/// 手动 `remove_file`，那些**提前 `?` 返回**的路径会跳过清理，
/// 在临时目录里留下几十 MB 的半成品，反复失败会持续占用磁盘。
///
/// 用 RAII 保证「无论从哪条路径退出（含 panic）都会删除」。
struct TempBackupFile {
    path: PathBuf,
}

impl TempBackupFile {
    /// 生成唯一路径：`kind` 区分 webdav / aliyun 两条链路，
    /// 进程号区分不同实例，自增序号区分同进程内的多次调用。
    ///
    /// 当前 UI 用 uploading 标志串行化了恢复操作，同 kind 并发并不常见；
    /// 但测试是多线程并行跑的，且将来若放开并发，仅靠 PID 会让两次恢复
    /// 写同一个临时文件、互相截断对方的内容。加序号是廉价且彻底的保险。
    fn new(kind: &str) -> Self {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(0);

        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "cup-translate-{kind}-restore-{}-{seq}",
            std::process::id()
        ));
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempBackupFile {
    fn drop(&mut self) {
        // 尽力清理：文件可能已不存在（创建失败等），失败也不应影响主流程
        match std::fs::remove_file(&self.path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => log::warn!(
                "Failed to remove temporary backup file {:?}: {e}",
                self.path
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn temp_backup_file_is_removed_on_normal_drop() {
        let path = {
            let tmp = TempBackupFile::new("test-normal");
            std::fs::write(tmp.path(), b"partial download").unwrap();
            assert!(
                tmp.path().exists(),
                "file should exist while the guard lives"
            );
            tmp.path().to_path_buf()
        };
        assert!(
            !path.exists(),
            "dropping the guard must delete the temporary file"
        );
    }

    #[test]
    fn temp_backup_file_is_removed_when_the_body_exits_early() {
        // 核心用例：模拟「下载/校验中途 `?` 提前返回」。
        // 原实现只在 restore_archive 之后手动 remove_file，
        // 这些提前返回的路径会跳过清理，在临时目录留下半成品大文件。
        //
        // 注意：不要断言「临时目录里没有任何同名残留」——
        // 临时目录是进程间共享的，别的用例乃至上一次失败留下的文件都可能在里面
        // （本用例最早就是被自己上一次失败留下的文件绊倒的）。
        // 这里只针对**本次运行创建的那个具体路径**断言，不依赖外部状态。
        fn fake_restore_that_fails(path_out: &mut Option<PathBuf>) -> Result<(), Error> {
            let tmp = TempBackupFile::new("test-early-exit");
            *path_out = Some(tmp.path().to_path_buf());
            std::fs::write(tmp.path(), b"truncated zip").unwrap();
            // 用 ? 提前返回，绕过任何显式清理代码
            Err(Error::Error("simulated download failure".into()))?;
            Ok(())
        }

        let mut path = None;
        assert!(fake_restore_that_fails(&mut path).is_err());
        let path = path.expect("the guard should have been created before failing");
        assert!(
            !path.exists(),
            "an early `?` return must still clean up {path:?}"
        );
    }

    #[test]
    fn dropping_the_guard_is_safe_when_no_file_was_created() {
        // 创建文件前就失败的情况：Drop 不应 panic（NotFound 要容忍）
        let tmp = TempBackupFile::new("test-missing");
        assert!(!tmp.path().exists());
        drop(tmp);
    }

    #[test]
    fn temp_paths_are_unique_per_kind() {
        // webdav 与 aliyun 两条链路若同名，同时恢复会互相覆盖
        let webdav = TempBackupFile::new("webdav");
        let aliyun = TempBackupFile::new("aliyun");
        assert_ne!(webdav.path(), aliyun.path());
    }

    fn archive(files: &[(&str, &[u8])]) -> ZipArchive<Cursor<Vec<u8>>> {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, content) in files {
            writer
                .start_file(*name, SimpleFileOptions::default())
                .unwrap();
            writer.write_all(content).unwrap();
        }
        ZipArchive::new(Cursor::new(writer.finish().unwrap().into_inner())).unwrap()
    }

    #[test]
    fn restores_current_backup_layout() {
        let destination = std::env::temp_dir().join(format!(
            "cup-translate-backup-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let backup = archive(&[
            ("config.json", br#"{"app_language":"zh_cn"}"#),
            (
                "plugins/translate/plugin-test/main.js",
                b"export default 1;",
            ),
        ]);
        restore_archive(backup, &destination).unwrap();
        assert_eq!(
            std::fs::read_to_string(destination.join("config.json")).unwrap(),
            r#"{"app_language":"zh_cn"}"#
        );
        assert!(destination
            .join("plugins/translate/plugin-test/main.js")
            .exists());
        std::fs::remove_dir_all(destination).unwrap();
    }

    /// `make_archive` 的 plugins/ 遍历此前**没有任何测试**：既有的
    /// `created_backup_round_trips_settings_and_history` 只建了 config.json 与
    /// history.db，从不为源目录建 plugins/，于是 line 148-164 那段
    /// （WalkDir 递归 + strip_prefix + start_file）从未真正执行过。
    /// 这条补上「插件文件真的进了归档、且能原样恢复」的往返验证。
    #[test]
    fn plugins_are_included_in_the_backup_and_round_trip() {
        let base = unique_temp_dir("cup-translate-backup-plugins-roundtrip");
        let source = base.join("source");
        let restored = base.join("restored");
        let plugin_file = source.join("plugins/translate/plugin-demo/main.js");
        let plugin_config = source.join("plugins/translate/plugin-demo/info.json");
        std::fs::create_dir_all(plugin_file.parent().unwrap()).unwrap();
        std::fs::create_dir_all(&restored).unwrap();
        std::fs::write(source.join("config.json"), r#"{"app_language":"en"}"#).unwrap();
        std::fs::write(&plugin_file, b"export default { name: 'demo' };").unwrap();
        std::fs::write(&plugin_config, br#"{"id":"demo"}"#).unwrap();

        let data = make_archive(Cursor::new(Vec::new()), &source)
            .unwrap()
            .into_inner();

        // 归档里必须**真的**有这两个条目，且路径是相对 source 的 POSIX 形式
        let names: Vec<String> = ZipArchive::new(Cursor::new(data.clone()))
            .unwrap()
            .file_names()
            .map(str::to_owned)
            .collect();
        assert!(
            names
                .iter()
                .any(|n| n == "plugins/translate/plugin-demo/main.js"),
            "the plugin entry must be in the archive, got {names:?}"
        );
        assert!(
            names
                .iter()
                .any(|n| n == "plugins/translate/plugin-demo/info.json"),
            "nested plugin files must all be included, got {names:?}"
        );

        restore_archive(ZipArchive::new(Cursor::new(data)).unwrap(), &restored).unwrap();
        assert_eq!(
            std::fs::read(restored.join("plugins/translate/plugin-demo/main.js")).unwrap(),
            b"export default { name: 'demo' };"
        );
        assert_eq!(
            std::fs::read(restored.join("plugins/translate/plugin-demo/info.json")).unwrap(),
            br#"{"id":"demo"}"#
        );
        std::fs::remove_dir_all(base).unwrap();
    }

    /// 目录条目不该被写进归档（`is_file()` 过滤），否则恢复时会多出空目录。
    /// 同时验证空 plugins/ 目录不会让备份失败。
    #[test]
    fn an_empty_plugins_directory_is_skipped_without_failing() {
        let base = unique_temp_dir("cup-translate-backup-empty-plugins");
        let source = base.join("source");
        std::fs::create_dir_all(source.join("plugins")).unwrap();
        std::fs::write(source.join("config.json"), r#"{"app_language":"en"}"#).unwrap();

        let data = make_archive(Cursor::new(Vec::new()), &source)
            .unwrap()
            .into_inner();
        let names: Vec<String> = ZipArchive::new(Cursor::new(data))
            .unwrap()
            .file_names()
            .map(str::to_owned)
            .collect();
        assert!(
            !names.iter().any(|n| n.ends_with('/')),
            "directory entries must not be archived, got {names:?}"
        );
        std::fs::remove_dir_all(base).unwrap();
    }

    /// 没有 plugins/ 目录时也不能失败（全新安装、从未装过插件）。
    #[test]
    fn a_missing_plugins_directory_is_not_an_error() {
        let base = unique_temp_dir("cup-translate-backup-no-plugins");
        let source = base.join("source");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("config.json"), r#"{"app_language":"en"}"#).unwrap();

        let data = make_archive(Cursor::new(Vec::new()), &source)
            .unwrap()
            .into_inner();
        let names: Vec<String> = ZipArchive::new(Cursor::new(data))
            .unwrap()
            .file_names()
            .map(str::to_owned)
            .collect();
        assert_eq!(
            names,
            vec!["config.json".to_string()],
            "only config.json is expected"
        );
        std::fs::remove_dir_all(base).unwrap();
    }

    /// 生成一个唯一的临时目录（进程 id + 纳秒），避免并行测试互相踩。
    fn unique_temp_dir(prefix: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "{}-{}-{}",
            prefix,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn created_backup_round_trips_settings_and_history() {
        let base = std::env::temp_dir().join(format!(
            "cup-translate-backup-roundtrip-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let source = base.join("source");
        let restored = base.join("restored");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("config.json"), r#"{"app_language":"en"}"#).unwrap();
        std::fs::write(source.join("history.db"), b"history bytes").unwrap();

        let data = make_archive(Cursor::new(Vec::new()), &source)
            .unwrap()
            .into_inner();
        restore_archive(ZipArchive::new(Cursor::new(data)).unwrap(), &restored).unwrap();
        assert_eq!(
            std::fs::read_to_string(restored.join("config.json")).unwrap(),
            r#"{"app_language":"en"}"#
        );
        assert_eq!(
            std::fs::read(restored.join("history.db")).unwrap(),
            b"history bytes"
        );
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn rejects_archives_without_valid_config_or_with_unexpected_files() {
        let destination = std::env::temp_dir().join("cup-translate-backup-validation-test");
        assert!(restore_archive(archive(&[("config.json", b"null")]), &destination).is_err());
        assert!(restore_archive(
            archive(&[("config.json", b"{}"), ("other.txt", b"unexpected")]),
            &destination
        )
        .is_err());
    }

    #[test]
    fn rejects_archive_path_traversal_and_symlinks() {
        let destination = std::env::temp_dir().join(format!(
            "cup-translate-backup-traversal-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        // zip slip: 路径穿越条目必须被 enclosed_name() 拒绝
        assert!(restore_archive(
            archive(&[("config.json", b"{}"), ("../outside.txt", b"escaped"),]),
            &destination
        )
        .is_err());
        // 绝对路径条目也必须被拒
        assert!(restore_archive(
            archive(&[("config.json", b"{}"), ("/etc/cron.d/evil", b"pwned")]),
            &destination
        )
        .is_err());
        // plugins/ 前缀被用来夹带 .. 路径穿越：normalize_components() 把它
        // 归一为 escape.js（不在 plugins/ 下），必须被白名单拒绝。
        assert!(restore_archive(
            archive(&[("config.json", b"{}"), ("plugins/../escape.js", b"escaped"),]),
            &destination
        )
        .is_err());
        // 合法的 plugins/ 子路径仍应被接受
        assert!(restore_archive(
            archive(&[
                ("config.json", b"{}"),
                ("plugins/translate/plugin-a/main.js", b"export default 1;"),
            ]),
            &destination
        )
        .is_ok());
        let _ = std::fs::remove_dir_all(&destination);
    }

    /// 恢复目标的落盘位置若被 symlink 占位，必须拒绝——否则 extract 会跟随
    /// 该链接覆写到配置目录之外（zip 0.6.6 的 extract 用 File::create，
    /// 行为已由 cmd::tests::zip_extract_would_follow_a_preexisting_symlink 锚定）。
    #[cfg(unix)]
    #[test]
    fn rejects_target_occupied_by_a_symbolic_link() {
        let destination = std::env::temp_dir().join(format!(
            "cup-translate-backup-symlink-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&destination);
        std::fs::create_dir_all(&destination).unwrap();

        // 受害文件位于配置目录之外
        let victim = destination
            .parent()
            .unwrap()
            .join(format!("victim-{}.txt", std::process::id()));
        std::fs::write(&victim, b"ORIGINAL").unwrap();

        // 在恢复目标里把 config.json 换成指向受害文件的 symlink
        std::os::unix::fs::symlink(&victim, destination.join("config.json")).unwrap();

        let result = restore_archive(
            archive(&[("config.json", b"{\"evil\":true}")]),
            &destination,
        );
        assert!(
            result.is_err(),
            "restoring onto a symlinked target must be refused"
        );
        // 关键：受害文件必须**未被改写**
        assert_eq!(
            std::fs::read(&victim).unwrap(),
            b"ORIGINAL",
            "the file outside the destination must be untouched"
        );

        let _ = std::fs::remove_file(&victim);
        let _ = std::fs::remove_dir_all(&destination);
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

    /// **接线**护栏：确认 `restore_archive` 真的调用了特殊权限位校验
    ///（与 cmd.rs 的 install_plugin 对称，说明见那里的 function_body）。
    #[test]
    fn restore_archive_actually_rejects_special_permission_bits() {
        let body = function_body(include_str!("backup.rs"), "fn restore_archive");
        assert!(
            body.len() < 12000,
            "the slice is {} chars, so it ran past restore_archive",
            body.len()
        );
        assert!(
            body.contains("0o7000"),
            "restore_archive must reject setuid/setgid/sticky bits, not just symlinks"
        );
        assert!(
            body.contains("0o120000"),
            "restore_archive must keep rejecting symbolic links"
        );
    }

    #[test]
    fn rejects_missing_or_path_like_remote_backup_names() {
        for name in [
            None,
            Some(""),
            Some("."),
            Some(".."),
            Some("../settings.zip"),
            Some("a\\b.zip"),
        ] {
            assert!(backup_name(name).is_err());
        }
        assert_eq!(backup_name(Some("settings.zip")).unwrap(), "settings.zip");
    }

    #[test]
    fn rejects_remote_backup_names_containing_control_characters() {
        // 这些名字**不是**穿越风险，而是「静默改名」风险：
        // 它们会被 reqwest_dav 拼进 URL，Url::parse 随后丢掉换行/制表/回车
        // （实测 "a\nb.zip" -> "ab.zip"）、把 NUL 编码成 %00。
        // 结果就是恢复/删除操作实际打到了另一个文件名上。
        // 与其静默改到一个可能存在的文件，不如直接拒绝。
        for name in [
            Some("a\nb.zip"),       // 换行
            Some("a\rb.zip"),       // 回车
            Some("a\tb.zip"),       // 制表
            Some("a\u{0}b.zip"),    // NUL
            Some("a\u{7f}b.zip"),   // DEL (C0)
            Some("\u{1b}[31m.zip"), // ANSI 转义（还会污染日志）
            Some("a\u{85}b.zip"),   // NEL (C1)：char::is_control() 覆盖 C1 区
        ] {
            assert!(
                backup_name(name).is_err(),
                "{name:?} contains a control character and must be rejected"
            );
        }
    }

    /// 明确记录 `is_control()` 的**边界**，避免夸大该防护的覆盖面。
    ///
    /// 它覆盖 C0 与 C1 控制字符，但**不覆盖** U+200B（零宽空格）、
    /// U+FEFF（BOM）这类「格式字符」（Unicode 类别 Cf，不是 Cc）。
    /// 本轮的修复针对的是会把名字**改写成另一个文件**的字符——
    /// 那正是 `Url::parse` 会丢弃/重编码的那批（CR/LF/TAB/NUL），全部在 Cc 内。
    /// Cf 字符不会导致改名，因此不纳入拒绝范围；这条测试把该界限钉住，
    /// 免得后人看到「拒绝控制字符」就以为 ZWSP 也被拦了。
    #[test]
    fn format_characters_are_outside_the_control_character_check() {
        for name in ["a\u{200b}b.zip", "\u{feff}a.zip"] {
            assert!(
                backup_name(Some(name)).is_ok(),
                "{name:?} is a Unicode *format* character (Cf), not a control character (Cc); \
                 it does not get rewritten by Url::parse, so it is intentionally accepted"
            );
        }
    }

    #[test]
    fn ordinary_remote_backup_names_still_pass() {
        // 反向：不要把正常名字误伤。前端的默认名字形如
        // `macos-2026-10-15-14-30-0.zip`，含连字符与点，必须放行。
        for name in [
            "settings.zip",
            "macos-2026-10-15-14-30-0.zip",
            "备份.zip",
            "a b.zip",
        ] {
            assert_eq!(
                backup_name(Some(name)).unwrap(),
                name,
                "{name:?} is an ordinary backup name and must be accepted"
            );
        }
    }

    #[test]
    fn encoded_traversal_sequences_are_not_silently_decoded() {
        // 记录一条实测结论，避免后人误以为这里是穿越漏洞而做出错误的"加固"：
        // 名字最终由 reqwest_dav 拼成 `{host}/{name}` 再 `Url::parse`，
        // 而 Url::parse **不会**解码已有的 %XX，`%2E%2E%2F` 会被当作不透明片段保留。
        // 因此 backup_name 无需（也不应）尝试解码后再判断——
        // 真正的 `..` 段已经由 `*value != ".."` 拒掉了。
        // 这里只断言当前行为：这些形式被接受，且原样返回、不做解码。
        for name in ["%2E%2E%2Fetc%2Fpasswd", "..%2F..%2Fx.zip"] {
            assert_eq!(
                backup_name(Some(name)).unwrap(),
                name,
                "{name:?} is passed through verbatim — Url::parse keeps %XX opaque, \
                 so this is not a path-traversal bypass"
            );
        }
    }
}
