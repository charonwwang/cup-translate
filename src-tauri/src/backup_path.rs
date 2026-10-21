use std::path::{Component, Path};

/// ZIP entry names use '/' on every platform. Build them from path components
/// rather than serializing the host's native separator.
pub(crate) fn archive_entry_name(path: &Path) -> Option<String> {
    let mut parts = Vec::new();
    for component in path.components() {
        let Component::Normal(part) = component else {
            return None;
        };
        let part = part.to_str()?;
        // A literal backslash in a Unix filename cannot round-trip on Windows.
        if part.contains('\\') {
            return None;
        }
        parts.push(part);
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("/"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_nested_paths_use_zip_separators() {
        let path = Path::new("plugins")
            .join("translate")
            .join("plugin-demo")
            .join("main.js");
        assert_eq!(
            archive_entry_name(&path).as_deref(),
            Some("plugins/translate/plugin-demo/main.js")
        );
    }

    #[test]
    fn unicode_plugin_names_are_preserved() {
        let path = Path::new("plugins").join("示例插件").join("main.js");
        assert_eq!(
            archive_entry_name(&path).as_deref(),
            Some("plugins/示例插件/main.js")
        );
    }

    #[test]
    fn non_relative_entries_are_rejected() {
        for path in [
            "",
            "/plugins/main.js",
            "plugins/../outside.js",
            "../config.json",
        ] {
            assert_eq!(archive_entry_name(Path::new(path)), None, "{path}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_native_separators_are_canonicalized() {
        assert_eq!(
            archive_entry_name(Path::new(r"plugins\translate\plugin-demo\main.js")).as_deref(),
            Some("plugins/translate/plugin-demo/main.js")
        );
    }

    #[cfg(unix)]
    #[test]
    fn non_portable_unix_names_are_rejected() {
        use std::{ffi::OsString, os::unix::ffi::OsStringExt};
        assert_eq!(archive_entry_name(Path::new(r"plugins\main.js")), None);
        assert_eq!(
            archive_entry_name(Path::new(&OsString::from_vec(vec![0xff]))),
            None
        );
    }
}
