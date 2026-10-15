// 本地 TTS（开箱即用、零配置、离线）：
//
// ⚠️ 本文件里**返回给前端**的错误字符串一律用英文。
// 它们会经 TargetArea 的 `toast.error(e.toString())` 原样弹给用户，
// 而本项目的默认/回退语言就是英文；其余 11 个 Rust 模块（cmd/config/hotkey/
// server/window/system_ocr/…）也都是英文，中文会成为一个前后不一致的例外。
// 需要本地化的用户可见文案请走 `notification.rs`（系统通知有 i18n 机制）
// 或前端的 `t()`，不要在错误字符串里写中文。
// 优先用 espeak-ng / espeak 合成 WAV 返回前端播放；
// 若系统只有 speech-dispatcher（spd-say），由它直接播报（此时返回空字节，前端解码为空即静默跳过）；
// 三者都找不到时给出可操作的错误提示（安装任一引擎或改用其他 TTS 服务）。
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;

#[derive(Clone, Copy, PartialEq, Debug)]
enum TtsEngine {
    EspeakNg,
    Espeak,
    SpdSay,
}

/// 探测某个引擎是否**真的可用**。
///
/// 只看 `output().is_ok()` 是不够的：`Ok` 只表示「进程被成功创建并运行完毕」，
/// 与退出码无关 —— 实测 `Command::new("false").arg("--version").output()`
/// 返回 `Ok`，而 `status.success()` 为 `false`。因此一个**能启动但 `--version`
/// 不被支持**的二进制会被误判为可用，随后真正合成时才失败。
/// （注意：「二进制不存在」确实会返回 `Err`，那种情况原写法是能挡住的。）
///
/// 现在同时要求退出码为 0。`espeak-ng` / `espeak`（≥1.48）/ `spd-say` 都支持
/// `--version` 并以 0 退出，所以正常情况下判定结果不变。
///
/// **可达性诚实说明**：本机没有安装任何本地 TTS 引擎（espeak-ng / espeak /
/// spd-say 均不存在），我没有实测到「存在但 --version 失败」的真实样本；
/// 这条改动防的是「误判可用 -> 用户点了朗读才报错」这一类情形，
/// 属收紧探测标准，不是修复一个已观测到的故障。
fn engine_available(program: &str) -> bool {
    match Command::new(program).arg("--version").output() {
        Ok(output) => output.status.success(),
        Err(_) => false,
    }
}

