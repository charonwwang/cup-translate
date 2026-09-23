// 本地离线翻译（可选功能，不进默认引擎列表）：
// 用 CTranslate2（ct2rs，内嵌 CT2 源码静态编译）跑 OPUS-MT en↔zh 的 CT2 int8 模型。
// 模型按需下载到 <app_config_dir>/models/<dir>/，不随包分发：
//   en→zh 派生自 Helsinki-NLP/opus-mt-en-zh（Apache-2.0）
//   zh→en 派生自 Helsinki-NLP/opus-mt-zh-en（CC-BY-4.0，界面已标注署名）
// 基准（docs/research/translation-engine-benchmark-2026.md）：79MB / 158MB 内存 / 106ms@4 线程 / BLEU 53.8
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use ct2rs::tokenizers::auto::Tokenizer as AutoTokenizer;
use ct2rs::{ComputeType, Config as Ct2Config, Translator};
use serde_json::{json, Value};
use tauri::AppHandle;

type MtTranslator = Translator<AutoTokenizer>;

/// 每个语向一个 CT2 模型目录
struct ModelSpec {
    dir_name: &'static str,
    repo: &'static str,
    /// 翻译目标需要的前缀 token：opus-mt-en-zh 必须给 `>>cmn_Hans<<`，zh-en 无前缀
    target_prefix: Option<&'static str>,
    license: &'static str,
}

/// 模型目录的完整文件清单（约 82MB，model.bin 占 79.6MB）
const MODEL_FILES: &[&str] = &[
    "config.json",
    "shared_vocabulary.json",
    "source.spm",
    "target.spm",
    "model.bin",
];

fn model_spec(pair: &str) -> Result<ModelSpec, String> {
    match pair {
        "en-zh" => Ok(ModelSpec {
            dir_name: "opus-mt-en-zh-ct2",
            repo: "jiangzhuo9357/opus-mt-en-zh-ct2",
            target_prefix: Some(">>cmn_Hans<<"),
            license: "Apache-2.0 (Helsinki-NLP/opus-mt-en-zh)",
        }),
        "zh-en" => Ok(ModelSpec {
            dir_name: "opus-mt-zh-en-ct2",
            repo: "jiangzhuo9357/opus-mt-zh-en-ct2",
            target_prefix: None,
            license: "CC-BY-4.0 (Helsinki-NLP/opus-mt-zh-en，译文需署名 Helsinki-NLP / OPUS-MT)",
        }),
        _ => Err(format!(
            "不支持的语向: {pair}（本地离线翻译仅支持 en-zh / zh-en）"
        )),
    }
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

/// Translator 加载较慢（约 1~2 秒），按语向缓存复用；线程数变化时重建
fn translator_cache() -> &'static Mutex<HashMap<String, (usize, Arc<MtTranslator>)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, (usize, Arc<MtTranslator>)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
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
        "missing": missing,
        "license": spec.license,
        "dir": dir.display().to_string(),
    }))
}

#[tauri::command]
pub async fn local_mt_download_model(app_handle: AppHandle, pair: String) -> Result<(), String> {
    let spec = model_spec(&pair)?;
    let dir = model_dir(&app_handle, &pair)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建模型目录失败: {e}"))?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(900))
        .build()
        .map_err(|e| e.to_string())?;
    for file in MODEL_FILES {
        let dest = dir.join(file);
        if dest.is_file() {
            continue;
        }
        // huggingface 直连与 hf-mirror 镜像二选一（中国大陆网络通常只有镜像可达）
        let mut last_err = String::new();
        let mut done = false;
        for base in ["https://huggingface.co", "https://hf-mirror.com"] {
            let url = format!("{}/{}/resolve/main/{}", base, spec.repo, file);
            log::info!("[local_mt] downloading {url}");
            match client.get(&url).send().await {
                Ok(resp) if resp.status().is_success() => match resp.bytes().await {
                    Ok(bytes) => {
                        std::fs::write(&dest, &bytes)
                            .map_err(|e| format!("写入 {file} 失败: {e}"))?;
                        log::info!("[local_mt] downloaded {} ({} bytes)", file, bytes.len());
                        done = true;
                        break;
                    }
                    Err(e) => last_err = format!("{url}: {e}"),
                },
                Ok(resp) => last_err = format!("{url}: HTTP {}", resp.status()),
                Err(e) => last_err = format!("{url}: {e}"),
            }
        }
        if !done {
            return Err(format!(
                "下载 {file} 失败（huggingface.co / hf-mirror.com 均不可达）: {last_err}"
            ));
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn local_mt_delete_model(app_handle: AppHandle, pair: String) -> Result<(), String> {
    let dir = model_dir(&app_handle, &pair)?;
    translator_cache()
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&pair);
    if dir.is_dir() {
        std::fs::remove_dir_all(&dir).map_err(|e| format!("删除模型目录失败: {e}"))?;
    }
    Ok(())
}

fn load_translator(
    app_handle: &AppHandle,
    pair: &str,
    threads: usize,
) -> Result<Arc<MtTranslator>, String> {
    {
        let cache = translator_cache().lock().map_err(|e| e.to_string())?;
        if let Some((cached_threads, translator)) = cache.get(pair) {
            if *cached_threads == threads {
                return Ok(Arc::clone(translator));
            }
        }
    }
    let dir = model_dir(app_handle, pair)?;
    let missing: Vec<&str> = MODEL_FILES
        .iter()
        .copied()
        .filter(|f| !dir.join(f).is_file())
        .collect();
    if !missing.is_empty() {
        return Err(format!(
            "本地离线翻译模型未下载（缺 {}），请在 设置 → 翻译服务 → 本地离线翻译 中下载",
            missing.join(", ")
        ));
    }
    let config = Ct2Config {
        // 模型已按 int8 量化，DEFAULT 保持量化精度推理（等价 Python 基准的 compute_type='int8'）
        compute_type: ComputeType::DEFAULT,
        num_threads_per_replica: threads.max(1),
        ..Ct2Config::default()
    };
    let translator =
        Translator::new(&dir, &config).map_err(|e| format!("加载翻译模型失败: {e}"))?;
    let translator = Arc::new(translator);
    translator_cache()
        .lock()
        .map_err(|e| e.to_string())?
        .insert(pair.to_string(), (threads, Arc::clone(&translator)));
    Ok(translator)
}

#[tauri::command]
pub async fn local_mt_translate(
    app_handle: AppHandle,
    pair: String,
    text: String,
    threads: Option<u32>,
) -> Result<String, String> {
    let spec = model_spec(&pair)?;
    let threads = threads.unwrap_or(4) as usize;
    let translator = load_translator(&app_handle, &pair, threads)?;
    let results = match spec.target_prefix {
        Some(prefix) => translator.translate_batch_with_target_prefix(
            &[text.as_str()],
            &vec![vec![prefix]],
            &Default::default(),
            None,
        ),
        None => translator.translate_batch(&[text.as_str()], &Default::default(), None),
    };
    let results = results.map_err(|e| format!("本地翻译失败: {e}"))?;
    let first = results
        .into_iter()
        .next()
        .map(|(translated, _score)| translated)
        .ok_or_else(|| "本地翻译没有返回结果".to_string())?;
    Ok(first)
}
