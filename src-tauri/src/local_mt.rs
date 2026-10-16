// 本地离线翻译（可选功能，不进默认引擎列表）：
//
// ⚠️ 本文件里**返回给前端**的错误字符串一律用英文，理由同 tts.rs：
// 它们会经 `toast.error(e.toString())` 原样弹给用户（例如模型下载失败），
// 而项目默认/回退语言是英文，其余 Rust 模块也都是英文。
// 需要本地化的文案请走前端的 `t()`。
// 例外：`license` 字段是**许可证署名元数据**（法律要求，必须准确），
// 且前端并不读它（用 `services.translate.local_mt.license_<pair>`），保留原文。
// 用 CTranslate2（ct2rs，内嵌 CT2 源码静态编译）跑 OPUS-MT en↔zh 的 CT2 int8 模型。
// 模型按需下载到 <app_config_dir>/models/<dir>/，不随包分发：
//   en→zh 派生自 Helsinki-NLP/opus-mt-en-zh（Apache-2.0）
//   zh→en 派生自 Helsinki-NLP/opus-mt-zh-en（CC-BY-4.0，界面已标注署名）
// 基准（docs/research/translation-engine-benchmark-2026.md）：79MB / 158MB 内存 / 106ms@4 线程 / BLEU 53.8
use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use ct2rs::tokenizers::auto::Tokenizer as AutoTokenizer;
use ct2rs::{ComputeType, Config as Ct2Config, Tokenizer, TranslationOptions};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::AppHandle;

struct MtTranslator {
    engine: ct2rs::sys::Translator,
    tokenizer: AutoTokenizer,
}

impl MtTranslator {
    fn new(path: &std::path::Path, config: &Ct2Config) -> Result<Self, String> {
        Ok(Self {
            engine: ct2rs::sys::Translator::new(path, config).map_err(|e| e.to_string())?,
            tokenizer: AutoTokenizer::new(path).map_err(|e| e.to_string())?,
        })
    }
}

/// 每个语向一个 CT2 模型目录
struct ModelSpec {
    dir_name: &'static str,
    repo: &'static str,
    revision: &'static str,
    /// 源句首部需要的目标语言 token：opus-mt-en-zh 必须给 `>>cmn_Hans<<`，zh-en 无前缀
    source_prefix: Option<&'static str>,
    license: &'static str,
    /// 文件名 -> 期望 SHA256（十六进制）。下载后逐个校验，防止传输损坏或镜像被篡改。
    expected_sha256: &'static [(&'static str, &'static str)],
}

/// 模型目录的完整文件清单（约 82MB，model.bin 占 79.6MB）。
///
/// **必须与每个 `ModelSpec::expected_sha256` 的文件名集合完全相等**，两个方向都有人用：
///   · 下载与 `local_mt_model_status` 只遍历这里
///     （`installed` = 这些文件都存在）
///   · `verify_model_checksums`（下载终检）只遍历 `expected_sha256`
///     （缺任一 -> `<file>: file is missing`）
/// 若 `expected_sha256` 多出一项，状态页会显示「已安装」，而下载/终检永远失败
/// ——那个文件从不会被下载，用户看到的只是一个含糊的 missing 报错。
/// 该契约由 `the_model_file_list_and_the_checksum_list_are_the_same_set` 守住
/// （实测：修复前给它加一个多余哈希项，全量测试仍然全绿）。
const MODEL_FILES: &[&str] = &[
    "config.json",
    "shared_vocabulary.json",
    "source.spm",
    "target.spm",
    "model.bin",
];

// 各文件的 SHA256（十六进制小写），下载后逐个硬校验，防止传输损坏或镜像被篡改：
// - 大文件（model.bin / source.spm / target.spm）：取自 HuggingFace 官方 API `tree/main`
//   返回的 `lfs.oid` 字段（即真实内容 SHA256）。
// - 小文件（config.json / shared_vocabulary.json）：非 LFS，`oid` 是 git blob 哈希不是
//   内容 SHA256，故改为实际下载后用 `shasum -a 256` 计算并硬编码。
const EN_ZH_MODEL_BIN_SHA256: &str =
    "327584c20bb83c7e89d595bcfa30b6ef3771c10816f707e892c4bbb1f808a8fb";
const EN_ZH_SOURCE_SPM_SHA256: &str =
    "5775ddc9e3ff2fae91554da56468ad35ff56edaba870fea74447bc7234bfdaa8";
