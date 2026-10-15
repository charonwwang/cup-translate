use dirs::cache_dir;

#[tauri::command(async)]
#[cfg(target_os = "windows")]
pub fn system_ocr(app_handle: tauri::AppHandle, lang: &str) -> Result<String, String> {
    use windows::core::HSTRING;
    use windows::Globalization::Language;
    use windows::Graphics::Imaging::BitmapDecoder;
    use windows::Media::Ocr::OcrEngine;
    use windows::Storage::{FileAccessMode, StorageFile};

    let mut app_cache_dir_path = cache_dir().ok_or("Get Cache Dir Failed")?;
    app_cache_dir_path.push(&app_handle.config().tauri.bundle.identifier);
    app_cache_dir_path.push("pot_screenshot_cut.png");

    let path = app_cache_dir_path.to_string_lossy().replace("\\\\?\\", "");

    let file = StorageFile::GetFileFromPathAsync(&HSTRING::from(path))
        .map_err(|e| e.to_string())?
        .get()
        .map_err(|e| e.to_string())?;

    let bitmap = BitmapDecoder::CreateWithIdAsync(
        BitmapDecoder::PngDecoderId().map_err(|e| e.to_string())?,
        &file
            .OpenAsync(FileAccessMode::Read)
            .map_err(|e| e.to_string())?
            .get()
            .map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?
    .get()
    .map_err(|e| e.to_string())?;

    let bitmap = bitmap
        .GetSoftwareBitmapAsync()
        .map_err(|e| e.to_string())?
        .get()
        .map_err(|e| e.to_string())?;

    let engine = match lang {
        "auto" => OcrEngine::TryCreateFromUserProfileLanguages(),
        _ => {
            if let Ok(language) = Language::CreateLanguage(&HSTRING::from(lang)) {
                OcrEngine::TryCreateFromLanguage(&language)
            } else {
                return Err("Language Error".to_string());
            }
        }
    };

    match engine {
        Ok(v) => Ok(v
            .RecognizeAsync(&bitmap)
            .map_err(|e| e.to_string())?
            .get()
            .map_err(|e| e.to_string())?
            .Text()
            .map_err(|e| e.to_string())?
            .to_string_lossy()),
        Err(e) => {
            if e.to_string().contains("0x00000000") {
                Err("Language package not installed!\n\nSee: https://learn.microsoft.com/zh-cn/windows/powertoys/text-extractor#supported-languages".to_string())
            } else {
                Err(e.to_string())
            }
        }
    }
}

#[tauri::command(async)]
#[cfg(target_os = "macos")]
pub fn system_ocr(app_handle: tauri::AppHandle, lang: &str) -> Result<String, String> {
    let mut app_cache_dir_path = cache_dir().ok_or("Get Cache Dir Failed")?;
    app_cache_dir_path.push(&app_handle.config().tauri.bundle.identifier);
    app_cache_dir_path.push("pot_screenshot_cut.png");

    let arch = std::env::consts::ARCH;
    let bin_path = match app_handle
        .path_resolver()
        .resolve_resource(format!("resources/ocr-{arch}-apple-darwin"))
    {
        Some(v) => v,
        None => return Err("Failed to resolve ocr binary".to_string()),
    };

    ensure_executable(&bin_path)?;

    let output = match std::process::Command::new(bin_path)
        .arg(&app_cache_dir_path)
        .arg(lang)
        .output()
    {
        Ok(v) => v,
        Err(e) => return Err(e.to_string()),
    };

    if output.status.success() {
        let content = String::from_utf8(output.stdout).unwrap_or_default();
        Ok(content)
    } else {
        let content = String::from_utf8(output.stderr).unwrap_or_default();
        Err(content)
    }
}

/// 确保随包分发的 OCR 二进制可执行（仅 macOS）。
///
/// 仓库里该文件权限是 0644（见 `src-tauri/resources/ocr-*-apple-darwin`），
/// 因此首次运行必须补上 `+x`。但每次 OCR 调用都 spawn 一次 `chmod` 属于无谓开销，
/// 这里按路径缓存结果，每个路径只补一次。
#[cfg(target_os = "macos")]
fn ensure_executable(bin_path: &std::path::Path) -> Result<(), String> {
    use std::collections::HashSet;
    use std::sync::Mutex;
    use std::sync::OnceLock;

    static DONE: OnceLock<Mutex<HashSet<std::path::PathBuf>>> = OnceLock::new();
    let done = DONE.get_or_init(|| Mutex::new(HashSet::new()));

    let mut guard = match done.lock() {
        Ok(guard) => guard,
        // 锁中毒时退回「每次都 chmod」，功能不受影响
        Err(_) => return chmod_executable(bin_path),
    };
    if guard.contains(bin_path) {
        return Ok(());
    }
    chmod_executable(bin_path)?;
    guard.insert(bin_path.to_path_buf());
    Ok(())
}

#[cfg(target_os = "macos")]
fn chmod_executable(bin_path: &std::path::Path) -> Result<(), String> {
    match std::process::Command::new("chmod")
        .arg("+x")
        .arg(bin_path)
        .output()
    {
        Ok(status) if status.status.success() => Ok(()),
        Ok(status) => Err(format!(
            "Failed to make OCR binary executable: {}",
            status.status
        )),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command(async)]
#[cfg(target_os = "linux")]
pub fn system_ocr(app_handle: tauri::AppHandle, lang: &str) -> Result<String, String> {
    let mut app_cache_dir_path = cache_dir().ok_or("Get Cache Dir Failed")?;
    app_cache_dir_path.push(&app_handle.config().tauri.bundle.identifier);
    app_cache_dir_path.push("pot_screenshot_cut.png");
    let mut command = std::process::Command::new("tesseract");
    command.arg(&app_cache_dir_path).arg("stdout");
    if lang != "auto" {
        command.arg("-l").arg(lang);
    }

    let output = match command.output() {
        Ok(v) => v,
        Err(e) => {
            if e.to_string().contains("os error 2") {
                return Err("Tesseract not installed!".to_string());
            }
            return Err(e.to_string());
        }
    };
    if output.status.success() {
        let content = String::from_utf8(output.stdout).unwrap_or_default();
        Ok(content)
    } else {
        let content = String::from_utf8(output.stderr).unwrap_or_default();

        if content.contains("data") {
            if lang == "auto" {
                return Err(
                    "Language data not installed!\nPlease try install tesseract-ocr-eng"
                        .to_string(),
                );
            } else {
                return Err(format!(
                    "Language data not installed!\nPlease try install tesseract-ocr-{lang}"
                ));
            }
        }
        Err(content)
    }
}
