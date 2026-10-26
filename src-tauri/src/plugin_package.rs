//! Pot packages are trusted code, not a sandbox. All disk paths use portable rules.
use serde_json::Value;
use std::{
    collections::HashSet,
    fs,
    io::Read,
    path::{Path, PathBuf},
};
type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
const MAX_FILE: u64 = 256 * 1024 * 1024;
const MAX_TOTAL: u64 = 512 * 1024 * 1024;

pub fn valid_component(s: &str) -> bool {
    let base = s.split('.').next().unwrap_or("").to_ascii_uppercase();
    !s.is_empty()
        && s.len() <= 128
        && !s.ends_with('.')
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
        && s.split('.').all(|part| !part.is_empty())
        && !matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        && !(base.len() == 4
            && (base.starts_with("COM") || base.starts_with("LPT"))
            && matches!(base.as_bytes()[3], b'1'..=b'9'))
}
pub fn valid_name(s: &str) -> bool {
    s.starts_with("plugin") && valid_component(s)
}
pub fn valid_type(s: &str) -> bool {
    ["recognize", "translate", "tts", "collection"].contains(&s)
}
pub fn valid_resource(s: &str) -> bool {
    !s.is_empty() && !s.contains('\\') && s.split('/').all(valid_component)
}
/// Reject symlinks in every existing ancestor, including dangling links.
pub fn no_links(path: &Path) -> Result<()> {
    for part in path.ancestors() {
        match part.symlink_metadata() {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err("Plugin path contains a symbolic link".into())
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}
pub fn resource(root: &Path, relative: &str) -> Result<PathBuf> {
    if !valid_resource(relative) {
        return Err("Invalid plugin resource path".into());
    }
    let path = root.join(relative);
    no_links(&path)?;
    if !path.is_file() {
        return Err("Missing plugin resource".into());
    }
    Ok(path)
}
pub fn executable(root: &Path, command: &str) -> Result<PathBuf> {
    let path = Path::new(command);
    let relative = if path.is_absolute() {
        path.strip_prefix(root)?
            .to_str()
            .ok_or("Invalid executable path")?
    } else {
        command.strip_prefix("./").unwrap_or(command)
    };
    // On Windows convert only the already-contained absolute path to the archive convention.
    #[cfg(windows)]
    let relative = relative.replace('\\', "/");
    resource(root, &relative)
}

/// Legacy renamed directories keep their identity; upgrading requires the same manifest ID.
/// We never rename directories or rewrite service configuration implicitly.
pub fn metadata(root: &Path, kind: &str, directory: &str) -> Result<Value> {
    if !valid_type(kind) || !valid_name(directory) {
        return Err("Invalid plugin path".into());
    }
    let info = resource(root, "info.json")?;
    if info.metadata()?.len() > 64 * 1024 {
        return Err("Plugin info.json exceeds 64 KiB".into());
    }
    let value: Value = serde_json::from_slice(&fs::read(info)?)?;
    let id = value["id"].as_str().ok_or("Missing plugin ID")?;
    if !valid_name(id) || value["plugin_type"].as_str() != Some(kind) {
        return Err("Invalid plugin ID or category".into());
    }
    for key in ["display", "homepage"] {
        if value[key].as_str().is_none_or(|s| s.trim().is_empty()) {
            return Err(format!("Missing plugin {key}").into());
        }
    }
    if !value["homepage"]
        .as_str()
        .is_some_and(|s| s.starts_with("https://") || s.starts_with("http://"))
    {
        return Err("Plugin homepage must use HTTP or HTTPS".into());
    }
    let needs = value["needs"]
        .as_array()
        .ok_or("Invalid plugin configuration fields")?;
    let mut keys = HashSet::new();
    for field in needs {
        let key = field["key"].as_str().ok_or("Invalid configuration key")?;
        if !valid_component(key) || !keys.insert(key) || !field["display"].is_string() {
            return Err("Invalid configuration field".into());
        }
        if let Some(t) = field["type"].as_str() {
            if t != "input" && t != "select" {
                return Err("Unsupported configuration field type".into());
            }
            if t == "select"
                && field["options"]
                    .as_object()
                    .is_none_or(|o| o.is_empty() || o.values().any(|v| !v.is_string()))
            {
                return Err("Invalid select options".into());
            }
        }
    }
    if kind != "collection"
        && value["language"]
            .as_object()
            .is_none_or(|o| o.is_empty() || o.values().any(|v| !v.is_string()))
    {
        return Err("Invalid plugin language map".into());
    }
    resource(root, value["icon"].as_str().ok_or("Missing plugin icon")?)?;
    let main = resource(root, "main.js")?;
    if main.metadata()?.len() == 0 || main.metadata()?.len() > 4 * 1024 * 1024 {
        return Err("Invalid plugin main.js size".into());
    }
    // JavaScript syntax and callable entry are checked by the host before invocation.
    std::str::from_utf8(&fs::read(main)?)?;
    Ok(value)
}

fn recover(parent: &Path, name: &str) -> Result<()> {
    let marker = parent.join(format!(".{name}.pending"));
    if !marker.exists() {
        return Ok(());
    }
    let target = parent.join(name);
    let backup = parent.join(format!(".{name}.previous"));
    no_links(&marker)?;
    no_links(&target)?;
    no_links(&backup)?;
    if !target.exists() && backup.exists() {
        fs::rename(backup, target)?;
    }
    fs::remove_file(marker)?;
    Ok(())
}

pub fn uninstall(root: &Path, kind: &str, name: &str) -> Result<()> {
    if !valid_type(kind) || !valid_name(name) {
        return Err("Invalid plugin path".into());
    }
    let parent = root.join(kind);
    no_links(&parent)?;
    no_links(&parent.join(".install.lock"))?;
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(parent.join(".install.lock"))?;
    fs2::FileExt::lock_exclusive(&lock)?;
    for path in [parent.join(name), parent.join(format!(".{name}.previous"))] {
        no_links(&path)?;
        if path.exists() {
            fs::remove_dir_all(path)?;
        }
    }
    let marker = parent.join(format!(".{name}.pending"));
    no_links(&marker)?;
    if marker.exists() {
        fs::remove_file(marker)?;
    }
    Ok(())
}

pub fn entry_info(package: &Path) -> Result<Value> {
    use sha2::{Digest, Sha256};
    let mut archive = zip::ZipArchive::new(fs::File::open(package)?)?;
    let entry = archive.by_name("main.js")?;
    if entry.size() == 0 || entry.size() > 4 * 1024 * 1024 {
        return Err("Invalid plugin main.js size".into());
    }
    let mut script = String::new();
    entry
        .take(4 * 1024 * 1024 + 1)
        .read_to_string(&mut script)?;
    let digest = format!("{:x}", Sha256::digest(script.as_bytes()));
    Ok(serde_json::json!({"script":script,"digest":digest}))
}

#[cfg(test)]
pub fn install(root: &Path, package: &Path) -> Result<String> {
    install_checked(root, package, None)
}

fn install_checked(root: &Path, package: &Path, expected_entry: Option<&str>) -> Result<String> {
    if package.extension().and_then(|s| s.to_str()) != Some("potext") {
        return Err("Expected a .potext package".into());
    }
    let name = package
        .file_stem()
        .and_then(|s| s.to_str())
        .filter(|s| valid_name(s))
        .ok_or("Invalid plugin package name")?;
    let mut archive = zip::ZipArchive::new(fs::File::open(package)?)?;
    if archive.len() > 4096 {
        return Err("Plugin exceeds 4096 entries".into());
    }
    let mut total = 0u64;
    let mut names = HashSet::new();
    for i in 0..archive.len() {
        let entry = archive.by_index(i)?;
        let relative = entry.name().strip_suffix('/').unwrap_or(entry.name());
        if !valid_resource(relative) || !names.insert(relative.to_ascii_lowercase()) {
            return Err("Invalid or duplicate plugin archive path".into());
        }
        let mode = entry.unix_mode().unwrap_or(0);
        if mode & 0o7000 != 0 || !matches!(mode & 0o170000, 0 | 0o100000 | 0o040000) {
            return Err(
                "Plugin contains symbolic links, special files or special permission bits".into(),
            );
        }
        total = total
            .checked_add(entry.size())
            .ok_or("Plugin size overflow")?;
        if entry.size() > MAX_FILE || total > MAX_TOTAL {
            return Err("Plugin exceeds extraction limits".into());
        }
    }
    if let Some(expected) = expected_entry {
        use sha2::{Digest, Sha256};
        let mut entry = archive.by_name("main.js")?;
        if entry.size() == 0 || entry.size() > 4 * 1024 * 1024 {
            return Err("Invalid plugin main.js size".into());
        }
        let mut script = Vec::new();
        entry
            .by_ref()
            .take(4 * 1024 * 1024 + 1)
            .read_to_end(&mut script)?;
        if format!("{:x}", Sha256::digest(&script)) != expected {
            return Err("Plugin changed after entry validation; select the package again".into());
        }
    }
    let info = archive.by_name("info.json")?;
    if info.size() > 64 * 1024 {
        return Err("Plugin info.json exceeds 64 KiB".into());
    }
    let value: Value = serde_json::from_reader(info)?;
    let kind = value["plugin_type"]
        .as_str()
        .filter(|s| valid_type(s))
        .ok_or("Invalid plugin category")?;
    let id = value["id"]
        .as_str()
        .filter(|s| valid_name(s))
        .ok_or("Invalid plugin ID")?;
    let parent = root.join(kind);
    no_links(&parent)?;
    fs::create_dir_all(&parent)?;
    // Serialize installs across windows/processes; persistent lock file carries no user data.
    no_links(&parent.join(".install.lock"))?;
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(parent.join(".install.lock"))?;
    fs2::FileExt::lock_exclusive(&lock)?;
    recover(&parent, name)?;
    let target = parent.join(name);
    no_links(&target)?;
    let backup = parent.join(format!(".{name}.previous"));
    no_links(&backup)?;
    if backup.exists() && !target.exists() {
        fs::rename(&backup, &target)?;
    }
    if name != id {
        if !target.is_dir() || metadata(&target, kind, name)?["id"].as_str() != Some(id) {
            return Err("Package name differs from info.id; restore its original filename. Legacy renamed upgrades must retain their existing directory and manifest ID".into());
        }
    } else if target.exists() && metadata(&target, kind, name)?["id"].as_str() != Some(id) {
        return Err("Upgrade changes manifest identity; existing configuration preserved".into());
    }
    let stage = parent.join(format!(
        ".install-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_nanos()
    ));
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new().mode(0o700).create(&stage)?;
    }
    #[cfg(not(unix))]
    fs::create_dir(&stage)?;
    let result = (|| -> Result<()> {
        // Private empty staging tree; bounded streaming also checks CRC before replacement.
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i)?;
            let destination = stage.join(entry.name());
            if entry.is_dir() {
                fs::create_dir_all(destination)?;
                continue;
            }
            fs::create_dir_all(destination.parent().ok_or("Missing parent")?)?;
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&destination)?;
            let copied = std::io::copy(&mut entry.by_ref().take(MAX_FILE + 1), &mut file)?;
            if copied > MAX_FILE || copied != entry.size() {
                return Err("Plugin entry size mismatch".into());
            }
            file.sync_all()?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(
                    &destination,
                    fs::Permissions::from_mode(entry.unix_mode().unwrap_or(0o644) & 0o777),
                )?;
            }
        }
        metadata(&stage, kind, name)?;
        if backup.exists() {
            fs::remove_dir_all(&backup)?;
        }
        let marker = parent.join(format!(".{name}.pending"));
        no_links(&marker)?;
        fs::write(&marker, b"replace")?;
        if target.exists() {
            fs::rename(&target, &backup)?;
        }
        if let Err(e) = fs::rename(&stage, &target) {
            if backup.exists() {
                fs::rename(&backup, &target)?;
            }
            return Err(e.into());
        }
        let _ = fs::remove_file(marker);
        // Keep one previous version for recovery; it is never discovered as a plugin.
        Ok(())
    })();
    if stage.exists() {
        let _ = fs::remove_dir_all(&stage);
    }
    result?;
    Ok(name.to_string())
}