const EN_ZH_TARGET_SPM_SHA256: &str =
    "81dc94efa84e4025ef38d25d5d07429fe41e3eb29d44003f1db6fe98487b0052";
const ZH_EN_MODEL_BIN_SHA256: &str =
    "e4955858cae9542bef37424a9b79720e3db2f32501fe62264c0cd3eac6319777";
const ZH_EN_SOURCE_SPM_SHA256: &str =
    "e27a3a1b539f4959ec72ea60e453f49156289f95d4e6000b29332efc45616203";
const ZH_EN_TARGET_SPM_SHA256: &str =
    "6a881f4717cd7265f53fea54fd3dc689c767c05338fac7a4590f3088cb2d7855";
const EN_ZH_CONFIG_JSON_SHA256: &str =
    "8f6496adfc930cbfecbe8281112197705c488fab47d34b4829b06d7f478909af";
const EN_ZH_SHARED_VOCAB_SHA256: &str =
    "37314a6abb25ed8f8497498aeeb31fcea98de892bf00ff7c2e8c966b26fe0b82";
const ZH_EN_CONFIG_JSON_SHA256: &str =
    "8f6496adfc930cbfecbe8281112197705c488fab47d34b4829b06d7f478909af";
const ZH_EN_SHARED_VOCAB_SHA256: &str =
    "acbf13516c56af2bb78ebdb770c2e4648fd8232ddd17af75298119cbfa7ee33d";

fn model_spec(pair: &str) -> Result<ModelSpec, String> {
    match pair {
        "en-zh" => Ok(ModelSpec {
            dir_name: "opus-mt-en-zh-ct2",
            repo: "jiangzhuo9357/opus-mt-en-zh-ct2",
            revision: "06fb49e2f6cb0485043ae703a4c2afddd4e700d7",
            source_prefix: Some(">>cmn_Hans<<"),
            license: "Apache-2.0 (Helsinki-NLP/opus-mt-en-zh)",
            expected_sha256: &[
                ("config.json", EN_ZH_CONFIG_JSON_SHA256),
                ("shared_vocabulary.json", EN_ZH_SHARED_VOCAB_SHA256),
                ("model.bin", EN_ZH_MODEL_BIN_SHA256),
                ("source.spm", EN_ZH_SOURCE_SPM_SHA256),
                ("target.spm", EN_ZH_TARGET_SPM_SHA256),
            ],
        }),
        "zh-en" => Ok(ModelSpec {
            dir_name: "opus-mt-zh-en-ct2",
            repo: "jiangzhuo9357/opus-mt-zh-en-ct2",
            revision: "b9f5527123795289acc264489cbd4927801601d7",
            source_prefix: None,
            license: "CC-BY-4.0 (Helsinki-NLP/opus-mt-zh-en，译文需署名 Helsinki-NLP / OPUS-MT)",
            expected_sha256: &[
                ("config.json", ZH_EN_CONFIG_JSON_SHA256),
                ("shared_vocabulary.json", ZH_EN_SHARED_VOCAB_SHA256),
                ("model.bin", ZH_EN_MODEL_BIN_SHA256),
                ("source.spm", ZH_EN_SOURCE_SPM_SHA256),
                ("target.spm", ZH_EN_TARGET_SPM_SHA256),
            ],
        }),
        _ => Err(format!(
            "Unsupported language pair: {pair} (local offline translation only supports en-zh / zh-en)"
        )),
    }
}

/// 计算文件 SHA256（十六进制小写），流式读取避免大文件全量加载进内存
fn file_sha256(path: &std::path::Path) -> Result<String, String> {
    use std::io::Read;
    let file =
        std::fs::File::open(path).map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
    let mut reader = std::io::BufReader::new(file);
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = reader
            .read(&mut buf)
            .map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let digest = hasher.finalize();
    Ok(digest.iter().map(|b| format!("{b:02x}")).collect())
}

/// 校验模型目录中所有「有期望哈希」的文件；返回不匹配的文件列表（空表示全部通过）
fn verify_model_checksums(dir: &std::path::Path, spec: &ModelSpec) -> Vec<String> {
    spec.expected_sha256
        .iter()
        .filter_map(|(file, expected)| {
            let path = dir.join(file);
            if !path.is_file() {
                return Some(format!("{file}: file is missing"));
            }
            match file_sha256(&path) {
                Ok(actual) if actual.eq_ignore_ascii_case(expected) => None,
                Ok(actual) => Some(format!(
                    "{file}: SHA256 mismatch (expected {expected}, got {actual})"
                )),
                Err(e) => Some(format!("{file}: {e}")),
            }
        })
        .collect()
}

