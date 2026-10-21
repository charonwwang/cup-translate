//! Pinned Piper voices, atomic installation, and in-process CPU synthesis.
//! Downloads contain only public, fixed assets; synthesis never makes a request.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::Duration,
};

include!(concat!(env!("OUT_DIR"), "/piper_data.rs"));
include!(concat!(env!("OUT_DIR"), "/piper_runtime.rs"));

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Voice {
    id: String,
    name: String,
    language: String,
    locale: String,
    quality: String,
    base: String,
    revision: String,
    files: Vec<Asset>,
    sample: String,
    model_card: String,
}
#[derive(Clone, Deserialize, Serialize)]
struct Asset {
    name: String,
    bytes: u64,
    sha256: String,
}
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Task {
    state: String,
    downloaded: u64,
    total: u64,
    error: String,
    #[serde(skip)]
    cancelled: bool,
}
fn tasks() -> &'static Mutex<HashMap<String, Task>> {
    static TASKS: OnceLock<Mutex<HashMap<String, Task>>> = OnceLock::new();
    TASKS.get_or_init(Default::default)
}
fn engine() -> &'static Mutex<()> {
    static ENGINE: Mutex<()> = Mutex::new(());
    &ENGINE
}
fn catalog() -> Vec<Voice> {
    serde_json::from_str(include_str!("../resources/piper-catalog.json"))
        .expect("bundled voice catalog")
}
fn voice(id: &str) -> Result<Voice, String> {
    catalog()
        .into_iter()
        .find(|v| v.id == id)
        .ok_or_else(|| "Unknown Piper voice".into())
}
fn root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path_resolver()
        .app_config_dir()
        .ok_or("Configuration directory unavailable")?
        .join("models/piper"))
}
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn verify_file(path: &Path, asset: &Asset) -> Result<(), String> {
    let meta = fs::symlink_metadata(path).map_err(err)?;
    if !meta.file_type().is_file() || meta.len() != asset.bytes {
        return Err("Voice asset has an invalid size or file type".into());
    }
    let mut f = fs::File::open(path).map_err(err)?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let n = f.read(&mut buffer).map_err(err)?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    if format!("{:x}", hash.finalize()) != asset.sha256 {
        return Err("Voice asset checksum mismatch".into());
    }
    Ok(())
}
fn verify(dir: &Path, v: &Voice) -> Result<(), String> {
    for asset in v.files.iter().filter(|f| !f.name.starts_with("samples/")) {
        verify_file(&dir.join(&asset.name), asset)?;
    }
    Ok(())
}
fn prepare_data(app: &tauri::AppHandle) -> Result<(), String> {
    static READY: OnceLock<Result<(), String>> = OnceLock::new();
    READY
        .get_or_init(|| {
            let base = app
                .path_resolver()
                .app_cache_dir()
                .ok_or("Cache directory unavailable")?
                .join("piper-espeak-0.2.0-full-cmn");
            prepare_runtime(&base)?;
            for (name, data) in ESPEAK_DATA {
                let file = base.join("espeak-ng-data").join(name);
                if fs::read(&file).ok().as_deref() != Some(*data) {
                    fs::create_dir_all(file.parent().unwrap()).map_err(err)?;
                    fs::write(file, data).map_err(err)?;
                }
            }
            std::env::set_var("PIPER_ESPEAKNG_DATA_DIRECTORY", &base);
            Ok(())
        })
        .clone()
}
fn prepare_runtime(base: &Path) -> Result<(), String> {
    let base = base.join("onnxruntime-1.24.2");
    fs::create_dir_all(&base).map_err(err)?;
    let mut library = None;
    for (name, data) in ORT_LIBS {
        let file = base.join(name);
        if fs::read(&file).ok().as_deref() != Some(*data) {
            fs::write(&file, data).map_err(err)?;
        }
        if *name == "onnxruntime.dll"
            || name.ends_with(".dylib")
            || (name.starts_with("libonnxruntime.so") && !name.contains("providers"))
        {
            library = Some(file);
        }
    }
    let path = library.ok_or("Bundled ONNX Runtime missing")?;
    ort::init_from(path)
        .map_err(|_| "Cannot load bundled Piper runtime on this operating system")?
        .with_name("cup-piper-cpu")
        .with_telemetry(false)
        .commit();
    ort::environment::Environment::current()
        .map_err(|_| "Cannot initialize Piper runtime")?
        .set_log_level(ort::logging::LogLevel::Warning);
    Ok(())
}
fn platform_supported() -> bool {
    #[cfg(target_os = "macos")]
    {
        return std::process::Command::new("/usr/bin/sw_vers")
            .arg("-productVersion")
            .output()
            .ok()
            .filter(|o| o.status.success())
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .and_then(|v| {
                v.trim()
                    .split('.')
                    .next()
                    .and_then(|v| v.parse::<u32>().ok())
            })
            .is_some_and(|v| v >= 14);
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}
fn synthesize(
    app: &tauri::AppHandle,
    dir: &Path,
    v: &Voice,
    text: &str,
) -> Result<Vec<u8>, String> {
    prepare_data(app)?;
    let mut model = piper_rs::Piper::new(
        &dir.join(format!("{}.onnx", v.id)),
        &dir.join(format!("{}.onnx.json", v.id)),
    )
    .map_err(|_| "Cannot load Piper voice; reinstall this voice".to_string())?;
    let (samples, rate) = model
        .create(text, false, None, None, None, None)
        .map_err(|_| "Piper speech synthesis failed")?;
    wave(&samples, rate)
}
fn wave(samples: &[f32], rate: u32) -> Result<Vec<u8>, String> {
    if samples.is_empty() || samples.len() > 22_050 * 600 || samples.iter().any(|s| !s.is_finite())
    {
        return Err("Invalid or oversized speech output".into());
    }
    let len = (samples.len() * 2) as u32;
    let mut bytes = Vec::with_capacity(44 + len as usize);
    bytes.extend(b"RIFF");
    bytes.extend((36 + len).to_le_bytes());
    bytes.extend(b"WAVEfmt ");
    bytes.extend(16u32.to_le_bytes());
    bytes.extend(1u16.to_le_bytes());
    bytes.extend(1u16.to_le_bytes());
    bytes.extend(rate.to_le_bytes());
    bytes.extend((rate * 2).to_le_bytes());
    bytes.extend(2u16.to_le_bytes());
    bytes.extend(16u16.to_le_bytes());
    bytes.extend(b"data");
    bytes.extend(len.to_le_bytes());
    for s in samples {
        bytes.extend(((s.clamp(-1., 1.) * 32767.) as i16).to_le_bytes());
    }
    Ok(bytes)
}
fn normalize(lang: &str) -> String {
    lang.trim().to_lowercase().replace('_', "-")
}
fn matches(v: &Voice, lang: &str) -> bool {
    let lang = normalize(lang);
    if lang.is_empty() || lang == "auto" {
        return false;
    }
    // Mandarin voices must never be selected for Cantonese.
    v.language == lang.split('-').next().unwrap_or("") || (v.language == "zh" && lang == "cmn")
}
fn select_voice<'a>(
    voices: &'a [Voice],
    lang: &str,
    preferred: Option<&str>,
    installed: impl Fn(&Voice) -> bool,
) -> Result<&'a Voice, String> {
    if let Some(id) = preferred {
        let selected = voices
            .iter()
            .find(|v| v.id == id)
            .ok_or("Unknown Piper voice preference")?;
        if !matches(selected, lang) {
            return Err("Selected Piper voice does not match this language".into());
        }
        if !installed(selected) {
            return Err(
                "Selected Piper voice is not installed; open Settings > Models and Connections"
                    .into(),
            );
        }
        return Ok(selected);
    }
    let exact = normalize(lang);
    voices
        .iter()
        .filter(|v| matches(v, lang) && installed(v))
        .min_by_key(|v| normalize(&v.locale) != exact)
        .ok_or_else(|| {
            "No installed Piper voice for this language; open Settings > Models and Connections"
                .into()
        })
}
fn ready_cached(dir: &Path, v: &Voice) -> bool {
    type Fingerprint = Vec<(u64, Option<std::time::SystemTime>)>;
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, (Fingerprint, bool)>>> = OnceLock::new();
    let signature: Option<Fingerprint> = v
        .files
        .iter()
        .filter(|a| !a.name.starts_with("samples/"))
        .map(|a| {
            let meta = fs::symlink_metadata(dir.join(&a.name)).ok()?;
            if !meta.file_type().is_file() || meta.len() != a.bytes {
                return None;
            }
            Some((meta.len(), meta.modified().ok()))
        })
        .collect();
    let Some(signature) = signature else {
        return false;
    };
    let Ok(mut cache) = CACHE.get_or_init(Default::default).lock() else {
        return false;
    };
    if let Some((previous, ready)) = cache.get(dir) {
        if *previous == signature {
            return *ready;
        }
    }
    let ready = verify(dir, v).is_ok();
    cache.insert(dir.to_path_buf(), (signature, ready));
    ready
}
#[tauri::command]
pub async fn piper_catalog(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    if !platform_supported() {
        return Ok(
            serde_json::json!({"supported":false,"voices":[],"reason":"Piper requires macOS 14 or newer"}),
        );
    }
    tauri::async_runtime::spawn_blocking(move || {
        let root = root(&app)?; let current = tasks().lock().map_err(err)?.clone();
        let voices: Vec<_> = catalog().into_iter().map(|v| {
            let installed = ready_cached(&root.join(&v.id), &v);
            let task = current.get(&v.id).cloned().unwrap_or_else(|| Task { state: if installed {"ready"} else {"not_installed"}.into(), ..Default::default() });
            serde_json::json!({"voice":v,"installed":installed,"task":task})
        }).collect(); Ok(serde_json::json!({"supported":true,"voices":voices,"runtime":"Piper / ONNX Runtime CPU · eSpeak NG"}))
    }).await.map_err(err)?
}
struct DownloadGuard {
    id: String,
    finished: bool,
}
impl Drop for DownloadGuard {
    fn drop(&mut self) {
        if !self.finished {
            if let Ok(mut tasks) = tasks().lock() {
                if let Some(t) = tasks.get_mut(&self.id) {
                    if t.state == "downloading" || t.state == "checking" {
                        t.state = "error".into();
                        t.error = "Installation interrupted; retry this voice".into();
                    }
                }
            }
        }
    }
}
fn cancelled(id: &str) -> Result<(), String> {
    if tasks()
        .lock()
        .map_err(err)?
        .get(id)
        .is_some_and(|t| t.cancelled)
    {
        Err("Voice download cancelled".into())
    } else {
        Ok(())
    }
}
#[tauri::command]
pub async fn piper_download(
    app: tauri::AppHandle,
    id: String,
    accepted: bool,
) -> Result<(), String> {
    if !accepted {
        return Err("Review the voice model card before downloading".into());
    }
    if !platform_supported() {
        return Err("Piper requires macOS 14 or newer".into());
    }
    let v = voice(&id)?;
    let root = root(&app)?;
    let total = v
        .files
        .iter()
        .filter(|a| !a.name.starts_with("samples/"))
        .map(|a| a.bytes)
        .sum();
    {
        let mut tasks = tasks().lock().map_err(err)?;
        if tasks
            .values()
            .any(|t| t.state == "downloading" || t.state == "checking")
        {
            return Err("Another voice installation is active".into());
        }
        tasks.insert(
            id.clone(),
            Task {
                state: "downloading".into(),
                total,
                ..Default::default()
            },
        );
    }
    let mut guard = DownloadGuard {
        id: id.clone(),
        finished: false,
    };
    let result = async {
        fs::create_dir_all(&root).map_err(err)?;
        let stage = root.join(format!(".{}-staging", id));
        fs::create_dir_all(&stage).map_err(err)?;
        let client = reqwest::Client::builder()
            .https_only(true)
            .connect_timeout(Duration::from_secs(20))
            .timeout(Duration::from_secs(600))
            .build()
            .map_err(|_| "Voice download client unavailable")?;
        let mut done = 0;
        for asset in v.files.iter().filter(|a| !a.name.starts_with("samples/")) {
            cancelled(&id)?;
            let path = stage.join(&asset.name);
            if verify_file(&path, asset).is_ok() {
                done += asset.bytes;
                continue;
            }
            let mut response = client
                .get(format!("{}/{}", v.base, asset.name))
                .send()
                .await
                .map_err(|_| "Voice download failed; retry when connected")?
                .error_for_status()
                .map_err(|_| "Voice download server returned an error")?;
            let mut file = fs::File::create(&path).map_err(err)?;
            let mut received = 0;
            loop {
                cancelled(&id)?;
                let chunk = tokio::select! {
                    chunk = response.chunk() => chunk.map_err(|_| "Voice download interrupted; retry")?,
                    _ = tokio::time::sleep(Duration::from_millis(200)) => continue,
                };
                let Some(chunk) = chunk else { break; };
                received += chunk.len() as u64;
                if received > asset.bytes {
                    return Err("Voice download exceeded its pinned size".into());
                }
                file.write_all(&chunk).map_err(err)?;
                if let Some(t) = tasks().lock().map_err(err)?.get_mut(&id) {
                    t.downloaded = done + received;
                }
            }
            file.sync_all().map_err(err)?;
            verify_file(&path, asset)?;
            done += asset.bytes;
        }
        cancelled(&id)?;
        if let Some(t) = tasks().lock().map_err(err)?.get_mut(&id) {
            t.state = "checking".into();
            t.downloaded = total;
        }
        let a = app.clone();
        let st = stage.clone();
        let vc = v.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let _lock = engine().lock().map_err(err)?;
            verify(&st, &vc)?;
            synthesize(&a, &st, &vc, &vc.sample).map(|_| ())
        })
        .await
        .map_err(err)??;
        cancelled(&id)?;
        let _lock = engine().lock().map_err(err)?;
        let destination = root.join(&id);
        // A valid existing voice is never replaced by a failed installation.
        if destination.exists() {
            if verify(&destination, &v).is_ok() {
                fs::remove_dir_all(&stage).map_err(err)?;
            } else {
                fs::remove_dir_all(&destination).map_err(err)?;
                fs::rename(&stage, &destination).map_err(err)?;
            }
        } else {
            fs::rename(&stage, &destination).map_err(err)?;
        }
        Ok(())
    }
    .await;
    if let Some(t) = tasks().lock().map_err(err)?.get_mut(&id) {
        match &result {
            Ok(()) => {
                t.state = "ready".into();
                t.error.clear();
            }
            Err(_) if t.cancelled => {
                t.state = "cancelled".into();
            }
            Err(_) => {
                t.state = "error".into();
                t.error =
                    "Voice installation failed; check connection, free space, and retry".into();
            }
        }
    }
    guard.finished = true;
    result
}
#[tauri::command]
pub fn piper_cancel(id: String) -> Result<(), String> {
    voice(&id)?;
    if let Some(t) = tasks().lock().map_err(err)?.get_mut(&id) {
        if t.state == "downloading" {
            t.cancelled = true;
        }
    }
    Ok(())
}
#[tauri::command]
pub async fn piper_uninstall(app: tauri::AppHandle, id: String) -> Result<(), String> {
    voice(&id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = engine()
            .try_lock()
            .map_err(|_| "Speech is active; stop playback and try again")?;
        let mut tasks = tasks().lock().map_err(err)?;
        if tasks
            .get(&id)
            .is_some_and(|t| t.state == "downloading" || t.state == "checking")
        {
            return Err("Cancel the active download before uninstalling".into());
        }
        for path in [
            root(&app)?.join(&id),
            root(&app)?.join(format!(".{}-staging", id)),
        ] {
            if path.exists() {
                fs::remove_dir_all(path).map_err(err)?;
            }
        }
        if let Some(cache) = app.path_resolver().app_cache_dir() {
            let _ = fs::remove_file(cache.join("piper-previews").join(format!("{}.mp3", id)));
        }
        tasks.remove(&id);
        Ok(())
    })
    .await
    .map_err(err)?
}
#[tauri::command]
pub async fn piper_speak(
    app: tauri::AppHandle,
    text: String,
    lang: String,
    voice_id: Option<String>,
) -> Result<Vec<u8>, String> {
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    if text.chars().count() > 3000 || text.contains('\0') {
        return Err("Piper accepts up to 3000 characters per request".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = engine()
            .try_lock()
            .map_err(|_| "Piper is busy; try again shortly")?;
        let root = root(&app)?;
        let voices = catalog();
        let v = select_voice(&voices, &lang, voice_id.as_deref(), |v| {
            verify(&root.join(&v.id), v).is_ok()
        })?;
        synthesize(&app, &root.join(&v.id), v, &text)
    })
    .await
    .map_err(err)?
}
#[tauri::command]
pub async fn piper_preview(app: tauri::AppHandle, id: String) -> Result<Vec<u8>, String> {
    let v = voice(&id)?;
    let installed = root(&app)?.join(&v.id);
    if verify(&installed, &v).is_ok() {
        return piper_speak(app, v.sample, v.language, Some(id)).await;
    }
    // Explicit preview fetches a pinned public sample only, never the user's text.
    let asset = v
        .files
        .iter()
        .find(|a| a.name.starts_with("samples/"))
        .ok_or("Preview unavailable")?;
    let cache = app
        .path_resolver()
        .app_cache_dir()
        .ok_or("Cache unavailable")?
        .join("piper-previews");
    fs::create_dir_all(&cache).map_err(err)?;
    let path = cache.join(format!("{}.mp3", v.id));
    if verify_file(&path, asset).is_err() {
        let client = reqwest::Client::builder()
            .https_only(true)
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(err)?;
        let mut response = client
            .get(format!("{}/{}", v.base, asset.name))
            .send()
            .await
            .map_err(|_| "Preview download failed")?
            .error_for_status()
            .map_err(|_| "Preview unavailable")?;
        let mut data = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| "Preview interrupted")? {
            if data.len() + chunk.len() > asset.bytes as usize {
                return Err("Invalid preview size".into());
            }
            data.extend(&chunk);
        }
        if data.len() as u64 != asset.bytes
            || format!("{:x}", Sha256::digest(&data)) != asset.sha256
        {
            return Err("Preview checksum mismatch".into());
        }
        fs::write(&path, &data).map_err(err)?;
    }
    fs::read(path).map_err(err)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "requires installed pinned voices in CUP_PIPER_MODEL_DIR"]
    fn real_piper_voices_produce_wave_without_external_runtime() {
        let root = PathBuf::from(std::env::var("CUP_PIPER_MODEL_DIR").expect("voice root"));
        let data = std::env::temp_dir().join(format!("cup-piper-real-data-{}", std::process::id()));
        for (name, bytes) in ESPEAK_DATA {
            let path = data.join("espeak-ng-data").join(name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, bytes).unwrap();
        }
        prepare_runtime(&data).unwrap();
        std::env::set_var("PIPER_ESPEAKNG_DATA_DIRECTORY", &data);
        let mut count = 0;
        for v in catalog() {
            let dir = root.join(&v.id);
            if !dir.is_dir() {
                continue;
            }
            verify(&dir, &v).unwrap();
            let mut model = piper_rs::Piper::new(
                &dir.join(format!("{}.onnx", v.id)),
                &dir.join(format!("{}.onnx.json", v.id)),
            )
            .unwrap();
            let started = std::time::Instant::now();
            let (samples, rate) = model
                .create(&v.sample, false, None, None, None, None)
                .unwrap();
            let bytes = wave(&samples, rate).unwrap();
            assert!(bytes.len() > 44);
            assert!(samples.iter().any(|x| x.abs() > 0.01));
            println!(
                "{}: {} Hz, {:.2}s audio, {:?} synthesis",
                v.id,
                rate,
                samples.len() as f32 / rate as f32,
                started.elapsed()
            );
            count += 1;
        }
        if let Ok(path) = std::env::var("CUP_M2M_MODEL_DIR") {
            use ct2rs::Tokenizer;
            let spm = PathBuf::from(path).join("sentencepiece.bpe.model");
            let tokenizer =
                ct2rs::tokenizers::sentencepiece::Tokenizer::from_file(&spm, &spm).unwrap();
            assert!(!tokenizer
                .encode("Piper and translation can coexist.")
                .unwrap()
                .is_empty());
            println!("SentencePiece initialized and encoded after Piper in the same process");
        }
        assert!(
            count >= 2,
            "Install at least two language voices for this integration check"
        );
        let _ = fs::remove_dir_all(data);
    }
    #[test]
    fn voice_routing_does_not_cross_languages() {
        let c = catalog();
        let all = |_: &Voice| true;
        assert!(select_voice(&c, "ja", None, all).is_err());
        assert!(select_voice(&c, "auto", None, all).is_err());
        assert!(select_voice(&c, "yue", None, all).is_err());
        assert!(select_voice(&c, "en", Some("zh_CN-huayan-medium"), all).is_err());
        assert_eq!(
            select_voice(&c, "EN-gb", None, all).unwrap().id,
            "en_GB-alba-medium"
        );
        assert_eq!(select_voice(&c, "zh_tw", None, all).unwrap().language, "zh");
        assert!(select_voice(&c, "en", None, |_| false).is_err());
    }
    #[test]
    fn bundled_phonemizer_has_full_mandarin_dictionary() {
        assert!(
            ESPEAK_DATA
                .iter()
                .find(|(name, _)| *name == "cmn_dict")
                .unwrap()
                .1
                .len()
                > 1_000_000
        );
    }
    #[test]
    fn pinned_assets_and_model_cards_are_complete() {
        for v in catalog() {
            assert_eq!(v.files.len(), 4);
            assert!(!v.model_card.is_empty());
            assert!(v.base.contains(&v.revision));
            for a in v.files {
                assert_eq!(a.sha256.len(), 64);
                assert!(a.bytes > 0);
                assert!(!a.name.contains(".."));
            }
        }
    }
    #[test]
    fn audio_is_pcm_wave_and_rejects_invalid_samples() {
        let w = wave(&[0., 0.5, -0.5], 22050).unwrap();
        assert_eq!(&w[..4], b"RIFF");
        assert_eq!(&w[8..12], b"WAVE");
        assert_eq!(w.len(), 50);
        assert!(wave(&[f32::NAN], 22050).is_err());
    }
    #[test]
    fn checksum_rejects_wrong_bytes_and_truncation() {
        let path = std::env::temp_dir().join(format!("cup-piper-hash-{}", std::process::id()));
        fs::write(&path, b"abc").unwrap();
        let mut a = Asset {
            name: "x".into(),
            bytes: 3,
            sha256: format!("{:x}", Sha256::digest(b"abc")),
        };
        assert!(verify_file(&path, &a).is_ok());
        a.sha256 = "0".repeat(64);
        assert!(verify_file(&path, &a).is_err());
        a.bytes = 4;
        assert!(verify_file(&path, &a).is_err());
        let _ = fs::remove_file(path);
    }
}
