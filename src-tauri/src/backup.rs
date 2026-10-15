use crate::{error::Error, APP};
use dirs::config_dir;
use log::info;
use reqwest_dav::{Auth, ClientBuilder, Depth};
use std::io::{Cursor, Read, Seek, Write};
use std::path::{Path, PathBuf};
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

fn backup_name(name: Option<&str>) -> Result<&str, Error> {
    name.filter(|value| {
        !value.is_empty()
            && !value.contains('/')
            && !value.contains('\\')
            && *value != "."
            && *value != ".."
    })
    .ok_or_else(|| Error::Error("Invalid backup name".into()))
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
        if path != Path::new("config.json")
            && path != Path::new("history.db")
            && !path.starts_with("plugins")
        {
            return Err(Error::Error("Backup contains an unexpected file".into()));
        }
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err(Error::Error("Backup contains a symbolic link".into()));
        }
    }

    archive.extract(destination)?;
    Ok(())
}

fn make_archive<W: Write + Seek>(writer: W, config_dir_path: &Path) -> Result<W, Error> {
    let mut zip = zip::ZipWriter::new(writer);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    zip.start_file("config.json", options)?;
    std::io::copy(
        &mut std::fs::File::open(config_dir_path.join("config.json"))?,
        &mut zip,
    )?;

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
    // build a client
    let client = ClientBuilder::new()
        .set_host(url.clone())
        .set_auth(Auth::Basic(username.clone(), password.clone()))
        .build()?;
    client.mkcol("/pot-app").await.unwrap_or_default();
    let client = ClientBuilder::new()
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
            let data = res.bytes().await?;
            restore_archive(ZipArchive::new(Cursor::new(data))?, &app_config_dir()?)?;
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
                Err(e) => {
                    Err(Error::Error(format!("WebDav Put Error: {}", e).into()))
                }
            }
        }

        "delete" => match client
            .delete(&format!("/{}", backup_name(name.as_deref())?))
            .await
        {
            Ok(()) => Ok("".to_string()),
            Err(e) => {
                Err(Error::Error(format!("WebDav Delete Error: {}", e).into()))
            }
        },
        _ => {
            Err(Error::Error(
                format!("WebDav Operate Error: {}", operate).into(),
            ))
        }
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
        _ => {
            Err(Error::Error(
                format!("Local Operate Error: {}", operate).into(),
            ))
        }
    }
}

#[tauri::command(async)]
pub async fn aliyun(operate: &str, path: String, url: String) -> Result<String, Error> {
    match operate {
        "put" => {
            reqwest::Client::new()
                .put(&url)
                .body(std::fs::read(&path)?)
                .send()
                .await?
                .error_for_status()?;
            Ok("".to_string())
        }
        "get" => {
            let res = reqwest::Client::new()
                .get(&url)
                .send()
                .await?
                .error_for_status()?;
            let data = res.bytes().await?;
            restore_archive(ZipArchive::new(Cursor::new(data))?, &app_config_dir()?)?;
            Ok("".to_string())
        }
        _ => {
            Err(Error::Error(
                format!("Local Operate Error: {}", operate).into(),
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