fn model_dir(app_handle: &AppHandle, pair: &str) -> Result<PathBuf, String> {
    let spec = model_spec(pair)?;
    Ok(app_handle
        .path_resolver()
        .app_config_dir()
        .ok_or_else(|| "cannot resolve app config dir".to_string())?
        .join("models")
        .join(spec.dir_name))
}

/// 线程数的合理上界。
///
/// `threads` 来自设置页的自由文本输入（`local_mt/Config.jsx` 只做 parseInt，
/// 没有范围校验），因此后端必须自己夹紧。原先只做 `threads.max(1)` 挡下界，
/// 上界不设限：用户把输入框误填成 `999999`（或粘贴了一长串数字）会直接传进
/// CTranslate2 作为 `num_threads_per_replica`，导致线程数爆炸、推理卡死。
/// 64 远超任何桌面 CPU 的物理核心数，作为兜底上界足够宽松。
const MAX_MT_THREADS: usize = 64;

/// 把前端传来的线程数夹到 [1, MAX_MT_THREADS]。
///
/// 注意 `unwrap_or(2)` 之前发生在 `as usize` 之前，而类型是 u32，
/// 所以负数在反序列化阶段就被 Tauri 拒绝，不存在 `-1 as usize` 的回绕问题；
/// 这里只需处理后端可信范围内的越界值。
fn clamp_threads(threads: Option<u32>) -> usize {
    let requested = threads.unwrap_or(2) as usize;
    requested.clamp(1, MAX_MT_THREADS)
}

/// Translator 加载较慢（约 1~2 秒），按语向缓存复用；线程数变化时重建。
///
/// 每个语向只保留**一个**缓存项：模型是 80MB 级别的重对象，
/// 若按 (pair, threads) 组合缓存，用户每改一次线程数就会多留一份模型在内存里
/// 且永不释放。线程数变化时直接替换旧项，旧的 Arc 在没有在途请求后即被释放。
/// 缓存项：已加载的 translator 及其线程数（线程数变化时需要重建）
struct CachedTranslator {
    threads: usize,
    translator: Arc<MtTranslator>,
    last_used: Instant,
}
const MODEL_IDLE_TIMEOUT: Duration = Duration::from_secs(120);

fn should_evict(idle: Duration, references: usize) -> bool {
    idle >= MODEL_IDLE_TIMEOUT && references == 1
}

fn start_cache_reaper() {
    static STARTED: OnceLock<()> = OnceLock::new();
    STARTED.get_or_init(|| {
        std::thread::spawn(|| loop {
            std::thread::sleep(Duration::from_secs(30));
            if let Ok(mut cache) = translator_cache().lock() {
                cache.retain(|_, entry| {
                    !should_evict(
                        entry.last_used.elapsed(),
                        Arc::strong_count(&entry.translator),
                    )
                });
            }
        });
    });
}

fn translator_cache() -> &'static Mutex<HashMap<String, CachedTranslator>> {
    static CACHE: OnceLock<Mutex<HashMap<String, CachedTranslator>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 防止同一模型并发下载/删除（双击下载按钮或下载与删除竞态会写坏 model.bin）。
/// 值为 ()，仅用 key 存在与否表示「正在下载」。
fn download_lock() -> &'static Mutex<HashMap<String, ()>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, ()>>> = OnceLock::new();
    LOCKS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// RAII 守卫：持有期间该 pair 处于下载中状态，Drop 时自动释放
struct DownloadGuard {
    pair: String,
}

impl DownloadGuard {
    fn acquire(pair: &str) -> Result<Self, String> {
        let mut locks = download_lock().lock().map_err(|e| e.to_string())?;
        if locks.contains_key(pair) {
            return Err(format!(
                "{pair} model is being downloaded/removed, please retry shortly"
            ));
        }
        locks.insert(pair.to_string(), ());
        Ok(Self {
            pair: pair.to_string(),
        })
    }
}

impl Drop for DownloadGuard {
    fn drop(&mut self) {
        if let Ok(mut locks) = download_lock().lock() {
            locks.remove(&self.pair);
        }
    }
}

