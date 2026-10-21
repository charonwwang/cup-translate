// 本地离线翻译（可选功能，不进默认引擎列表）：
//
// ⚠️ 本文件里**返回给前端**的错误字符串一律用英文，理由同 tts.rs：
// 它们会经 `toast.error(e.toString())` 原样弹给用户（例如模型下载失败），
// 而项目默认/回退语言是英文，其余 Rust 模块也都是英文。
// 需要本地化的文案请走前端的 `t()`。
// 例外：`license` 字段是**许可证署名元数据**（法律要求，必须准确），
// 且前端并不读它（用 `services.translate.local_mt.license_<pair>`），保留原文。
// CTranslate2（ct2rs）运行 OPUS-MT 中英模型，以及单份 M2M-100 418M int8 多语种模型。
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
    tokenizer: Box<dyn Tokenizer + Send + Sync>,
}

impl MtTranslator {
    fn new(path: &std::path::Path, config: &Ct2Config) -> Result<Self, String> {
        Ok(Self {
            engine: ct2rs::sys::Translator::new(path, config).map_err(|e| e.to_string())?,
            tokenizer: if path.join("sentencepiece.bpe.model").is_file() {
                let spm = path.join("sentencepiece.bpe.model");
                Box::new(
                    ct2rs::tokenizers::sentencepiece::Tokenizer::from_file(&spm, &spm)
                        .map_err(|e| e.to_string())?,
                )
            } else {
                Box::new(AutoTokenizer::new(path).map_err(|e| e.to_string())?)
            },
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
#[cfg(test)]
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
        "hymt-q4" => Ok(ModelSpec {
            dir_name: "hymt-q4",
            repo: "tencent/HY-MT1.5-1.8B-GGUF",
            revision: "265b2e615a7dc9b06c435dc878829ad99a512ba2",
            source_prefix: None,
            license: "Tencent Hunyuan Community License (see upstream License.txt)",
            expected_sha256: &[
                (
                    "HY-MT1.5-1.8B-Q4_K_M.gguf",
                    "4383ac0c3c8e476de98ff979c2a3f069f8c4fb385e7860cf2d28da896cc477c7",
                ),
                (
                    "License.txt",
                    "d7d9db858500ac9073f4b5decef8e208454357226f535f65079ce4376047569f",
                ),
            ],
        }),
        "hymt-q8" => Ok(ModelSpec {
            dir_name: "hymt-q8",
            repo: "tencent/HY-MT1.5-1.8B-GGUF",
            revision: "265b2e615a7dc9b06c435dc878829ad99a512ba2",
            source_prefix: None,
            license: "Tencent Hunyuan Community License (see upstream License.txt)",
            expected_sha256: &[
                (
                    "HY-MT1.5-1.8B-Q8_0.gguf",
                    "6789b06d0902f2f5312c0e1703d56ccbddfcfb6c653d22519b7c720f7db9a98e",
                ),
                (
                    "License.txt",
                    "d7d9db858500ac9073f4b5decef8e208454357226f535f65079ce4376047569f",
                ),
            ],
        }),
        "m2m100" => Ok(ModelSpec {
            dir_name: "m2m100-418m-ct2-int8",
            repo: "jncraton/m2m100_418M-ct2-int8",
            revision: "7c1b2620a4e58dacecbd8bf89cfd6da7eb9eb7b0",
            source_prefix: None,
            license: "MIT (Meta / facebook/m2m100_418M; CT2 int8 conversion: jncraton)",
            expected_sha256: &[
                (
                    "config.json",
                    "4244772990e30069563e3ddfb4ad6dc95bdfd2ac3de667ea8858c9b0a8433fa8",
                ),
                (
                    "shared_vocabulary.json",
                    "7eb5d0ff184c6095c7c10f9911c0aea492250abd12854f9c3d787c64b1c6397e",
                ),
                (
                    "sentencepiece.bpe.model",
                    "d8f7c76ed2a5e0822be39f0a4f95a55eb19c78f4593ce609e2edbc2aea4d380a",
                ),
                (
                    "model.bin",
                    "d6703dd9f920ff896e45c3d97b490761bed5944937b90bbe6a7245f5652542d4",
                ),
            ],
        }),
        _ => Err(format!(
            "Unsupported language pair: {pair} (expected en-zh / zh-en / m2m100)"
        )),
    }
}

fn model_files(pair: &str) -> Vec<&'static str> {
    model_spec(pair)
        .map(|s| s.expected_sha256.iter().map(|(name, _)| *name).collect())
        .unwrap_or_default()
}

// The model has one Chinese token: Traditional output and dialect/script claims are
// intentionally not advertised. Frontend aliases are normalized before invoking.
const M2M_LANGUAGES: &str = "af am ar ast az ba be bg bn br bs ca ceb cs cy da de el en es et fa ff fi fr fy ga gd gl gu ha he hi hr ht hu hy id ig ilo is it ja jv ka kk km kn ko lb lg ln lo lt lv mg mk ml mn mr ms my ne nl no ns oc or pa pl ps pt ro ru sd si sk sl so sq sr ss su sv sw ta th tl tn tr uk ur uz vi wo xh yi yo zh zu";
fn m2m_direction(source: Option<&str>, target: Option<&str>) -> Result<(String, String), String> {
    let from = source.ok_or("Select or detect a source language for M2M-100")?;
    let to = target.ok_or("Select a target language for M2M-100")?;
    if from == to
        || !M2M_LANGUAGES.split_whitespace().any(|l| l == from)
        || !M2M_LANGUAGES.split_whitespace().any(|l| l == to)
    {
        return Err("Unsupported M2M-100 language direction".into());
    }
    Ok((format!("__{from}__"), format!("__{to}__")))
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
    let versioned = version_dir(app_handle, pair)?;
    if versioned.is_dir() {
        return Ok(versioned);
    }
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

#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct InstallTask {
    pair: String,
    revision: String,
    state: String,
    file: String,
    bytes: u64,
    total: u64,
    validator: Option<String>,
    origin: String,
    error: Option<String>,
    #[serde(default)]
    failed_stage: Option<String>,
}
fn task_path(app: &AppHandle, pair: &str) -> Result<PathBuf, String> {
    let spec = model_spec(pair)?;
    Ok(app
        .path_resolver()
        .app_config_dir()
        .ok_or("Config directory unavailable")?
        .join("models")
        .join(format!("{}.task.json", spec.dir_name)))
}
fn task_control() -> &'static Mutex<HashMap<String, String>> {
    static CONTROL: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    CONTROL.get_or_init(|| Mutex::new(HashMap::new()))
}
fn persist_task(app: &AppHandle, task: &InstallTask) -> Result<(), String> {
    use tauri::Manager;
    let path = task_path(app, &task.pair)?;
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|_| "Cannot create task directory")?;
    let temp = path.with_extension("tmp");
    let mut file = std::fs::File::create(&temp).map_err(|_| "Cannot save install task")?;
    file.write_all(&serde_json::to_vec(task).map_err(|_| "Cannot serialize task")?)
        .map_err(|_| "Cannot save install task")?;
    file.sync_all().map_err(|_| "Cannot flush install task")?;
    std::fs::rename(temp, path).map_err(|_| "Cannot commit install task")?;
    app.emit_all("local_mt_task", task)
        .map_err(|_| "Cannot notify model windows")?;
    Ok(())
}
fn read_task(app: &AppHandle, pair: &str) -> Option<InstallTask> {
    serde_json::from_slice(&std::fs::read(task_path(app, pair).ok()?).ok()?).ok()
}
fn version_dir(app: &AppHandle, pair: &str) -> Result<PathBuf, String> {
    let spec = model_spec(pair)?;
    Ok(app
        .path_resolver()
        .app_config_dir()
        .ok_or("Config directory unavailable")?
        .join("models")
        .join(format!("{}-{}", spec.dir_name, spec.revision)))
}
fn file_bytes(pair: &str, name: &str) -> u64 {
    match (pair, name) {
        ("hymt-q4", "HY-MT1.5-1.8B-Q4_K_M.gguf") => 1133080512,
        ("hymt-q8", "HY-MT1.5-1.8B-Q8_0.gguf") => 1908528288,
        ("hymt-q4" | "hymt-q8", "License.txt") => 16270,
        ("m2m100", "config.json") => 189,
        ("m2m100", "model.bin") => 490_667_713,
        ("m2m100", "shared_vocabulary.json") => 2_796_509,
        ("m2m100", "sentencepiece.bpe.model") => 2_423_393,
        (_, "config.json") => 223,
        (_, "model.bin") => 79_567_635,
        ("en-zh", "shared_vocabulary.json") => 1_303_887,
        ("en-zh", "source.spm") => 806_435,
        ("en-zh", "target.spm") => 804_600,
        ("zh-en", "shared_vocabulary.json") => 1_303_998,
        ("zh-en", "source.spm") => 804_677,
        ("zh-en", "target.spm") => 806_530,
        _ => 0,
    }
}
fn warm_directory(dir: &std::path::Path, pair: &str) -> Result<(), String> {
    if pair.starts_with("hymt-") {
        let output = crate::hy_mt::translate(
            dir,
            pair,
            "Hello, world.",
            "en",
            "zh_cn",
            2,
            &crate::local_mt_tasks::Cancellation::default(),
        );
        crate::hy_mt::unload(pair)?;
        return output.and_then(|v| {
            if v.trim().is_empty() {
                Err("HY-MT self-test returned empty text".into())
            } else {
                Ok(())
            }
        });
    }
    let translator = MtTranslator::new(
        dir,
        &Ct2Config {
            num_threads_per_replica: 2,
            max_queued_batches: 1,
            ..Default::default()
        },
    )
    .map_err(|_| "Model load failed during self-test")?;
    let output = translate_with_model(
        &translator,
        pair,
        if pair != "zh-en" {
            "Hello, world."
        } else {
            "你好，世界。"
        },
        Some("balanced"),
    )?;
    if output.trim().is_empty() || has_private_use(&output) {
        return Err("Model self-test returned invalid output".into());
    }
    Ok(())
}
fn validated_dirs() -> &'static Mutex<HashMap<PathBuf, Vec<(u64, Option<std::time::SystemTime>)>>> {
    static VALIDATED: OnceLock<Mutex<HashMap<PathBuf, Vec<(u64, Option<std::time::SystemTime>)>>>> =
        OnceLock::new();
    VALIDATED.get_or_init(|| Mutex::new(HashMap::new()))
}
fn validate_ready(dir: &std::path::Path, pair: &str) -> bool {
    let spec = match model_spec(pair) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let fingerprint: Option<Vec<_>> = model_files(pair)
        .iter()
        .map(|name| {
            let meta = std::fs::metadata(dir.join(name)).ok()?;
            (meta.is_file() && meta.len() == file_bytes(pair, name))
                .then(|| (meta.len(), meta.modified().ok()))
        })
        .collect();
    let Some(fingerprint) = fingerprint else {
        return false;
    };
    let mut verified = match validated_dirs().lock() {
        Ok(v) => v,
        Err(_) => return false,
    };
    if verified.get(dir) == Some(&fingerprint) {
        return true;
    }
    if !verify_model_checksums(dir, &spec).is_empty() || warm_directory(dir, pair).is_err() {
        return false;
    }
    verified.insert(dir.to_owned(), fingerprint);
    true
}
#[tauri::command]
pub async fn local_mt_model_status(app_handle: AppHandle, pair: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let spec = model_spec(&pair)?;
        let dir = model_dir(&app_handle, &pair)?;
        let installed = validate_ready(&dir,&pair);
        let mut task = read_task(&app_handle,&pair);
        let active = download_lock().lock().map_err(|_| "Model lock unavailable")?.contains_key(&pair);
        if !active {
            if let Some(ref mut task) = task {
                if ["queued","downloading","verifying","warming"].contains(&task.state.as_str()) {
                    task.state = "paused".into();
                    persist_task(&app_handle, task)?;
                }
            }
        }
        let total: u64 = model_files(&pair).iter().map(|name| file_bytes(&pair,name)).sum();
        Ok(json!({"pair":pair,"supported":true,"installed":installed,"loaded":if pair.starts_with("hymt-") {crate::hy_mt::loaded(&pair)} else {translator_cache().try_lock().map(|cache| cache.contains_key(&pair)).unwrap_or(false)},"missing":[],"hasFiles":dir.is_dir(),"license":spec.license,"source":spec.repo,"revision":spec.revision,"runtime":if pair.starts_with("hymt-") {"llama-cpp-2 0.1.160 / CPU GGUF"} else {"ct2rs-0.10 / CTranslate2 int8"},"bytes":total,"files":spec.expected_sha256.iter().map(|(name,sha)| json!({"name":name,"bytes":file_bytes(&pair,name),"sha256":sha})).collect::<Vec<_>>(),"downloadBase":format!("https://huggingface.co/{}/resolve/{}",spec.repo,spec.revision),"task":task,"dir":dir.display().to_string()}))
    }).await.map_err(|_| "Model status worker failed")?
}
#[tauri::command]
pub async fn local_mt_install_control(
    app_handle: AppHandle,
    pair: String,
    action: String,
) -> Result<(), String> {
    model_spec(&pair)?;
    if !["paused", "cancelled"].contains(&action.as_str()) {
        return Err("Invalid install action".into());
    }
    task_control()
        .lock()
        .map_err(|_| "Model control unavailable")?
        .insert(pair.clone(), action.clone());
    if !download_lock()
        .lock()
        .map_err(|_| "Model lock unavailable")?
        .contains_key(&pair)
    {
        if let Some(mut task) = read_task(&app_handle, &pair) {
            task.state = action;
            persist_task(&app_handle, &task)?;
        }
    }
    Ok(())
}
#[tauri::command]
pub async fn local_mt_device_check(
    app_handle: AppHandle,
    model: Option<String>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = app_handle.path_resolver().app_config_dir().ok_or("Config directory unavailable")?;
        std::fs::create_dir_all(&root).map_err(|_| "Cannot access model storage")?;
        let available = fs2::available_space(&root).map_err(|_| "Cannot read available disk space")?;
        // Memory estimates are deliberately absent: no portable measurement is available here.
        Ok(json!({"architecture":std::env::consts::ARCH,"platform":std::env::consts::OS,"diskAvailable":available,"diskRequired":if model.as_deref().is_some_and(|m|m.starts_with("hymt-")) {4_500_000_000u64} else if model.as_deref() == Some("m2m100") { 1_200_000_000u64 } else { 400_000_000u64 },"memory":null,"supported":true,"threads":std::thread::available_parallelism().map(|n| n.get().min(4)).unwrap_or(2)}))
    }).await.map_err(|_| "Device check worker failed")?
}
// Resume only with an unchanged origin and server validator. An unvalidated partial is never appended.
fn resume_offset(status: u16, range: Option<&str>, offset: u64) -> Result<bool, String> {
    match status {
        200 => Ok(false),
        206 if range
            .and_then(|r| r.strip_prefix("bytes "))
            .and_then(|r| r.split_once('-'))
            .and_then(|(n, _)| n.parse::<u64>().ok())
            == Some(offset) =>
        {
            Ok(true)
        }
        416 => Err("Range no longer satisfiable; retry restarts this file".into()),
        _ => Err(format!("Unexpected download response: HTTP {status}")),
    }
}
fn install_model(
    app: &AppHandle,
    pair: &str,
    task: &mut InstallTask,
    source_dir: Option<&std::path::Path>,
    download_base: Option<&str>,
) -> Result<(), String> {
    let spec = model_spec(pair)?;
    let final_dir = version_dir(app, pair)?;
    let stage = final_dir.with_extension("staging");
    std::fs::create_dir_all(&stage).map_err(|_| "Cannot create staging directory")?;
    if fs2::available_space(&stage).map_err(|_| "Cannot inspect free disk space")?
        < if pair == "m2m100" {
            1_200_000_000
        } else {
            200_000_000
        }
    {
        return Err("Insufficient disk space for model staging and repair".into());
    }
    if let Some(source) = source_dir {
        for (name, sha) in spec.expected_sha256 {
            check_install_control(app, pair, task)?;
            task.state = "verifying".into();
            task.file = name.to_string();
            task.total = file_bytes(pair, name);
            task.bytes = 0;
            persist_task(app, task)?;
            verify_import_file(&source.join(name), file_bytes(pair, name), sha)?;
            task.bytes = task.total;
            persist_task(app, task)?;
        }
    }
    let existing = model_dir(app, pair)?;
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(900))
        .build()
        .map_err(|_| "Cannot initialize download client")?;
    for name in &model_files(pair) {
        let expected = spec
            .expected_sha256
            .iter()
            .find(|(n, _)| n == name)
            .unwrap()
            .1;
        let dest = stage.join(name);
        if file_sha256(&dest).ok().as_deref() == Some(expected) {
            continue;
        }
        if file_sha256(&existing.join(name)).ok().as_deref() == Some(expected) {
            std::fs::copy(existing.join(name), &dest)
                .map_err(|_| "Cannot reuse verified model file")?;
            continue;
        }
        if let Some(source) = source_dir {
            task.file = name.to_string();
            task.total = file_bytes(pair, name);
            task.bytes = 0;
            task.state = "verifying".into();
            persist_task(app, task)?;
            let source_file = source.join(name);
            std::fs::copy(&source_file, &dest).map_err(|_| "Cannot copy imported model file")?;
            task.bytes = task.total;
            persist_task(app, task)?;
            continue;
        }
        let partial = dest.with_extension("part");
        let previous_file = task.file.clone();
        task.file = name.to_string();
        task.total = file_bytes(pair, name);
        task.state = "downloading".into();
        let mut complete = false;
        let origins: Vec<&str> = download_base
            .map(|base| vec![base])
            .unwrap_or_else(|| vec!["https://huggingface.co", "https://hf-mirror.com"]);
        for origin in origins {
            check_install_control(app, pair, task)?;
            let mut offset = std::fs::metadata(&partial).map(|m| m.len()).unwrap_or(0);
            if previous_file != *name || task.origin != origin || task.validator.is_none() {
                offset = 0;
            }
            if offset >= task.total {
                offset = 0;
            }
            let url = if download_base.is_some() {
                format!("{}/{}", origin.trim_end_matches('/'), name)
            } else {
                format!(
                    "{}/{}/resolve/{}/{}",
                    origin, spec.repo, spec.revision, name
                )
            };
            let mut request = client.get(url);
            if offset > 0 {
                request = request
                    .header("Range", format!("bytes={offset}-"))
                    .header("If-Range", task.validator.as_deref().unwrap());
            }
            let mut response = match controlled_transfer(app, pair, task, request.send()) {
                Ok(r) => r,
                Err(_) if ["paused", "cancelled"].contains(&task.state.as_str()) => {
                    return Err("Install stopped; temporary files retained".into())
                }
                Err(_) => continue,
            };
            let validator = response
                .headers()
                .get("etag")
                .or_else(|| response.headers().get("last-modified"))
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned);
            let range = response
                .headers()
                .get("content-range")
                .and_then(|v| v.to_str().ok());
            let append = match resume_offset(response.status().as_u16(), range, offset) {
                Ok(a) => a,
                Err(_) => {
                    let _ = std::fs::remove_file(&partial);
                    continue;
                }
            };
            if append && offset > 0 && task.validator != validator {
                let _ = std::fs::remove_file(&partial);
                continue;
            }
            if !append {
                offset = 0;
            }
            task.validator = validator;
            task.origin = origin.into();
            task.bytes = offset;
            persist_task(app, task)?;
            let mut output = std::fs::OpenOptions::new()
                .create(true)
                .write(true)
                .append(append && offset > 0)
                .truncate(!append || offset == 0)
                .open(&partial)
                .map_err(|_| "Cannot create partial model file")?;
            let mut tick = Instant::now();
            loop {
                check_install_control(app, pair, task)?;
                let chunk = controlled_transfer(app, pair, task, response.chunk())?;
                let Some(buffer) = chunk else {
                    break;
                };
                let read = buffer.len();
                task.bytes += read as u64;
                if task.bytes > task.total {
                    return Err("Downloaded file exceeds catalog size".into());
                }
                output
                    .write_all(&buffer)
                    .map_err(|_| "Model write failed (check disk space)")?;
                if tick.elapsed() > Duration::from_millis(200) {
                    persist_task(app, task)?;
                    tick = Instant::now();
                }
            }
            output.sync_all().map_err(|_| "Cannot flush model file")?;
            drop(output);
            task.state = "verifying".into();
            persist_task(app, task)?;
            if task.bytes == task.total && file_sha256(&partial).ok().as_deref() == Some(expected) {
                std::fs::rename(&partial, &dest).map_err(|_| "Cannot verify model file")?;
                complete = true;
                break;
            }
            let _ = std::fs::remove_file(&partial);
        }
        if !complete {
            return Err("Model download failed or checksum mismatch; mirror may be tampered with or transfer corrupted; retry available".into());
        }
    }
    check_install_control(app, pair, task)?;
    task.state = "verifying".into();
    persist_task(app, task)?;
    if !verify_model_checksums(&stage, &spec).is_empty() {
        return Err("Model integrity check failed".into());
    }
    task.state = "warming".into();
    persist_task(app, task)?;
    warm_directory(&stage, pair)?;
    check_install_control(app, pair, task)?;
    if final_dir.exists() {
        if validate_ready(&final_dir, pair) {
            std::fs::remove_dir_all(stage).map_err(|_| "Cannot remove staging directory")?;
        } else {
            let cache = translator_cache()
                .lock()
                .map_err(|_| "Model cache unavailable")?;
            if cache
                .get(pair)
                .is_some_and(|entry| Arc::strong_count(&entry.translator) > 1)
            {
                return Err("Model is in use; retry repair after translation completes".into());
            }
            drop(cache);
            let previous = final_dir.with_extension("invalid");
            if previous.exists() {
                std::fs::remove_dir_all(&previous)
                    .map_err(|_| "Cannot remove old invalid version")?;
            }
            std::fs::rename(&final_dir, &previous).map_err(|_| "Cannot stage invalid version")?;
            if std::fs::rename(&stage, &final_dir).is_err() {
                let _ = std::fs::rename(&previous, &final_dir);
                return Err("Atomic model repair failed; previous files retained".into());
            }
            let _ = std::fs::remove_dir_all(previous);
        }
    } else {
        std::fs::rename(stage, final_dir).map_err(|_| "Atomic model commit failed")?;
    }
    task.state = "ready".into();
    task.error = None;
    persist_task(app, task)?;
    Ok(())
}
fn controlled_transfer<T>(
    app: &AppHandle,
    pair: &str,
    task: &mut InstallTask,
    future: impl std::future::Future<Output = Result<T, reqwest::Error>>,
) -> Result<T, String> {
    tauri::async_runtime::block_on(async {
        tokio::pin!(future);
        loop {
            tokio::select! {
                result = &mut future => return result.map_err(|_| "Download interrupted; resume is available".into()),
                _ = tokio::time::sleep(Duration::from_millis(100)) => check_install_control(app,pair,task)?,
            }
        }
    })
}
fn check_install_control(
    app: &AppHandle,
    pair: &str,
    task: &mut InstallTask,
) -> Result<(), String> {
    if let Some(action) = task_control()
        .lock()
        .map_err(|_| "Model control unavailable")?
        .remove(pair)
    {
        task.state = action;
        persist_task(app, task)?;
        return Err("Install stopped; temporary files retained for explicit resume".into());
    }
    Ok(())
}
#[tauri::command]
pub async fn local_mt_download_model(
    app_handle: AppHandle,
    pair: String,
    download_base: Option<String>,
) -> Result<(), String> {
    let download_base = download_base
        .map(|base| validate_download_base(&base))
        .transpose()?;
    run_install(app_handle, pair, None, download_base).await
}

