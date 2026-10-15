// 本地 TTS（开箱即用、零配置、离线）：
// 优先用 espeak-ng / espeak 合成 WAV 返回前端播放；
// 若系统只有 speech-dispatcher（spd-say），由它直接播报（此时返回空字节，前端解码为空即静默跳过）；
// 三者都找不到时给出可操作的错误提示（安装任一引擎或改用其他 TTS 服务）。
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;

#[derive(Clone, Copy)]
enum TtsEngine {
    EspeakNg,
    Espeak,
    SpdSay,
}

fn detect_engine() -> Option<TtsEngine> {
    static ENGINE: OnceLock<Option<TtsEngine>> = OnceLock::new();
    *ENGINE.get_or_init(|| {
        // 以 --version 试探二进制是否存在（不存在会报 NotFound）
        if Command::new("espeak-ng").arg("--version").output().is_ok() {
            Some(TtsEngine::EspeakNg)
        } else if Command::new("espeak").arg("--version").output().is_ok() {
            Some(TtsEngine::Espeak)
        } else if Command::new("spd-say").arg("--version").output().is_ok() {
            Some(TtsEngine::SpdSay)
        } else {
            None
        }
    })
}

/// 应用语言键 → espeak-ng 音色名（中文普通话在 espeak-ng 里叫 cmn）
///
/// 注意：`split('-').next()` 对空串返回 `Some("")` 而非 `None`，
/// 所以原先的 `unwrap_or("en")` 兜不住空值——空/纯空白的 lang 会被原样
/// 当作 espeak 音色名传下去，合成直接失败。这里显式校验后回退 en。
fn voice_for(lang: &str) -> String {
    let normalized = lang.trim().to_lowercase().replace('_', "-");
    let primary = normalized.split('-').next().unwrap_or("").trim();
    if primary.is_empty() {
        return "en".to_string();
    }
    match primary {
        "zh" | "cmn" | "yue" => "cmn".to_string(),
        other => other.to_string(),
    }
}

/// 合成音频的临时文件名计数器。
///
/// 只按 PID 命名是不够的：tts_speak 是 async 命令，前端「朗读」按钮可被连续点击
/// （换一句就再点一次），两次调用会并发执行。若共用同一个临时文件，
/// 后一次合成会写坏前一次正在读取的文件——表现为播放到错误/截断的音频，
/// 或者 remove_file 把别人正在读的文件删掉导致「读取合成音频失败」。
/// PID + 单调递增序号保证每次调用独占一个文件。
static TTS_TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

fn temp_wav_path() -> std::path::PathBuf {
    let seq = TTS_TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!(
        "cup-translate-tts-{}-{}.wav",
        std::process::id(),
        seq
    ))
}

#[tauri::command]
pub async fn tts_speak(text: String, lang: String) -> Result<Vec<u8>, String> {
    let voice = voice_for(&lang);
    match detect_engine() {
        Some(TtsEngine::EspeakNg) | Some(TtsEngine::Espeak) => {
            let engine = if matches!(detect_engine(), Some(TtsEngine::EspeakNg)) {
                "espeak-ng"
            } else {
                "espeak"
            };
            let wav_path = temp_wav_path();
            let status = Command::new(engine)
                .args(["-v", &voice, "-w", &wav_path.to_string_lossy(), &text])
                .status()
                .map_err(|e| format!("调用 {engine} 失败: {e}"))?;
            if !status.success() {
                // 失败时也要清掉可能残留的半成品文件，避免污染临时目录
                let _ = std::fs::remove_file(&wav_path);
                return Err(format!(
                    "{engine} 合成语音失败（退出码 {:?}）",
                    status.code()
                ));
            }
            let bytes = std::fs::read(&wav_path).map_err(|e| format!("读取合成音频失败: {e}"))?;
            let _ = std::fs::remove_file(&wav_path);
            Ok(bytes)
        }
        Some(TtsEngine::SpdSay) => {
            // spd-say 自行播报，不产出音频文件；异步 spawn 让播报与命令返回并发
            Command::new("spd-say")
                .args(["-l", &voice, &text])
                .spawn()
                .map_err(|e| format!("调用 spd-say 失败: {e}"))?;
            Ok(Vec::new())
        }
        None => Err(
            "未找到本地 TTS 引擎（espeak-ng / espeak / speech-dispatcher）。\
             请安装其中之一（如 sudo apt install espeak-ng），或在设置中改用其他 TTS 服务"
                .to_string(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::temp_wav_path;
    use super::voice_for;
    use std::collections::HashSet;

    #[test]
    fn concurrent_tts_calls_get_distinct_temp_files() {
        // 并发调用必须各自独占一个临时文件，否则会互相写坏/删除。
        let paths: HashSet<_> = (0..64).map(|_| temp_wav_path()).collect();
        assert_eq!(paths.len(), 64, "each call must get a unique temp path");
        for path in &paths {
            let name = path.file_name().unwrap().to_string_lossy().to_string();
            assert!(name.starts_with("cup-translate-tts-"));
            assert!(name.ends_with(".wav"));
        }
    }

    #[test]
    fn language_keys_map_to_espeak_voices() {
        assert_eq!(voice_for("zh_cn"), "cmn");
        assert_eq!(voice_for("zh_tw"), "cmn");
        assert_eq!(voice_for("yue"), "cmn");
        assert_eq!(voice_for("en"), "en");
        assert_eq!(voice_for("en-US"), "en");
        assert_eq!(voice_for("pt_br"), "pt");
        // 空值/纯空白必须回退 en：split('-').next() 对空串返回 Some("")，
        // 原实现会让空音色名传给 espeak，导致合成失败
        assert_eq!(voice_for(""), "en");
        assert_eq!(voice_for("   "), "en");
        assert_eq!(voice_for("-"), "en");
        // 大小写与连字符变体归一
        assert_eq!(voice_for("ZH_CN"), "cmn");
        assert_eq!(voice_for("EN-us"), "en");
    }
}