pub fn install_many(
    root: &Path,
    paths: &[String],
    entry_checks: &std::collections::HashMap<String, String>,
) -> Vec<Value> {
    paths
        .iter()
        .map(|path| {
            let result = entry_checks
                .get(path)
                .ok_or_else(|| "Missing JavaScript entry validation".into())
                .and_then(|expected| install_checked(root, Path::new(path), Some(expected)));
            match result {
                Ok(id) => serde_json::json!({"path":path,"id":id,"success":true}),
                Err(error) => {
                    serde_json::json!({"path":path,"success":false,"error":error.to_string()})
                }
            }
        })
        .collect()
}

pub fn discover(root: &Path, kind: &str) -> Vec<String> {
    if !valid_type(kind) || no_links(&root.join(kind)).is_err() {
        return vec![];
    }
    let parent = root.join(kind);
    if parent.exists() {
        if no_links(&parent.join(".install.lock")).is_err() {
            return vec![];
        }
        let Ok(lock) = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(parent.join(".install.lock"))
        else {
            return vec![];
        };
        if fs2::FileExt::lock_exclusive(&lock).is_err() {
            return vec![];
        }
        if let Ok(entries) = fs::read_dir(&parent) {
            for entry in entries.flatten() {
                let file = entry.file_name();
                if let Some(name) = file
                    .to_str()
                    .and_then(|s| s.strip_prefix('.'))
                    .and_then(|s| s.strip_suffix(".pending"))
                {
                    if valid_name(name) {
                        let _ = recover(&parent, name);
                    }
                }
            }
        }
    }
    let Ok(entries) = fs::read_dir(root.join(kind)) else {
        return vec![];
    };
    entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_str()?.to_string();
            metadata(&e.path(), kind, &name).ok()?;
            Some(name)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    fn sandbox() -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "cup-plugin-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&p).unwrap();
        p.canonicalize().unwrap()
    }
    fn fixtures() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/plugins")
    }
    fn altered(source: &Path, dest: &Path, extra: &[(&str, &[u8], u32)]) {
        let mut archive = zip::ZipArchive::new(fs::File::open(source).unwrap()).unwrap();
        let mut writer = zip::ZipWriter::new(fs::File::create(dest).unwrap());
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).unwrap();
            if extra.iter().any(|(name, _, _)| *name == entry.name()) {
                continue;
            }
            writer
                .start_file(
                    entry.name(),
                    zip::write::SimpleFileOptions::default().unix_permissions(0o644),
                )
                .unwrap();
            std::io::copy(&mut entry, &mut writer).unwrap();
        }
        for (name, body, mode) in extra {
            writer
                .start_file(
                    *name,
                    zip::write::SimpleFileOptions::default().unix_permissions(*mode),
                )
                .unwrap();
            writer.write_all(body).unwrap();
        }
        writer.finish().unwrap();
        // ZipWriter masks special bits; patch real central-directory attributes to model hostile archives.
        let mut bytes = fs::read(dest).unwrap();
        let mut at = 0;
        while at + 46 <= bytes.len() {
            if &bytes[at..at + 4] != b"PK\x01\x02" {
                at += 1;
                continue;
            }
            let length = u16::from_le_bytes([bytes[at + 28], bytes[at + 29]]) as usize;
            let file_name = std::str::from_utf8(&bytes[at + 46..at + 46 + length]).unwrap();
            if let Some((_, _, mode)) = extra.iter().find(|(name, _, _)| *name == file_name) {
                bytes[at + 5] = 3;
                bytes[at + 38..at + 42].copy_from_slice(
                    &((if mode & 0o170000 == 0 {
                        0o100000 | *mode
                    } else {
                        *mode
                    }) << 16)
                        .to_le_bytes(),
                );
            }
            at += 46 + length;
        }
        fs::write(dest, bytes).unwrap();
    }
    #[test]
    fn all_four_types_install_discover_restore_config_execute_binary_and_uninstall() {
        let base = sandbox();
        let root = base.join("plugins");
        for kind in ["translate", "tts", "recognize", "collection"] {
            let id = format!("plugin.cup.fixture.{kind}");
            let package = fixtures().join("packages").join(format!("{id}.potext"));
            assert_eq!(install(&root, &package).unwrap(), id);
            let instance = format!("{id}@saved");
            let config =
                serde_json::json!({"list":[instance.clone()],instance.clone():{"prefix":"saved"}});
            fs::write(
                base.join("config.json"),
                serde_json::to_vec(&config).unwrap(),
            )
            .unwrap();
            assert_eq!(discover(&root, kind), vec![id.clone()]);
            let restored: Value =
                serde_json::from_slice(&fs::read(base.join("config.json")).unwrap()).unwrap();
            assert_eq!(restored[&instance]["prefix"], "saved");
            let directory = root.join(kind).join(&id);
            assert!(metadata(&directory, kind, &id).is_ok());
            if kind == "collection" {
                #[cfg(unix)]
                {
                    let executable = resource(&directory, "bin/record").unwrap();
                    let output = std::process::Command::new(executable)
                        .args(["saved", "hello", "你好"])
                        .output()
                        .unwrap();
                    assert!(output.status.success());
                    assert_eq!(
                        String::from_utf8(output.stdout).unwrap(),
                        "saved\nhello\n你好\n"
                    );
                }
            }
            let old = fs::read(directory.join("main.js")).unwrap();
            let broken = base.join(format!("{id}.potext"));
            altered(&package, &broken, &[("icon.svg", b"broken", 0o4755)]);
            assert!(install(&root, &broken).is_err());
            assert_eq!(fs::read(directory.join("main.js")).unwrap(), old);
            // A valid upgrade replaces the whole directory (no stale resources).
            fs::write(directory.join("obsolete"), "old").unwrap();
            install(&root, &package).unwrap();
            assert!(!directory.join("obsolete").exists());
            uninstall(&root, kind, &id).unwrap();
            assert!(!root.join(kind).join(format!(".{id}.previous")).exists());
            assert!(discover(&root, kind).is_empty());
        }
        fs::remove_dir_all(base).unwrap();
    }
    #[test]
    fn upstream_source_packages_with_dotted_ids_install_and_discover() {
        let base = sandbox();
        for (id, kind) in [
            ("plugin.com.pot-app.lingva_tts", "tts"),
            ("plugin.com.pot-app.anki", "collection"),
            ("plugin.com.pot-app.ecdict", "translate"),
        ] {
            assert!(valid_name(id));
            install(
                &base,
                &fixtures().join("packages").join(format!("{id}.potext")),
            )
            .unwrap();
            assert_eq!(discover(&base, kind), vec![id]);
        }
        fs::remove_dir_all(base).unwrap();
    }
    #[test]
    fn invalid_archives_preserve_old_version_and_never_write_outside_root() {
        let base = sandbox();
        let root = base.join("plugins");
        let id = "plugin.cup.fixture.translate";
        let original = fixtures().join("packages").join(format!("{id}.potext"));
        install(&root, &original).unwrap();
        let directory = root.join("translate").join(id);
        let old = fs::read(directory.join("main.js")).unwrap();
        let broken = base.join(format!("{id}.potext"));
        let invalid_info = serde_json::json!({"id":"plugin.other","plugin_type":"translate"});
        let invalid_info = serde_json::to_vec(&invalid_info).unwrap();
        for (name, bytes, mode) in [
            ("../escape", b"evil".as_slice(), 0o644),
            ("bin\\escape", b"evil".as_slice(), 0o644),
            ("C:/evil", b"evil".as_slice(), 0o644),
            ("CON.txt", b"evil".as_slice(), 0o644),
            ("icon.svg", b"bad".as_slice(), 0o4755),
            ("link", b"../outside".as_slice(), 0o120777),
            ("info.json", invalid_info.as_slice(), 0o644),
            ("main.js", b"".as_slice(), 0o644),
            ("icon.SVG", b"collision".as_slice(), 0o644),
        ] {
            altered(&original, &broken, &[(name, bytes, mode)]);
            assert!(install(&root, &broken).is_err(), "accepted {name}");
            assert_eq!(fs::read(directory.join("main.js")).unwrap(), old);
            assert!(!base.join("escape").exists());
        }
        fs::write(&broken, b"not zip").unwrap();
        assert!(install(&root, &broken).is_err());
        assert_eq!(fs::read(directory.join("main.js")).unwrap(), old);
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let external = base.join("external");
            fs::create_dir(&external).unwrap();
            let link = directory.join("linked");
            symlink(&external, &link).unwrap();
            assert!(resource(&directory, "linked/executable").is_err());
            fs::remove_file(link).unwrap();
            fs::rename(&directory, base.join("saved")).unwrap();
            symlink(&external, &directory).unwrap();
            assert!(install(&root, &original).is_err());
            assert!(discover(&root, "translate").is_empty());
        }
        fs::remove_dir_all(base).unwrap();
    }
    #[test]
    fn renamed_legacy_upgrade_keeps_directory_and_rejects_identity_changes() {
        let base = sandbox();
        let root = base.join("plugins");
        let id = "plugin.cup.fixture.translate";
        let original = fixtures().join("packages").join(format!("{id}.potext"));
        let renamed = base.join("plugin-old.potext");
        fs::copy(&original, &renamed).unwrap();
        assert!(install(&root, &renamed).is_err());
        install(&root, &original).unwrap();
        fs::rename(
            root.join("translate").join(id),
            root.join("translate/plugin-old"),
        )
        .unwrap();
        assert_eq!(install(&root, &renamed).unwrap(), "plugin-old");
        assert_eq!(discover(&root, "translate"), vec!["plugin-old"]);
        assert_eq!(
            metadata(
                &root.join("translate/plugin-old"),
                "translate",
                "plugin-old"
            )
            .unwrap()["id"],
            id
        );
        fs::remove_dir_all(base).unwrap();
    }
    #[test]
    fn batch_reports_each_package_and_crash_recovery_restores_previous_version() {
        let base = sandbox();
        let root = base.join("plugins");
        let good = fixtures().join("packages/plugin.cup.fixture.tts.potext");
        let bad = base.join("plugin-bad.potext");
        fs::write(&bad, b"broken").unwrap();
        let paths = vec![
            good.to_str().unwrap().to_string(),
            bad.to_str().unwrap().to_string(),
            fixtures()
                .join("packages/plugin.cup.fixture.translate.potext")
                .to_str()
                .unwrap()
                .to_string(),
        ];
        let checks = paths
            .iter()
            .filter_map(|path| {
                entry_info(Path::new(path))
                    .ok()
                    .map(|entry| (path.clone(), entry["digest"].as_str().unwrap().to_string()))
            })
            .collect();
        let results = install_many(&root, &paths, &checks);
        assert_eq!(
            results
                .iter()
                .map(|r| r["success"].as_bool().unwrap())
                .collect::<Vec<_>>(),
            vec![true, false, true]
        );
        assert!(results[1]["error"].is_string());
        let parent = root.join("tts");
        let id = "plugin.cup.fixture.tts";
        fs::rename(parent.join(id), parent.join(format!(".{id}.previous"))).unwrap();
        fs::write(parent.join(format!(".{id}.pending")), b"replace").unwrap();
        assert_eq!(discover(&root, "tts"), vec![id]);
        assert!(!parent.join(format!(".{id}.pending")).exists());
        fs::create_dir(parent.join("unknown-data")).unwrap();
        discover(&root, "tts");
        assert!(parent.join("unknown-data").exists());
        fs::remove_dir_all(base).unwrap();
    }
    #[test]
    fn rejects_invalid_metadata_missing_resources_and_excessive_entries() {
        let base = sandbox();
        let root = base.join("plugins");
        let id = "plugin.cup.fixture.translate";
        let original = fixtures().join("packages").join(format!("{id}.potext"));
        let broken = base.join(format!("{id}.potext"));
        let info: Value = serde_json::from_slice(
            &fs::read(fixtures().join("deterministic/translate/info.json")).unwrap(),
        )
        .unwrap();
        for (key, value) in [
            ("id", serde_json::json!("plugin.bad")),
            ("plugin_type", serde_json::json!("unknown")),
            ("icon", serde_json::json!("../escape.svg")),
            ("icon", serde_json::json!("missing.svg")),
            ("language", serde_json::json!([])),
            ("needs", serde_json::json!({})),
        ] {
            let mut bad = info.clone();
            bad[key] = value;
            altered(
                &original,
                &broken,
                &[("info.json", &serde_json::to_vec(&bad).unwrap(), 0o644)],
            );
            assert!(install(&root, &broken).is_err(), "accepted invalid {key}");
        }
        altered(
            &original,
            &broken,
            &[("info.json", &vec![b' '; 65537], 0o644)],
        );
        assert!(install(&root, &broken).is_err());
        let mut writer = zip::ZipWriter::new(fs::File::create(&broken).unwrap());
        for i in 0..4097 {
            writer
                .start_file(format!("file{i}"), zip::write::SimpleFileOptions::default())
                .unwrap();
        }
        writer.finish().unwrap();
        assert!(install(&root, &broken).is_err());
        fs::remove_dir_all(base).unwrap();
    }
    #[test]
    fn entry_digest_mismatch_and_archive_size_limits_preserve_installed_version() {
        let base = sandbox();
        let root = base.join("plugins");
        let id = "plugin.cup.fixture.translate";
        let original = fixtures().join("packages").join(format!("{id}.potext"));
        install(&root, &original).unwrap();
        let old = fs::read(root.join("translate").join(id).join("main.js")).unwrap();
        assert!(install_checked(&root, &original, Some("wrong-digest")).is_err());
        let checks = std::collections::HashMap::new();
        assert_eq!(
            install_many(&root, &[original.to_str().unwrap().to_string()], &checks)[0]["success"],
            false
        );
        let bad = base.join(format!("{id}.potext"));
        for size in [MAX_FILE + 1, 200 * 1024 * 1024] {
            let mut bytes = fs::read(&original).unwrap();
            let mut at = 0;
            while at + 46 <= bytes.len() {
                if &bytes[at..at + 4] == b"PK\x01\x02" {
                    bytes[at + 24..at + 28].copy_from_slice(&(size as u32).to_le_bytes());
                    at += 46;
                } else {
                    at += 1;
                }
            }
            fs::write(&bad, bytes).unwrap();
            let error = install(&root, &bad).unwrap_err().to_string();
            assert!(error.contains("extraction limits"), "{error}");
        }
        assert_eq!(
            fs::read(root.join("translate").join(id).join("main.js")).unwrap(),
            old
        );
        fs::remove_dir_all(base).unwrap();
    }
    #[test]
    fn portable_path_contract() {
        let cases: Value =
            serde_json::from_slice(&fs::read(fixtures().join("id-contract.json")).unwrap())
                .unwrap();
        for case in cases.as_array().unwrap() {
            assert_eq!(
                valid_name(case["id"].as_str().unwrap()),
                case["valid"].as_bool().unwrap()
            );
        }
        for good in [
            "plugin",
            "pluginA",
            "plugin-demo_2",
            "plugin.com.pot-app.anki",
        ] {
            assert!(valid_name(good));
        }
        for bad in [
            "plugin..x",
            "plugin.",
            "plugin/x",
            "plugin\\x",
            "plugin:x",
            "plugin x",
        ] {
            assert!(!valid_name(bad));
        }
        for bad in [
            "../x",
            "/x",
            "C:/x",
            "a/CON.txt",
            "a/lpt1.exe",
            "a/./b",
            "a//b",
            "a/b.",
        ] {
            assert!(!valid_resource(bad));
        }
    }
}