fn verify_import_file(path: &std::path::Path, bytes: u64, sha: &str) -> Result<(), String> {
    let meta =
        std::fs::symlink_metadata(path).map_err(|_| "Import is missing a required model file")?;
    if !meta.is_file() || meta.len() != bytes {
        return Err("Imported model has an incompatible file type or size".into());
    }
    if file_sha256(path)? != sha {
        return Err("Imported model checksum differs from the selected catalog version".into());
    }
    Ok(())
}
fn validate_download_base(base: &str) -> Result<String, String> {
    let url = reqwest::Url::parse(base.trim())
        .map_err(|_| "Enter a complete HTTPS model directory URL")?;
    let loopback = matches!(
        url.host_str(),
        Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
    );
    if !(url.scheme() == "https" || (url.scheme() == "http" && loopback))
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Download URL must use HTTPS (HTTP only on loopback), without credentials, query or fragment".into());
    }
    Ok(url.as_str().trim_end_matches('/').to_string())
}
#[tauri::command]
pub async fn local_mt_import_model(
    app_handle: AppHandle,
    pair: String,
    source_dir: String,
) -> Result<(), String> {
    model_spec(&pair)?;
    let source = std::fs::canonicalize(&source_dir)
        .map_err(|_| "Cannot read the selected model directory")?;
    if !source.is_dir() {
        return Err("Choose an extracted CTranslate2 model directory".into());
    }
    let managed = app_handle
        .path_resolver()
        .app_config_dir()
        .ok_or("Config directory unavailable")?
        .join("models");
    // Imports never overwrite or move their source; reject recursive staging paths.
    if let Ok(root) = std::fs::canonicalize(managed) {
        if source.starts_with(root) {
            return Err("Select a model folder outside managed model storage".into());
        }
    }
    run_install(app_handle, pair, Some(source), None).await
}
async fn run_install(
    app_handle: AppHandle,
    pair: String,
    source_dir: Option<PathBuf>,
    download_base: Option<String>,
) -> Result<(), String> {
    let guard = DownloadGuard::acquire(&pair)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        let spec = model_spec(&pair)?;
        task_control()
            .lock()
            .map_err(|_| "Model control unavailable")?
            .remove(&pair);
        let mut task = read_task(&app_handle, &pair)
            .filter(|t| t.revision == spec.revision)
            .unwrap_or(InstallTask {
                pair: pair.clone(),
                revision: spec.revision.into(),
                state: "queued".into(),
                file: String::new(),
                bytes: 0,
                total: 0,
                validator: None,
                origin: String::new(),
                error: None,
                failed_stage: None,
            });
        task.state = "queued".into();
        task.error = None;
        persist_task(&app_handle, &task)?;
        let result = install_model(
            &app_handle,
            &pair,
            &mut task,
            source_dir.as_deref(),
            download_base.as_deref(),
        );
        if result.is_err() && !["paused", "cancelled"].contains(&task.state.as_str()) {
            task.failed_stage = Some(task.state.clone());
            task.error = result.as_ref().err().cloned();
            task.state = "failed".into();
            persist_task(&app_handle, &task)?;
        }
        result
    })
    .await
    .map_err(|_| "Install worker failed")?
}