#[tauri::command]
pub async fn local_mt_model_status(app_handle: AppHandle, pair: String) -> Result<Value, String> {
    let spec = model_spec(&pair)?;
    let dir = model_dir(&app_handle, &pair)?;
    let missing: Vec<&str> = MODEL_FILES
        .iter()
        .copied()
        .filter(|f| !dir.join(f).is_file())
        .collect();
    Ok(json!({
        "pair": pair,
        "installed": missing.is_empty(),
        "loaded": translator_cache().try_lock().map(|cache| cache.contains_key(&pair)).unwrap_or(false),
        "missing": missing,
        "license": spec.license,
        "dir": dir.display().to_string(),
    }))
}

#[tauri::command]
pub async fn local_mt_download_model(app_handle: AppHandle, pair: String) -> Result<(), String> {
    let _guard = DownloadGuard::acquire(&pair)?;
    let spec = model_spec(&pair)?;
    let dir = model_dir(&app_handle, &pair)?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create the model directory: {e}"))?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(900))
        .build()
        .map_err(|e| e.to_string())?;
    let expected: std::collections::HashMap<&str, &str> =
        spec.expected_sha256.iter().copied().collect();
    for file in MODEL_FILES {
        let dest = dir.join(file);
        // 已存在的文件也要校验：防止历史版本下载损坏或被篡改的旧文件被直接复用
        if dest.is_file() {
            if let Some(sha) = expected.get(file) {
                match file_sha256(&dest) {
                    Ok(actual) if actual.eq_ignore_ascii_case(sha) => continue,
                    Ok(_) | Err(_) => {
                        log::warn!(
                            "[local_mt] {file} exists but failed verification, re-downloading"
                        );
                        let _ = std::fs::remove_file(&dest);
                    }
                }
            } else {
                continue;
            }
        }
        // huggingface 直连与 hf-mirror 镜像二选一（中国大陆网络通常只有镜像可达）
        let mut last_err = String::new();
        let mut done = false;
        'download_loop: for base in ["https://huggingface.co", "https://hf-mirror.com"] {
            let url = format!("{}/{}/resolve/{}/{}", base, spec.repo, spec.revision, file);
            log::info!("[local_mt] downloading {url}");
            match client.get(&url).send().await {
                Ok(mut resp) if resp.status().is_success() => {
                    // 流式写入磁盘：resp.bytes() 会把整个文件（model.bin 80MB）
                    // 加载进内存，用 chunk() 分块写入避免内存峰值
                    let partial = dest.with_extension("part");
                    let mut dest_file = std::fs::File::create(&partial)
                        .map_err(|e| format!("Failed to create {file}: {e}"))?;
                    let mut total: u64 = 0;
                    loop {
                        match resp.chunk().await {
                            Ok(Some(chunk)) => {
                                dest_file
                                    .write_all(&chunk)
                                    .map_err(|e| format!("Failed to write {file}: {e}"))?;
                                total += chunk.len() as u64;
                            }
                            Ok(None) => break,
                            Err(e) => {
                                last_err = format!("{url}: {e}");
                                let _ = std::fs::remove_file(&partial);
                                continue 'download_loop;
                            }
                        }
                    }
                    log::info!("[local_mt] downloaded {} ({} bytes)", file, total);
                    // 下载后立即校验 SHA256；不匹配则视为本次下载失败，尝试下一个镜像
                    if let Some(sha) = expected.get(file) {
                        match file_sha256(&partial) {
                            Ok(actual) if actual.eq_ignore_ascii_case(sha) => {}
                            Ok(actual) => {
                                last_err = format!(
                                    "{url}: SHA256 mismatch (expected {sha}, got {actual}); the mirror may be tampered with or the transfer corrupted"
                                );
                                let _ = std::fs::remove_file(&partial);
                                continue;
                            }
                            Err(e) => {
                                last_err = format!("{url}: verification failed: {e}");
                                let _ = std::fs::remove_file(&partial);
                                continue;
                            }
                        }
                    }
                    drop(dest_file);
                    std::fs::rename(&partial, &dest)
                        .map_err(|e| format!("Failed to install {file}: {e}"))?;
                    done = true;
                    break;
                }
                Ok(resp) => last_err = format!("{url}: HTTP {}", resp.status()),
                Err(e) => last_err = format!("{url}: {e}"),
            }
        }
        if !done {
            return Err(format!(
                "Failed to download {file} (neither huggingface.co nor hf-mirror.com is reachable): {last_err}"
            ));
        }
    }
    // 全部文件就绪后做一次整目录终检，兜底「单文件校验通过但目录整体损坏」的边界情况
    let bad = verify_model_checksums(&dir, &spec);
    if !bad.is_empty() {
        return Err(format!("Model integrity check failed: {}", bad.join("; ")));
    }
    Ok(())
}