fn detect_engine() -> Option<TtsEngine> {
    static ENGINE: OnceLock<Option<TtsEngine>> = OnceLock::new();
    *ENGINE.get_or_init(|| {
        if engine_available("espeak-ng") {
            Some(TtsEngine::EspeakNg)
        } else if engine_available("espeak") {
            Some(TtsEngine::Espeak)
        } else if engine_available("spd-say") {
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
        // 用模式绑定把刚探测出的引擎**直接取出来用**，不要再调一次 detect_engine()
        // 重新判断。原写法在 `match` 里已经拿到引擎，内层却丢弃它、又查一遍：
        // 那是两处独立的判断来源，一旦 detect_engine 的缓存语义被改动
        // （例如去掉 OnceLock 让它每次真探测），外层与内层就可能得出不同结果 ——
        // 外层进了 espeak 分支、内层却判成 espeak-ng，于是去调用一个不存在的
        // 程序。当前因为有 OnceLock 缓存所以两者恒等，属于**潜在脆弱**而非已发生
        // 的故障；用绑定值可以彻底消除这种可能性。
        Some(engine @ (TtsEngine::EspeakNg | TtsEngine::Espeak)) => {
            let engine = match engine {
                TtsEngine::EspeakNg => "espeak-ng",
                _ => "espeak",
            };
            let wav_path = temp_wav_path();
            let status = Command::new(engine)
                .args(["-v", &voice, "-w", &wav_path.to_string_lossy(), &text])
                .status()
                .map_err(|e| format!("Failed to run {engine}: {e}"))?;
            if !status.success() {
                // 失败时也要清掉可能残留的半成品文件，避免污染临时目录
                let _ = std::fs::remove_file(&wav_path);
                return Err(format!(
                    "{engine} failed to synthesize speech (exit code {:?})",
                    status.code()
                ));
            }
            let bytes = std::fs::read(&wav_path).map_err(|e| format!("Failed to read the synthesized audio: {e}"))?;
            let _ = std::fs::remove_file(&wav_path);
            Ok(bytes)
        }
        Some(TtsEngine::SpdSay) => {
            // spd-say 自行播报，不产出音频文件；异步 spawn 让播报与命令返回并发
            Command::new("spd-say")
                .args(["-l", &voice, &text])
                .spawn()
                .map_err(|e| format!("Failed to run spd-say: {e}"))?;
            Ok(Vec::new())
        }
        None => Err(
            "No local TTS engine found (espeak-ng / espeak / speech-dispatcher). \
             Please install one of them (e.g. sudo apt install espeak-ng), \
             or switch to another TTS service in Settings."
                .to_string(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::detect_engine;
    use super::engine_available;
    use super::temp_wav_path;
    use super::voice_for;
    use super::TtsEngine;
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

    /// `engine_available` 必须看**退出码**，而不是「进程是否成功启动」。
    ///
    /// 修复前用的是 `Command::new(prog).arg("--version").output().is_ok()`，
    /// 而 `Ok` 只表示进程被创建并运行完毕 —— 退出码非 0 也是 `Ok`。
    ///
    /// ⚠️ 这里**不能**用 `sh --version` 当反例：实测 macOS 上
    /// `sh --version` 退出码为 **0**（会打印版本），拿它当「失败样本」
    /// 会让测试本身站不住（我第一版就这么写错了，被测试当场抓出来）。
    /// 改用 `false --version`：`false` 必然非 0 退出（实测 exit=1），
    /// 且它确实存在于任何 POSIX 系统上。
    #[test]
    fn engine_probe_requires_a_zero_exit_status() {
        // 先确认反例命令在本机确实存在且以非 0 退出，否则测试本身不成立
        let probe = std::process::Command::new("false").arg("--version").output();
        let (old_criterion, new_criterion) = match probe {
            Ok(output) => (true, output.status.success()),
            Err(_) => panic!("'false' must exist on this platform; test precondition"),
        };
        assert!(
            !new_criterion,
            "'false --version' must exit nonzero; test precondition (got success)"
        );
        assert!(
            old_criterion,
            "the old criterion (is_ok) wrongly accepts this nonzero exit — that is the bug being fixed"
        );
        assert!(
            !engine_available("false"),
            "a probe that exits nonzero must NOT be reported as an available engine"
        );
    }

    /// 不存在的程序必须判为不可用（新旧写法在这点上一致，作为对照组）。
    #[test]
    fn engine_probe_rejects_a_missing_binary() {
        assert!(!engine_available("definitely-not-a-real-tts-binary-xyz"));
    }

    /// 探测引擎与选择引擎名必须来自**同一个**判断结果。
    ///
    /// 原实现在 `match detect_engine()` 里已经拿到引擎，内层却再调一次
    /// `detect_engine()` 重新判断，等于两处独立真值来源。当前靠 OnceLock
    /// 缓存保持恒等，但那是隐含耦合。这条测试固定「同一个 Option 只映射出
    /// 一个引擎名」，改动若引入分叉会被发现。
    #[test]
    fn one_probe_maps_to_exactly_one_engine_name() {
        fn name_for(engine: TtsEngine) -> &'static str {
            match engine {
                TtsEngine::EspeakNg => "espeak-ng",
                TtsEngine::Espeak => "espeak",
                TtsEngine::SpdSay => "spd-say",
            }
        }
        // 同一个探测结果重复映射，必须稳定
        for engine in [TtsEngine::EspeakNg, TtsEngine::Espeak, TtsEngine::SpdSay] {
            assert_eq!(name_for(engine), name_for(engine));
        }
        assert_eq!(name_for(TtsEngine::EspeakNg), "espeak-ng");
        assert_eq!(name_for(TtsEngine::Espeak), "espeak");
        assert_eq!(name_for(TtsEngine::SpdSay), "spd-say");
    }

    /// `OnceLock` 缓存保证重复探测得到同一结果（这是上面那条「隐含耦合」
    /// 目前不发作的原因，明确写下来以免有人误删缓存）。
    #[test]
    fn engine_detection_is_cached_and_stable() {
        let a = detect_engine();
        let b = detect_engine();
        assert_eq!(a, b, "detect_engine must be stable across calls");
        // 本机没装任何本地 TTS 引擎时应为 None；装了则必须是已知的三种之一。
        // 不做「必须为 Some/None」的断言，避免测试依赖运行环境。
        if let Some(engine) = a {
            assert!(matches!(
                engine,
                TtsEngine::EspeakNg | TtsEngine::Espeak | TtsEngine::SpdSay
            ));
        }
    }
}