#[tauri::command]
pub async fn local_mt_delete_model(app_handle: AppHandle, pair: String) -> Result<(), String> {
    let _guard = DownloadGuard::acquire(&pair)?;
    let dir = model_dir(&app_handle, &pair)?;
    if pair.starts_with("hymt-") {
        crate::hy_mt::unload(&pair)?;
    }
    let mut cache = translator_cache()
        .lock()
        .map_err(|_| "Model cache unavailable")?;
    if cache
        .get(&pair)
        .is_some_and(|entry| Arc::strong_count(&entry.translator) > 1)
    {
        return Err("Model is in use; retry after translation completes".into());
    }
    cache.remove(&pair);
    drop(cache);
    validated_dirs()
        .lock()
        .map_err(|_| "Model validation unavailable")?
        .remove(&dir);
    let root = app_handle
        .path_resolver()
        .app_config_dir()
        .ok_or("Config directory unavailable")?
        .join("models");
    remove_managed_model(&root, &pair)?;

    Ok(())
}

fn remove_managed_model(root: &std::path::Path, pair: &str) -> Result<(), String> {
    let spec = model_spec(pair)?;
    let version = root.join(format!("{}-{}", spec.dir_name, spec.revision));
    for path in [
        root.join(spec.dir_name),
        version.clone(),
        version.with_extension("staging"),
    ] {
        if path.is_dir() {
            std::fs::remove_dir_all(path).map_err(|_| "Cannot remove managed model files")?;
        }
    }
    let task = root.join(format!("{}.task.json", spec.dir_name));
    if task.is_file() {
        std::fs::remove_file(task).map_err(|_| "Cannot remove completed model task")?;
    }
    Ok(())
}