#[tauri::command]
pub async fn local_mt_delete_model(app_handle: AppHandle, pair: String) -> Result<(), String> {
    let _guard = DownloadGuard::acquire(&pair)?;
    let dir = model_dir(&app_handle, &pair)?;
    translator_cache()
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&pair);
    if dir.is_dir() {
        std::fs::remove_dir_all(&dir)
            .map_err(|e| format!("Failed to remove the model directory: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn local_mt_unload_model(pair: String) -> Result<(), String> {
    model_spec(&pair)?;
    tauri::async_runtime::spawn_blocking(move || {
        translator_cache()
            .lock()
            .map_err(|error| error.to_string())?
            .remove(&pair);
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

fn load_translator(
    app_handle: &AppHandle,
    pair: &str,
    threads: usize,
) -> Result<Arc<MtTranslator>, String> {
    start_cache_reaper();
    // Keep a single load in progress. The caller runs on the blocking pool, so
    // loading here cannot stall the async runtime or duplicate the same model.
    let mut cache = translator_cache().lock().map_err(|e| e.to_string())?;
    if let Some(entry) = cache.get_mut(pair) {
        if entry.threads == threads {
            entry.last_used = Instant::now();
            return Ok(Arc::clone(&entry.translator));
        }
    }
    // Drop the old configuration before allocating replacement model weights.
    cache.remove(pair);
    let dir = model_dir(app_handle, pair)?;
    let missing: Vec<&str> = MODEL_FILES
        .iter()
        .copied()
        .filter(|f| !dir.join(f).is_file())
        .collect();
    if !missing.is_empty() {
        return Err(format!(
            "Local offline translation model is not downloaded (missing {}). Please download it in Settings -> Translation Services -> Local Offline Translation.",
            missing.join(", ")
        ));
    }
    let config = Ct2Config {
        // 模型已按 int8 量化，DEFAULT 保持量化精度推理（等价 Python 基准的 compute_type='int8'）
        compute_type: ComputeType::DEFAULT,
        num_threads_per_replica: threads.max(1),
        max_queued_batches: 1,
        ..Ct2Config::default()
    };
    let translator = MtTranslator::new(&dir, &config)
        .map_err(|e| format!("Failed to load the translation model: {e}"))?;
    let translator = Arc::new(translator);
    cache.insert(
        pair.to_string(),
        CachedTranslator {
            threads,
            translator: Arc::clone(&translator),
            last_used: Instant::now(),
        },
    );
    Ok(translator)
}

// Bounded chunks avoid silently dropping the end of a long paragraph at CT2's
// default input/output token limits. Break on sentence/word boundaries when possible.
fn split_for_translation(text: &str, max_chars: usize) -> Vec<&str> {
    let mut chunks = Vec::new();
    let mut remaining = text;
    let limit = max_chars.max(1);
    while remaining.chars().count() > limit {
        let hard_end = remaining.char_indices().nth(limit).map(|(i, _)| i).unwrap();
        let preferred = remaining[..hard_end]
            .char_indices()
            .filter(|(_, c)| {
                c.is_whitespace() || matches!(c, '.' | '!' | '?' | '。' | '！' | '？' | ';' | '；')
            })
            .map(|(i, c)| i + c.len_utf8())
            .last()
            .filter(|i| remaining[..*i].chars().count() >= limit / 2);
        let end = preferred.unwrap_or(hard_end);
        chunks.push(&remaining[..end]);
        remaining = &remaining[end..];
    }
    if !remaining.is_empty() {
        chunks.push(remaining);
    }
    chunks
}

fn beam_size(quality: Option<&str>) -> usize {
    match quality {
        Some("fast") => 1,
        Some("thorough") => 5,
        _ => 2,
    }
}

fn prepend_language_marker(mut tokens: Vec<String>, marker: Option<&str>) -> Vec<String> {
    if let Some(marker) = marker {
        tokens.insert(0, marker.to_string());
    }
    tokens
}

fn has_private_use(text: &str) -> bool {
    text.chars()
        .any(|c| matches!(c as u32, 0xE000..=0xF8FF | 0xF0000..=0xFFFFD | 0x100000..=0x10FFFD))
}

fn translate_with_model(
    translator: &MtTranslator,
    pair: &str,
    text: &str,
    quality: Option<&str>,
) -> Result<String, String> {
    let spec = model_spec(pair)?;
    let options = TranslationOptions::<String, String> {
        beam_size: beam_size(quality),
        max_input_length: 0,
        max_decoding_length: 512,
        max_batch_size: 1,
        ..Default::default()
    };
    let mut paragraphs = Vec::new();
    for line in text.lines() {
        let mut translated_chunks = Vec::new();
        for chunk in split_for_translation(line, 200) {
            if chunk.trim().is_empty() {
                continue;
            }
            let tokens = prepend_language_marker(
                translator
                    .tokenizer
                    .encode(chunk.trim())
                    .map_err(|e| format!("Tokenization failed: {e}"))?,
                spec.source_prefix,
            );
            // OPUS needs the marker in source tokens, never forced decoder output.
            let decode = |options: &TranslationOptions<String, String>| -> Result<String, String> {
                let results = translator
                    .engine
                    .translate_batch(&[tokens.clone()], options, None)
                    .map_err(|e| format!("Local translation failed: {e}"))?;
                let hypothesis = results
                    .into_iter()
                    .next()
                    .and_then(|result| result.hypotheses.into_iter().next())
                    .ok_or_else(|| "Local translation returned no result".to_string())?;
                translator
                    .tokenizer
                    .decode(hypothesis)
                    .map_err(|e| format!("Detokenization failed: {e}"))
            };
            let mut first = decode(&options)?;
            if has_private_use(&first) && !has_private_use(chunk) && options.beam_size < 5 {
                let fallback = TranslationOptions {
                    beam_size: if options.beam_size == 1 { 2 } else { 5 },
                    ..options.clone()
                };
                first = decode(&fallback)?;
            }
            translated_chunks.push(first);
        }
        paragraphs.push(translated_chunks.join(if pair == "zh-en" { " " } else { "" }));
    }
    Ok(paragraphs.join("\n"))
}

#[tauri::command]
pub async fn local_mt_translate(
    app_handle: AppHandle,
    pair: String,
    text: String,
    threads: Option<u32>,
    quality: Option<String>,
) -> Result<String, String> {
    model_spec(&pair)?;
    if text.trim().is_empty() {
        return Ok(String::new());
    }
    if text.chars().count() > 20_000 {
        return Err("Local translation accepts at most 20000 characters per request".into());
    }
    // Queue asynchronously, instead of filling the blocking pool with waiting
    // inference calls. Only one local inference runs at a time across directions.
    static GATE: OnceLock<tauri::async_runtime::Mutex<()>> = OnceLock::new();
    let _permit = GATE
        .get_or_init(|| tauri::async_runtime::Mutex::new(()))
        .lock()
        .await;
    tauri::async_runtime::spawn_blocking(move || {
        let translator = load_translator(&app_handle, &pair, clamp_threads(threads))?;
        let output = translate_with_model(&translator, &pair, &text, quality.as_deref())?;
        if let Ok(mut cache) = translator_cache().lock() {
            if let Some(entry) = cache.get_mut(&pair) {
                entry.last_used = Instant::now();
            }
        }
        Ok(output)
    })
    .await
    .map_err(|e| format!("Local translation worker failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::{
        clamp_threads, file_sha256, model_spec, verify_model_checksums, ModelSpec, MAX_MT_THREADS,
    };
    use std::path::PathBuf;

    #[test]
    fn opus_language_marker_is_a_source_token_and_keeps_the_eos() {
        let tokens = vec!["Hello".to_string(), "</s>".to_string()];
        assert_eq!(
            super::prepend_language_marker(tokens.clone(), Some(">>cmn_Hans<<")),
            vec![">>cmn_Hans<<", "Hello", "</s>"]
        );
        assert_eq!(super::prepend_language_marker(tokens.clone(), None), tokens);
        assert!(super::has_private_use("\u{e05f}"));
        assert!(!super::has_private_use("你好，世界"));
    }

    #[test]
    #[ignore = "requires a verified model directory in CUP_MT_MODEL_DIR"]
    fn benchmark_local_model() {
        let dir = std::env::var("CUP_MT_MODEL_DIR").expect("set CUP_MT_MODEL_DIR");
        let spec = model_spec("en-zh").unwrap();
        assert!(verify_model_checksums(std::path::Path::new(&dir), &spec).is_empty());
        let start = std::time::Instant::now();
        let translator = super::MtTranslator::new(
            std::path::Path::new(&dir),
            &super::Ct2Config {
                num_threads_per_replica: 2,
                ..Default::default()
            },
        )
        .unwrap();
        println!(
            "BENCH {}",
            serde_json::json!({"load_ms":start.elapsed().as_secs_f64()*1000.0})
        );
        let samples = [
            "Hello, world.",
            "Please do not close this window.",
            "The request timed out. Please try again later.",
            "She carefully documented the intermittent memory leak before filing the bug report.",
            "The meeting has been postponed until next Friday.",
            "I used to live here, but I don't anymore.",
            "The model is loaded only when needed and released after two minutes of inactivity.",
            "Translate the selected text, not the previous clipboard contents.",
            "Version 3.0.7 fixes 12 issues and uses 2 worker threads.",
            "Your data stays on this device.",
        ];
        for mode in ["fast", "balanced", "thorough"] {
            for source in samples {
                let start = std::time::Instant::now();
                let output =
                    super::translate_with_model(&translator, "en-zh", source, Some(mode)).unwrap();
                println!(
                    "BENCH {}",
                    serde_json::json!({"mode":mode,"source":source,"output":output,"ms":start.elapsed().as_secs_f64()*1000.0})
                );
            }
        }
    }

    #[test]
    fn chunking_preserves_all_unicode_input_and_bounds_each_chunk() {
        for text in [
            "你好。English words and emoji 🦀🦀，这是一个长句。".repeat(20),
            "a".repeat(999),
            "短句".into(),
        ] {
            let chunks = super::split_for_translation(&text, 40);
            assert_eq!(chunks.concat(), text);
            assert!(chunks.iter().all(|chunk| chunk.chars().count() <= 40));
        }
        assert!(super::split_for_translation("", 200).is_empty());
    }

    #[test]
    fn active_model_references_are_never_evicted() {
        assert!(!super::should_evict(std::time::Duration::from_secs(119), 1));
        assert!(!super::should_evict(std::time::Duration::from_secs(121), 2));
        assert!(super::should_evict(std::time::Duration::from_secs(121), 1));
    }

    #[test]
    fn decoding_modes_keep_the_previous_default() {
        assert_eq!(super::beam_size(None), 2);
        assert_eq!(super::beam_size(Some("balanced")), 2);
        assert_eq!(super::beam_size(Some("fast")), 1);
        assert_eq!(super::beam_size(Some("thorough")), 5);
    }

    #[test]
    fn requested_threads_are_clamped_to_a_sane_range() {
        // 设置页的线程数是自由文本输入（只做 parseInt，无范围校验），
        // 后端必须自己夹紧，否则 999999 会直接传进 CTranslate2。
        assert_eq!(clamp_threads(Some(999_999)), MAX_MT_THREADS);
        assert_eq!(clamp_threads(Some(u32::MAX)), MAX_MT_THREADS);
        assert_eq!(clamp_threads(Some(65)), MAX_MT_THREADS);
        assert_eq!(clamp_threads(Some(64)), 64);

        // 0 表示「未设置/无意义」，回落到最小可用值 1，而不是 0 线程
        assert_eq!(clamp_threads(Some(0)), 1);
        assert_eq!(clamp_threads(Some(1)), 1);

        // 正常值原样保留；None 用默认 2（与前端默认值一致）
        assert_eq!(clamp_threads(Some(2)), 2);
        assert_eq!(clamp_threads(Some(8)), 8);
        assert_eq!(clamp_threads(None), 2);

        // 不变量：结果永远落在合法区间内
        for requested in [0u32, 1, 2, 4, 64, 65, 1000, u32::MAX] {
            let actual = clamp_threads(Some(requested));
            assert!(
                (1..=MAX_MT_THREADS).contains(&actual),
                "threads {requested} clamped to {actual}, outside [1, {MAX_MT_THREADS}]"
            );
        }
    }

    #[test]
    fn download_guard_prevents_concurrent_access_to_same_pair() {
        // 同一 pair 不允许并发持有
        let guard = super::DownloadGuard::acquire("en-zh").unwrap();
        assert!(super::DownloadGuard::acquire("en-zh").is_err());
        // 不同 pair 不受影响
        assert!(super::DownloadGuard::acquire("zh-en").is_ok());
        drop(guard);
        // 释放后可重新获取
        assert!(super::DownloadGuard::acquire("en-zh").is_ok());
    }

    #[test]
    fn model_specs_pin_checksums_for_every_model_file() {
        for pair in ["en-zh", "zh-en"] {
            let spec = model_spec(pair).unwrap();
            let pinned: Vec<&str> = spec.expected_sha256.iter().map(|(f, _)| *f).collect();
            // 每个 MODEL_FILES 条目都必须有硬编码校验值，杜绝「下载后不校验」的缺口
            for file in super::MODEL_FILES {
                assert!(pinned.contains(file), "{pair} must pin {file}");
            }
            for (file, sha) in spec.expected_sha256 {
                assert_eq!(sha.len(), 64, "{pair}/{file} sha256 must be 64 hex chars");
            }
        }
    }

    /// `MODEL_FILES` 与 `expected_sha256` 必须是**同一个集合**（不只是包含关系）。
    ///
    /// 原来的护栏只断言 `MODEL_FILES ⊆ pinned`，反向漏掉了，而两个方向都有人在用：
    ///   · 下载 / `local_mt_model_status` 只遍历 `MODEL_FILES`
    ///     （"installed" = MODEL_FILES 全部存在）
    ///   · `verify_model_checksums` 只遍历 `expected_sha256`
    ///     （缺任一 -> 报 "<file>: file is missing"）
    /// 于是 `expected_sha256` 里多出一项时，状态页会显示「已安装」，
    /// 而下载/校验永远失败（那个文件从不会被下载），用户无从理解。
    /// **实测确认**：给 en-zh 加一个 `("extra_file.bin", ...)` 项，
    /// 修改前的测试全绿（117 passed / 0 failed）——这个缺口是真实存在的。
    #[test]
    fn the_model_file_list_and_the_checksum_list_are_the_same_set() {
        let mut model_files: Vec<&str> = super::MODEL_FILES.to_vec();
        model_files.sort_unstable();
        for pair in ["en-zh", "zh-en"] {
            let spec = model_spec(pair).unwrap();
            let mut pinned: Vec<&str> = spec.expected_sha256.iter().map(|(f, _)| *f).collect();
            pinned.sort_unstable();
            assert_eq!(
                pinned, model_files,
                "{pair}: MODEL_FILES and expected_sha256 must be the same set — \
                 an extra checksum entry is never downloaded, so verification fails \
                 forever while the status page still reports 'installed'"
            );
        }
    }

    /// 同一 pair 内不允许重复文件项（重复会让 `expected` HashMap 静默丢弃一项）。
    #[test]
    fn no_model_pair_lists_a_file_twice() {
        for pair in ["en-zh", "zh-en"] {
            let spec = model_spec(pair).unwrap();
            let mut seen = std::collections::HashSet::new();
            for (file, _) in spec.expected_sha256 {
                assert!(seen.insert(*file), "{pair} lists {file} more than once");
            }
        }
    }

    #[test]
    fn checksum_verification_rejects_tampered_or_missing_files() {
        let dir =
            std::env::temp_dir().join(format!("cup-translate-mt-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let spec = ModelSpec {
            dir_name: "test",
            repo: "test",
            revision: "test",
            source_prefix: None,
            license: "",
            expected_sha256: &[(
                "model.bin",
                "0000000000000000000000000000000000000000000000000000000000000000",
            )],
        };
        // 缺文件 -> 报缺失（错误串是英文，见文件顶部约定）
        let bad = verify_model_checksums(&dir, &spec);
        assert_eq!(bad.len(), 1);
        assert!(bad[0].contains("missing"));
        // 写入内容但哈希不匹配 -> 报不匹配
        std::fs::write(dir.join("model.bin"), b"tampered").unwrap();
        let bad = verify_model_checksums(&dir, &spec);
        assert_eq!(bad.len(), 1);
        assert!(bad[0].contains("mismatch"));
        // 修正为真实哈希 -> 通过
        let real: &'static str = Box::leak(
            file_sha256(&dir.join("model.bin"))
                .unwrap()
                .into_boxed_str(),
        );
        let pinned: &'static [(&'static str, &'static str)] =
            Box::leak(vec![("model.bin", real)].into_boxed_slice());
        let spec = ModelSpec {
            dir_name: "test",
            repo: "test",
            revision: "test",
            source_prefix: None,
            license: "",
            expected_sha256: pinned,
        };
        assert!(verify_model_checksums(&dir, &spec).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn file_sha256_matches_known_digest() {
        let path: PathBuf =
            std::env::temp_dir().join(format!("cup-translate-sha256-{}", std::process::id()));
        std::fs::write(&path, b"hello").unwrap();
        // SHA256("hello") 的已知值
        assert_eq!(
            file_sha256(&path).unwrap(),
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
        let _ = std::fs::remove_file(&path);
    }
}
