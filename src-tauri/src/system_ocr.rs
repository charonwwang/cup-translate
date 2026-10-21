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

/// 把随包 OCR 二进制的输出解释成识别结果（仅 macOS）。
///
/// 抽成纯函数是为了能单测：随包二进制在**出错时也返回 exit=0 且 stderr 为空**
/// （实测 `ocr-aarch64-apple-darwin /tmp/nonexistent.png en-US`
/// -> exit=0、stdout 空、stderr 空），于是原来的
/// `if output.status.success() { Ok(...) }` 会把「文件不存在」这种真错误
/// 报成 `Ok("")`。前端拿到空串后会 `setText('')` —— 界面一片空白、
/// **没有任何错误提示**，用户无法分辨「图里本来就没字」和「识别根本没跑起来」。
///
/// 注意「空结果」本身是合法的：图片里确实没有文字时输出也为空。
/// 因此这里**只看退出码**，不把空输出当成错误 —— 真正的歧义由调用方
/// 在 spawn 之前用文件存在性检查消除（文件不存在时不存在「本来就没字」的解释）。
fn interpret_ocr_output(
    status_success: bool,
    stdout: &[u8],
    stderr: &[u8],
) -> Result<String, String> {
    if status_success {
        Ok(String::from_utf8_lossy(stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(stderr).into_owned())
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

    // 随包二进制对「文件不存在」也返回 exit=0 + 空输出，光看退出码无法与
    // 「图里没有文字」区分。先做存在性检查：文件不在就一定不是「识别成功但没字」，
    // 而是真错误，应明确报出来而不是让界面空白。
    // 文件存在时本检查恒为真，正常路径行为完全不变。
    if !app_cache_dir_path.exists() {
        return Err("Screenshot file not found (was the screenshot taken?)".to_string());
    }

    ensure_executable(&bin_path)?;

    let output = match std::process::Command::new(bin_path)
        .arg(&app_cache_dir_path)
        .arg(lang)
        .output()
    {
        Ok(v) => v,
        Err(e) => return Err(e.to_string()),
    };

    interpret_ocr_output(output.status.success(), &output.stdout, &output.stderr)
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
        let content = String::from_utf8_lossy(&output.stdout).into_owned();
        Ok(content)
    } else {
        // 与 macOS 分支统一：用 lossy 解码而不是 `unwrap_or_default()`。
        // 后者遇到非法 UTF-8 会返回**空串**，于是下面的 `content.contains("data")`
        // 判断必然落空，用户只会看到一句空白的错误提示，失去了这里本来要给的
        // 「请安装 tesseract-ocr-<lang>」这条可操作指引。
        let content = String::from_utf8_lossy(&output.stderr).into_owned();

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

#[cfg(test)]
mod tests {
    use super::*;

    // 说明：本模块按平台 `cfg` 出三份 `system_ocr`，仅 macOS 分支的
    // `interpret_ocr_output` 是平台无关的纯函数，因此可以在这里直接单测。
    // 其余平台分支依赖真实外部程序（tesseract / Windows OCR API），
    // 本机无从实测，**没有**为它们编造断言。

    #[test]
    fn successful_nonempty_output_is_returned_as_is() {
        let got = interpret_ocr_output(true, "你好世界\n".as_bytes(), b"");
        assert_eq!(got, Ok("你好世界\n".to_string()));
    }

    /// 关键回归：随包二进制在「文件不存在」时也 exit=0 且输出全空。
    /// 此时 `interpret_ocr_output` 只能如实返回空串（空结果本身合法），
    /// 真正的歧义由调用方在 spawn 前的存在性检查消除 —— 这条测试固定住
    /// 「退出码成功 + 空输出 => Ok(空串)」这一契约，避免有人把它改成 Err
    /// 而误伤「图片里本来就没有文字」的正常情况。
    #[test]
    fn successful_empty_output_is_still_ok_not_an_error() {
        let got = interpret_ocr_output(true, b"", b"");
        assert_eq!(got, Ok(String::new()));
        assert!(
            got.is_ok(),
            "an image with no text must not be reported as an error"
        );
    }

    #[test]
    fn failure_returns_stderr() {
        let got = interpret_ocr_output(false, b"", b"something went wrong");
        assert_eq!(got, Err("something went wrong".to_string()));
    }

    #[test]
    fn failure_with_empty_stderr_returns_empty_error_not_ok() {
        let got = interpret_ocr_output(false, b"", b"");
        assert!(
            got.is_err(),
            "a nonzero exit must never be reported as success"
        );
    }

    /// 修复前用的是 `String::from_utf8(..).unwrap_or_default()`：遇到非法 UTF-8
    /// 会**静默变成空串**，把一段真实的识别结果丢掉且不报错。
    /// 现已改为 `from_utf8_lossy`，非法字节被替换而不是整段丢弃。
    #[test]
    fn invalid_utf8_is_not_silently_dropped() {
        // 合法 UTF-8 前缀 + 一个非法字节
        let mut bytes = "你好".as_bytes().to_vec();
        bytes.push(0xFF);
        let got = interpret_ocr_output(true, &bytes, b"").expect("must be Ok");
        assert!(
            !got.is_empty(),
            "invalid UTF-8 must not silently collapse the whole result to an empty string"
        );
        assert!(
            got.starts_with("你好"),
            "the valid prefix must be preserved, got {got:?}"
        );
        assert!(
            got.contains('\u{FFFD}'),
            "the bad byte should become U+FFFD, got {got:?}"
        );

        // 对照：旧行为（from_utf8 + unwrap_or_default）会得到空串
        let old = String::from_utf8(bytes).unwrap_or_default();
        assert!(old.is_empty(), "this documents the old, buggy behaviour");
    }

    #[test]
    fn stderr_is_also_decoded_lossily() {
        let mut bytes = "错误".as_bytes().to_vec();
        bytes.push(0xFE);
        let got = interpret_ocr_output(false, b"", &bytes);
        let err = got.expect_err("must be Err");
        assert!(err.starts_with("错误"), "got {err:?}");
        assert!(
            !err.is_empty(),
            "a corrupt stderr must not become an empty error message"
        );
    }

    /// `ensure_executable` 的语义测试（仅 macOS：该函数只在 macOS 分支存在）。
    ///
    /// 为什么值得测：仓库里的 `resources/ocr-*-apple-darwin` 权限是 **0644**，
    /// 直接 spawn 会 `Permission denied`。首次运行必须补 `+x`，而每次 OCR 都
    /// spawn 一次 `chmod` 是无谓开销，故用 `OnceLock<Mutex<HashSet>>` 按路径缓存。
    /// 这里有两条容易被写错的语义：
    ///   1. **失败绝不能写进缓存** —— 否则一次瞬时失败（如权限/路径问题）会被
    ///      永久记住，后续调用直接 `Ok(())` 放行,真正执行时才炸,且错误信息
    ///      完全指不到 chmod 上，极难排查;
    ///   2. 成功后同一路径**不应**重复 chmod。
    ///
    /// 每条测试都用**独占的临时路径**：缓存按路径索引，因此不会互相干扰，
    /// 也不依赖测试执行顺序（这是用静态缓存时最容易踩的坑）。
    /// `chmod` 只作用在临时文件上，不碰仓库资源。
    #[cfg(target_os = "macos")]
    mod ensure_executable_semantics {
        use super::*;

        /// 造一个独占的临时文件路径并创建它。
        fn unique_temp_file(tag: &str) -> std::path::PathBuf {
            let path = std::env::temp_dir().join(format!(
                "cup-translate-ocr-chmod-{}-{}-{tag}",
                std::process::id(),
                // 计数器保证同一进程内多次调用也不撞名
                {
                    use std::sync::atomic::{AtomicU32, Ordering};
                    static N: AtomicU32 = AtomicU32::new(0);
                    N.fetch_add(1, Ordering::Relaxed)
                }
            ));
            std::fs::write(&path, b"#!/bin/sh\nexit 0\n").expect("create temp file");
            path
        }

        /// 读权限位里的可执行标志（Unix 上取 owner execute）。
        fn is_executable(path: &std::path::Path) -> bool {
            use std::os::unix::fs::PermissionsExt;
            std::fs::metadata(path)
                .map(|m| m.permissions().mode() & 0o100 != 0)
                .unwrap_or(false)
        }

        #[test]
        fn makes_a_non_executable_file_executable() {
            let path = unique_temp_file("basic");
            // 先确保它是不可执行的（模拟仓库里的 0644）
            let mut perms = std::fs::metadata(&path).unwrap().permissions();
            use std::os::unix::fs::PermissionsExt;
            perms.set_mode(0o644);
            std::fs::set_permissions(&path, perms).unwrap();
            assert!(
                !is_executable(&path),
                "precondition: the file must start non-executable"
            );

            ensure_executable(&path).expect("chmod should succeed on our own temp file");
            assert!(
                is_executable(&path),
                "the file must be executable afterwards"
            );

            let _ = std::fs::remove_file(&path);
        }

        /// 关键回归：**chmod 失败时绝不能把它记进缓存**。
        ///
        /// 用一个不存在的路径触发失败；连续两次调用**都必须返回 Err**。
        /// 若有人误写成「先 insert 再 chmod」，第一次之后缓存就认为已就绪，
        /// 第二次会返回 `Ok(())` —— 这条断言就会失败。
        #[test]
        fn a_failed_chmod_is_not_cached_as_success() {
            let path = std::env::temp_dir().join(format!(
                "cup-translate-ocr-chmod-missing-{}-{}",
                std::process::id(),
                "definitely-absent"
            ));
            let _ = std::fs::remove_file(&path);
            assert!(!path.exists(), "precondition: the path must not exist");

            let first = ensure_executable(&path);
            assert!(
                first.is_err(),
                "chmod on a missing file must fail, got {first:?}"
            );

            // 第二次：若失败被错误地缓存成成功，这里会是 Ok，测试即失败
            let second = ensure_executable(&path);
            assert!(
                second.is_err(),
                "a failed chmod must not be cached as success; second call returned {second:?}"
            );
        }

        /// 成功后重复调用应当**幂等**（走缓存直接返回 Ok，不再 spawn chmod）。
        /// 这里只固定「结果正确」，不假定内部一定没 spawn ——
        /// 缓存命中与否属于实现细节，测行为而非测实现。
        #[test]
        fn repeated_calls_after_success_keep_succeeding() {
            let path = unique_temp_file("repeat");

            ensure_executable(&path).expect("first call");
            ensure_executable(&path).expect("second call must also succeed");
            ensure_executable(&path).expect("third call must also succeed");
            assert!(is_executable(&path), "the file must remain executable");

            let _ = std::fs::remove_file(&path);
        }
    }
}