#[tauri::command]
pub async fn local_mt_unload_model(pair: String) -> Result<(), String> {
    model_spec(&pair)?;
    if pair.starts_with("hymt-") {
        return crate::hy_mt::unload(&pair);
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut cache = translator_cache()
            .lock()
            .map_err(|_| "Model cache unavailable")?;
        if cache
            .get(&pair)
            .is_some_and(|entry| Arc::strong_count(&entry.translator) > 1)
        {
            return Err("Model is in use; retry after translation completes".into());
        }
        cache.remove(&pair);
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
    if !validate_ready(&dir, pair) {
        return Err("Model is not verified and ready; install or repair in Settings".into());
    }
    let missing: Vec<&str> = model_files(pair)
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
    translate_with_languages(translator, pair, text, quality, Some("en"), Some("fr"))
}
fn translate_with_languages(
    translator: &MtTranslator,
    pair: &str,
    text: &str,
    quality: Option<&str>,
    source: Option<&str>,
    target: Option<&str>,
) -> Result<String, String> {
    translate_cancellable(
        translator,
        pair,
        text,
        quality,
        source,
        target,
        &Default::default(),
    )
}

fn translate_cancellable(
    translator: &MtTranslator,
    pair: &str,
    text: &str,
    quality: Option<&str>,
    source: Option<&str>,
    target: Option<&str>,
    cancellation: &crate::local_mt_tasks::Cancellation,
) -> Result<String, String> {
    cancellation.check()?;
    let direction = if pair == "m2m100" {
        Some(m2m_direction(source, target)?)
    } else {
        None
    };
    let spec = model_spec(pair)?;
    let options = TranslationOptions::<String, String> {
        beam_size: beam_size(quality),
        max_input_length: 0,
        max_decoding_length: 512,
        max_batch_size: 1,
        ..Default::default()
    };
    let separator = if pair == "zh-en" || (pair == "m2m100" && !matches!(target, Some("zh" | "ja")))
    {
        " "
    } else {
        ""
    };
    translate_chunks(text, separator, cancellation, |chunk| {
        let tokens = prepend_language_marker(
            translator
                .tokenizer
                .encode(chunk.trim())
                .map_err(|e| format!("Tokenization failed: {e}"))?,
            direction
                .as_ref()
                .map(|(from, _)| from.as_str())
                .or(spec.source_prefix),
        );
        // OPUS needs the marker in source tokens, never forced decoder output.
        let decode = |options: &TranslationOptions<String, String>| -> Result<String, String> {
            cancellation.check()?;
            let results = if let Some((_, to)) = &direction {
                translator.engine.translate_batch_with_target_prefix(
                    &[tokens.clone()],
                    &[vec![to.as_str()]],
                    options,
                    None,
                )
            } else {
                translator
                    .engine
                    .translate_batch(&[tokens.clone()], options, None)
            }
            .map_err(|e| format!("Local translation failed: {e}"))?;
            cancellation.check()?;
            let hypothesis = results
                .into_iter()
                .next()
                .and_then(|result| result.hypotheses.into_iter().next())
                .ok_or_else(|| "Local translation returned no result".to_string())?;
            let hypothesis = if let Some((_, target)) = &direction {
                hypothesis
                    .into_iter()
                    .filter(|token| {
                        token != target && token != "</s>" && token != "<s>" && token != "<pad>"
                    })
                    .collect()
            } else {
                hypothesis
            };
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
        Ok(first)
    })
}

// Keep cancellation at the same boundaries used by the real decoder, so a long
// request cannot continue into later chunks after its selection has expired.
fn translate_chunks(
    text: &str,
    separator: &str,
    cancellation: &crate::local_mt_tasks::Cancellation,
    mut decode: impl FnMut(&str) -> Result<String, String>,
) -> Result<String, String> {
    let mut paragraphs = Vec::new();
    for line in text.lines() {
        let mut translated_chunks = Vec::new();
        for chunk in split_for_translation(line, 200) {
            cancellation.check()?;
            if chunk.trim().is_empty() {
                continue;
            }
            let translated = decode(chunk)?;
            cancellation.check()?;
            translated_chunks.push(translated);
        }
        paragraphs.push(translated_chunks.join(separator));
    }
    cancellation.check()?;
    Ok(paragraphs.join("\n"))
}

#[tauri::command]
pub async fn local_mt_translate(
    app_handle: AppHandle,
    pair: String,
    text: String,
    threads: Option<u32>,
    quality: Option<String>,
    source: Option<String>,
    target: Option<String>,
    request_id: Option<String>,
) -> Result<String, String> {
    let request = crate::local_mt_tasks::Request::claim(request_id)?;
    model_spec(&pair)?;
    if pair == "m2m100" {
        m2m_direction(source.as_deref(), target.as_deref())?;
    }
    if text.trim().is_empty() {
        return Ok(String::new());
    }
    if text.chars().count() > 20_000 {
        return Err("Local translation accepts at most 20000 characters per request".into());
    }
    // Cancellable async queue: stale requests leave immediately, while a bounded
    // registry limits admission. One native decode runs at a time across directions.
    static GATE: OnceLock<tauri::async_runtime::Mutex<()>> = OnceLock::new();
    let gate = GATE.get_or_init(|| tauri::async_runtime::Mutex::new(()));
    let _permit = crate::local_mt_tasks::acquire(gate, &request.cancellation).await?;
    request.cancellation.check()?;
    tauri::async_runtime::spawn_blocking(move || {
        request.cancellation.check()?;
        if pair.starts_with("hymt-") {
            let from = source
                .as_deref()
                .ok_or("Select or detect source language for HY-MT")?;
            let to = target
                .as_deref()
                .ok_or("Select target language for HY-MT")?;
            crate::hy_mt::direction(from, to)?;
            let dir = model_dir(&app_handle, &pair)?;
            if !validate_ready(&dir, &pair) {
                return Err("HY-MT is not installed or failed verification".into());
            }
            return crate::hy_mt::translate(
                &dir,
                &pair,
                &text,
                from,
                to,
                clamp_threads(threads),
                &request.cancellation,
            );
        }
        let translator = load_translator(&app_handle, &pair, clamp_threads(threads))?;
        let output = translate_cancellable(
            &translator,
            &pair,
            &text,
            quality.as_deref(),
            source.as_deref(),
            target.as_deref(),
            &request.cancellation,
        )?;
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
    fn cancellation_during_decode_discards_output_and_stops_later_chunks() {
        let id = crate::local_mt_tasks::local_mt_prepare_request().unwrap();
        let request = crate::local_mt_tasks::Request::claim(Some(id.clone())).unwrap();
        let mut calls = 0;
        let output =
            super::translate_chunks(&"word ".repeat(200), " ", &request.cancellation, |_| {
                calls += 1;
                crate::local_mt_tasks::local_mt_cancel_request(id.clone()).unwrap();
                Ok("obsolete output".into())
            });
        assert!(output.is_err());
        assert_eq!(calls, 1, "no later chunks may run after cancellation");
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

#[cfg(test)]
mod install_contract_tests {
    use super::*;
    #[test]
    fn range_contract_never_appends_a_full_response_or_an_invalid_offset() {
        assert!(!resume_offset(200, None, 10).unwrap());
        assert!(resume_offset(206, Some("bytes 10-19/20"), 10).unwrap());
        assert!(resume_offset(206, Some("bytes 0-19/20"), 10).is_err());
        assert!(resume_offset(206, None, 10).is_err());
        assert!(resume_offset(416, Some("bytes */20"), 20).is_err());
        assert!(resume_offset(500, None, 0).is_err());
    }
    #[test]
    fn persisted_tasks_recover_exact_offsets_validators_and_revision_without_secrets() {
        let task = InstallTask {
            pair: "en-zh".into(),
            revision: model_spec("en-zh").unwrap().revision.into(),
            state: "paused".into(),
            file: "model.bin".into(),
            bytes: 12345,
            total: file_bytes("en-zh", "model.bin"),
            validator: Some("etag-v1".into()),
            origin: "https://huggingface.co".into(),
            error: None,
            failed_stage: None,
        };
        let bytes = serde_json::to_vec(&task).unwrap();
        let restored: InstallTask = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(restored.bytes, 12345);
        assert_eq!(restored.validator.as_deref(), Some("etag-v1"));
        assert_eq!(restored.revision, model_spec("en-zh").unwrap().revision);
        assert!(!String::from_utf8(bytes).unwrap().contains("token"));
    }
    #[test]
    fn file_presence_or_same_size_corruption_does_not_grant_readiness() {
        let root = std::env::temp_dir().join(format!("cup-not-ready-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        for name in MODEL_FILES {
            let file = std::fs::File::create(root.join(name)).unwrap();
            file.set_len(file_bytes("en-zh", name)).unwrap();
        }
        assert!(!validate_ready(&root, "en-zh"));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn pinned_catalog_has_sizes_revision_runtime_and_directional_license() {
        for pair in ["en-zh", "zh-en"] {
            let spec = model_spec(pair).unwrap();
            assert_eq!(spec.revision.len(), 40);
            assert!(!spec.license.is_empty());
            let size: u64 = MODEL_FILES.iter().map(|file| file_bytes(pair, file)).sum();
            assert!(size > 80_000_000 && size < 84_000_000);
            assert!(MODEL_FILES.iter().all(|file| file_bytes(pair, file) > 0));
        }
    }
}

#[cfg(test)]
mod multilingual_tests {
    use super::*;
    #[test]
    fn multilingual_manifest_is_one_pinned_download_with_known_sizes() {
        let spec = model_spec("m2m100").unwrap();
        assert_eq!(spec.revision.len(), 40);
        assert_eq!(model_files("m2m100").len(), 4);
        assert!(spec
            .expected_sha256
            .iter()
            .all(|(file, sha)| sha.len() == 64 && file_bytes("m2m100", file) > 0));
        assert_eq!(
            model_files("m2m100")
                .iter()
                .map(|file| file_bytes("m2m100", file))
                .sum::<u64>(),
            495_887_804
        );
        assert_eq!(M2M_LANGUAGES.split_whitespace().count(), 100);
    }
    #[test]
    fn multilingual_language_tokens_follow_the_explicit_direction() {
        assert_eq!(
            m2m_direction(Some("ja"), Some("fr")).unwrap(),
            ("__ja__".into(), "__fr__".into())
        );
        for (from, to) in [
            ("auto", "fr"),
            ("en", "zh_tw"),
            ("en", "en"),
            ("../en", "fr"),
        ] {
            assert!(m2m_direction(Some(from), Some(to)).is_err());
        }
        assert!(m2m_direction(None, Some("fr")).is_err());
    }
    #[test]
    #[ignore = "requires a verified M2M-100 directory in CUP_M2M_MODEL_DIR"]
    fn real_multilingual_model_translates_multiple_directions_without_reloading() {
        let dir = PathBuf::from(std::env::var("CUP_M2M_MODEL_DIR").expect("set CUP_M2M_MODEL_DIR"));
        assert!(verify_model_checksums(&dir, &model_spec("m2m100").unwrap()).is_empty());
        let start = Instant::now();
        let translator = MtTranslator::new(
            &dir,
            &Ct2Config {
                num_threads_per_replica: 4,
                ..Default::default()
            },
        )
        .unwrap();
        eprintln!("M2M-100 cold load: {:?}", start.elapsed());
        for (from, to, text) in [
            ("en", "fr", "Hello, world!"),
            ("en", "ja", "Thank you very much."),
            ("ja", "zh", "今日はいい天気ですね。"),
            ("fr", "de", "Bonjour, comment allez-vous ?"),
        ] {
            let start = Instant::now();
            let output = translate_with_languages(
                &translator,
                "m2m100",
                text,
                Some("balanced"),
                Some(from),
                Some(to),
            )
            .unwrap();
            eprintln!("{from} → {to}: {output} ({:?})", start.elapsed());
            assert!(
                !output.trim().is_empty() && !output.contains("__") && !has_private_use(&output)
            );
            if to == "ja" {
                assert!(output
                    .chars()
                    .any(|c| ('\u{3040}'..='\u{30ff}').contains(&c)));
            }
            if to == "zh" {
                assert!(output
                    .chars()
                    .any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c)));
            }
            if to == "de" {
                assert!(output.to_lowercase().contains("wie"));
            }
        }
    }
}

#[cfg(test)]
mod catalog_management_tests {
    use super::*;
    #[test]
    fn custom_download_urls_preserve_directories_and_reject_unsafe_or_ambiguous_inputs() {
        assert_eq!(
            validate_download_base(" https://example.org/models/rev/ ").unwrap(),
            "https://example.org/models/rev"
        );
        assert!(validate_download_base("http://127.0.0.1:61239/model").is_ok());
        for bad in [
            "http://example.org/model",
            "file:///tmp/model",
            "https://user:pass@example.org/model",
            "https://example.org/model?token=fake",
            "https://example.org/model#file",
            "example.org/model",
        ] {
            assert!(validate_download_base(bad).is_err(), "must reject {bad}");
        }
    }
    #[test]
    fn import_rejects_missing_wrong_size_or_tampered_files() {
        let root = std::env::temp_dir().join(format!("cup-import-test-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("config.json");
        assert!(verify_import_file(&file, 3, "fake").is_err());
        std::fs::write(&file, b"abc").unwrap();
        let sha = file_sha256(&file).unwrap();
        assert!(verify_import_file(&file, 3, &sha).is_ok());
        assert!(verify_import_file(&file, 4, &sha).is_err());
        assert!(verify_import_file(&file, 3, &"0".repeat(64)).is_err());
        assert!(verify_import_file(&root, 3, &sha).is_err());
        #[cfg(unix)]
        {
            let link = root.join("linked.json");
            std::os::unix::fs::symlink(&file, &link).unwrap();
            assert!(verify_import_file(&link, 3, &sha).is_err());
        }
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn uninstall_clears_legacy_version_staging_and_task_but_preserves_other_models() {
        let root = std::env::temp_dir().join(format!("cup-uninstall-test-{}", std::process::id()));
        let spec = model_spec("en-zh").unwrap();
        let version = root.join(format!("{}-{}", spec.dir_name, spec.revision));
        let stage = version.with_extension("staging");
        for dir in [
            root.join(spec.dir_name),
            version.clone(),
            stage.clone(),
            root.join("unrelated"),
        ] {
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("model.bin"), b"fixture").unwrap();
        }
        let task = root.join(format!("{}.task.json", spec.dir_name));
        std::fs::write(&task, b"{}").unwrap();
        remove_managed_model(&root, "en-zh").unwrap();
        assert!(
            !root.join(spec.dir_name).exists()
                && !version.exists()
                && !stage.exists()
                && !task.exists()
        );
        assert!(root.join("unrelated/model.bin").exists());
        remove_managed_model(&root, "en-zh").unwrap();
        assert!(remove_managed_model(&root, "../unrelated").is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
