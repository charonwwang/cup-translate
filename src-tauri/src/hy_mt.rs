//! HY-MT1.5 GGUF inference. No server, Python, telemetry, or remote text requests.
use crate::local_mt_tasks::Cancellation;
use llama_cpp_2::{
    context::params::LlamaContextParams,
    llama_backend::LlamaBackend,
    llama_batch::LlamaBatch,
    model::{params::LlamaModelParams, LlamaChatMessage, LlamaModel},
    sampling::LlamaSampler,
};
use std::{
    collections::HashMap,
    num::NonZeroU32,
    path::Path,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};
fn backend() -> Result<&'static LlamaBackend, String> {
    static BACKEND: OnceLock<Result<LlamaBackend, String>> = OnceLock::new();
    BACKEND
        .get_or_init(|| {
            llama_cpp_2::send_logs_to_tracing(llama_cpp_2::LogOptions::default());
            LlamaBackend::init().map_err(|_| "HY-MT CPU runtime unavailable".into())
        })
        .as_ref()
        .map_err(Clone::clone)
}
struct Cached {
    model: Arc<LlamaModel>,
    last: Instant,
}
fn cache() -> &'static Mutex<HashMap<String, Cached>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Cached>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}
pub(crate) fn loaded(id: &str) -> bool {
    cache()
        .try_lock()
        .map(|c| c.contains_key(id))
        .unwrap_or(false)
}
pub(crate) fn unload(id: &str) -> Result<(), String> {
    let mut c = cache().lock().map_err(|_| "HY-MT cache unavailable")?;
    if c.get(id).is_some_and(|v| Arc::strong_count(&v.model) > 1) {
        return Err("HY-MT is translating; retry when complete".into());
    }
    c.remove(id);
    Ok(())
}
pub(crate) fn file(id: &str) -> Result<&'static str, String> {
    match id {
        "hymt-q4" => Ok("HY-MT1.5-1.8B-Q4_K_M.gguf"),
        "hymt-q8" => Ok("HY-MT1.5-1.8B-Q8_0.gguf"),
        _ => Err("Unknown HY-MT specification".into()),
    }
}
pub(crate) fn language(code: &str) -> Option<&'static str> {
    Some(match code {
        "zh" | "zh_cn" => "Simplified Chinese",
        "zh_tw" => "Traditional Chinese",
        "en" => "English",
        "fr" => "French",
        "pt" => "Portuguese",
        "pt_br" => "Brazilian Portuguese",
        "pt_pt" => "European Portuguese",
        "es" => "Spanish",
        "ja" => "Japanese",
        "tr" => "Turkish",
        "ru" => "Russian",
        "ar" => "Arabic",
        "ko" => "Korean",
        "th" => "Thai",
        "it" => "Italian",
        "de" => "German",
        "vi" => "Vietnamese",
        "ms" => "Malay",
        "id" => "Indonesian",
        "tl" => "Filipino",
        "hi" => "Hindi",
        "pl" => "Polish",
        "cs" => "Czech",
        "nl" => "Dutch",
        "km" => "Khmer",
        "my" => "Burmese",
        "fa" => "Persian",
        "gu" => "Gujarati",
        "ur" => "Urdu",
        "te" => "Telugu",
        "mr" => "Marathi",
        "he" => "Hebrew",
        "bn" => "Bengali",
        "ta" => "Tamil",
        "uk" => "Ukrainian",
        "bo" => "Tibetan",
        "kk" => "Kazakh",
        "mn" | "mn_cy" => "Mongolian",
        "ug" => "Uyghur",
        _ => return None,
    })
}
pub(crate) fn direction(from: &str, to: &str) -> Result<(), String> {
    if from == to || language(from).is_none() || language(to).is_none() {
        Err("HY-MT does not support this language direction".into())
    } else {
        Ok(())
    }
}
fn load(dir: &Path, id: &str) -> Result<Arc<LlamaModel>, String> {
    static REAPER: OnceLock<()> = OnceLock::new();
    REAPER.get_or_init(|| {
        std::thread::spawn(|| loop {
            std::thread::sleep(Duration::from_secs(30));
            if let Ok(mut c) = cache().lock() {
                c.retain(|_, v| {
                    v.last.elapsed() < Duration::from_secs(120) || Arc::strong_count(&v.model) > 1
                });
            }
        });
    });
    let mut c = cache().lock().map_err(|_| "HY-MT cache unavailable")?;
    if let Some(v) = c.get_mut(id) {
        v.last = Instant::now();
        return Ok(v.model.clone());
    }
    // Keep only active requests when switching specification on a modest machine.
    c.retain(|_, entry| Arc::strong_count(&entry.model) > 1);
    let model = Arc::new(
        LlamaModel::load_from_file(
            backend()?,
            dir.join(file(id)?),
            &LlamaModelParams::default()
                .with_n_gpu_layers(0)
                .with_use_mmap(true),
        )
        .map_err(|_| "Cannot load HY-MT GGUF; verify or reinstall this specification")?,
    );
    c.insert(
        id.into(),
        Cached {
            model: model.clone(),
            last: Instant::now(),
        },
    );
    Ok(model)
}
pub(crate) fn translate(
    dir: &Path,
    id: &str,
    text: &str,
    from: &str,
    to: &str,
    threads: usize,
    cancel: &Cancellation,
) -> Result<String, String> {
    direction(from, to)?;
    cancel.check()?;
    let model = load(dir, id)?;
    cancel.check()?;
    let mut result = Vec::new();
    let chars: Vec<char> = text.chars().collect();
    for part in chars.chunks(500) {
        cancel.check()?;
        let part: String = part.iter().collect();
        result.push(decode(&model, &part, from, to, threads, cancel)?);
    }
    if let Ok(mut c) = cache().lock() {
        if let Some(v) = c.get_mut(id) {
            v.last = Instant::now();
        }
    }
    Ok(result.join("\n"))
}
fn decode(
    model: &LlamaModel,
    text: &str,
    from: &str,
    to: &str,
    threads: usize,
    cancel: &Cancellation,
) -> Result<String, String> {
    let prompt = format!(
        "Translate the following segment from {} into {}, without additional explanation.\n\n{}",
        language(from).ok_or("Unsupported source language")?,
        language(to).ok_or("Unsupported target language")?,
        text
    );
    let template = model
        .chat_template(None)
        .map_err(|_| "HY-MT chat template missing")?;
    let prompt = model
        .apply_chat_template(
            &template,
            &[LlamaChatMessage::new("user".into(), prompt)
                .map_err(|_| "Invalid translation text")?],
            true,
        )
        .map_err(|_| "HY-MT prompt formatting failed")?;
    let vocab = model.vocab();
    let tokens = vocab.tokenize(prompt.as_bytes(), true, true);
    if tokens.len() > 1100 {
        return Err("HY-MT input chunk exceeds its local context; shorten this text".into());
    }
    let params = LlamaContextParams::default()
        .with_n_ctx(NonZeroU32::new(2048))
        .with_n_batch(256)
        .with_n_threads(threads.min(8) as i32)
        .with_n_threads_batch(threads.min(8) as i32);
    let mut ctx = model
        .new_context(backend()?, params)
        .map_err(|_| "Cannot allocate HY-MT context; close other applications")?;
    let mut batch = LlamaBatch::new(256, 1);
    for (offset, chunk) in tokens.chunks(256).enumerate() {
        cancel.check()?;
        batch.clear();
        for (i, t) in chunk.iter().enumerate() {
            let pos = offset * 256 + i;
            batch
                .add(*t, pos as i32, &[0], pos + 1 == tokens.len())
                .map_err(|_| "HY-MT input batching failed")?;
        }
        ctx.decode(&mut batch)
            .map_err(|_| "HY-MT prompt evaluation failed")?;
    }
    let mut sampler = LlamaSampler::greedy();
    let mut generated = Vec::new();
    let start = Instant::now();
    for index in 0..900 {
        cancel.check()?;
        if start.elapsed() > Duration::from_secs(120) {
            return Err("HY-MT translation timed out; shorten this text".into());
        }
        let token = sampler.sample(&ctx, -1);
        if vocab.is_eog(token) {
            let bytes = vocab.detokenize(&generated, true, false);
            let output = String::from_utf8(bytes).map_err(|_| "HY-MT returned invalid UTF-8")?;
            let output = output.trim();
            if output.is_empty() {
                return Err("HY-MT returned an empty translation".into());
            }
            return Ok(output.to_owned());
        }
        sampler.accept(token);
        generated.push(token);
        batch.clear();
        batch
            .add(token, (tokens.len() + index) as i32, &[0], true)
            .map_err(|_| "HY-MT output batching failed")?;
        ctx.decode(&mut batch)
            .map_err(|_| "HY-MT decoding failed")?;
    }
    Err("HY-MT reached its output limit; shorten this text".into())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unsupported_and_missing_languages_are_rejected() {
        assert!(direction("auto", "en").is_err());
        assert!(direction("en", "en").is_err());
        assert!(direction("en", "ja").is_ok());
        assert!(direction("zh_cn", "fr").is_ok());
        assert!(direction("en", "zh_tw").is_ok());
        assert!(direction("en", "sv").is_err());
    }
    #[test]
    #[ignore = "requires pinned Q4 GGUF in CUP_HY_MODEL_DIR"]
    fn real_hy_translates_multiple_directions() {
        let dir = std::path::PathBuf::from(std::env::var("CUP_HY_MODEL_DIR").unwrap());
        for (from, to, text) in [
            ("en", "zh_cn", "Please close the window."),
            ("en", "fr", "Good morning."),
            ("ja", "en", "今日はいい天気です。"),
        ] {
            let start = Instant::now();
            let out =
                translate(&dir, "hymt-q4", text, from, to, 4, &Cancellation::default()).unwrap();
            println!("{from}->{to}: {out} ({:?})", start.elapsed());
            assert!(!out.is_empty());
        }
        unload("hymt-q4").unwrap();
    }
}
