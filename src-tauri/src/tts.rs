// 本地 TTS（开箱即用、零配置、离线）：
// 优先用 espeak-ng / espeak 合成 WAV 返回前端播放；
// 若系统只有 speech-dispatcher（spd-say），由它直接播报（此时返回空字节，前端解码为空即静默跳过）；
// 三者都找不到时给出可操作的错误提示（安装任一引擎或改用其他 TTS 服务）。
use std::process::Command;
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
fn voice_for(lang: &str) -> String {
    let primary = lang.to_lowercase().replace('_', "-");
    let primary = primary.split('-').next().unwrap_or("en");
    match primary {
        "zh" | "cmn" | "yue" => "cmn".to_string(),
        other => other.to_string(),
    }
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
            let wav_path =
                std::env::temp_dir().join(format!("cup-translate-tts-{}.wav", std::process::id()));
            let status = Command::new(engine)
                .args(["-v", &voice, "-w", &wav_path.to_string_lossy(), &text])
                .status()
                .map_err(|e| format!("调用 {engine} 失败: {e}"))?;
            if !status.success() {
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
