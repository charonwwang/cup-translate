//! One multilingual Kokoro weight package, many selectable speaker embeddings.
//! Sherpa's C ABI is loaded from a pinned official release; no Python/server.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    ffi::{c_char, c_void, CString},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::Duration,
};
#[path = "kokoro_ffi.rs"]
mod ffi;
include!(concat!(env!("OUT_DIR"), "/kokoro_runtime.rs"));
const INSTALL_TEST_TEXT: &str = "你好，这是本地语音测试。";
#[derive(Clone, Deserialize, Serialize)]
struct File {
    name: String,
    bytes: u64,
    sha256: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    id: String,
    family: String,
    name: String,
    url: String,
    archive_bytes: u64,
    archive_sha256: String,
    files: Vec<File>,
}
#[derive(Clone, Deserialize, Serialize)]
struct Voice {
    sid: i32,
    name: String,
    language: String,
    sample: String,
    url: String,
    bytes: u64,
    sha256: String,
}
#[derive(Clone, Default, Serialize)]
struct Task {
    state: String,
    downloaded: u64,
    total: u64,
    error: String,
    #[serde(skip)]
    cancelled: bool,
}
fn manifest() -> Manifest {
    serde_json::from_str(include_str!("../resources/kokoro-model.json")).expect("Kokoro manifest")
}
fn voices() -> Vec<Voice> {
    serde_json::from_str(include_str!("../resources/kokoro-voices.json")).expect("Kokoro voices")
}
fn task() -> &'static Mutex<Task> {
    static TASK: OnceLock<Mutex<Task>> = OnceLock::new();
    TASK.get_or_init(Default::default)
}
fn engine_lock() -> &'static Mutex<()> {
    static ENGINE: Mutex<()> = Mutex::new(());
    &ENGINE
}
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path_resolver()
        .app_config_dir()
        .ok_or("Configuration directory unavailable")?
        .join("models/kokoro-v1-0-int8"))
}
fn hash_file(path: &Path) -> Result<String, String> {
    let mut f = fs::File::open(path).map_err(err)?;
    let mut h = Sha256::new();
    let mut b = [0u8; 65536];
    loop {
        let n = f.read(&mut b).map_err(err)?;
        if n == 0 {
            break;
        }
        h.update(&b[..n]);
    }
    Ok(format!("{:x}", h.finalize()))
}
fn verify(dir: &Path) -> bool {
    manifest().files.iter().all(|f| {
        fs::symlink_metadata(dir.join(&f.name))
            .ok()
            .is_some_and(|m| m.file_type().is_file() && m.len() == f.bytes)
            && hash_file(&dir.join(&f.name)).ok().as_deref() == Some(&f.sha256)
    })
}
fn ready(dir: &Path) -> bool {
    type Fingerprint = Vec<(u64, Option<std::time::SystemTime>)>;
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, (Fingerprint, bool)>>> = OnceLock::new();
    let sig: Option<Fingerprint> = manifest()
        .files
        .iter()
        .map(|f| {
            let m = fs::symlink_metadata(dir.join(&f.name)).ok()?;
            if !m.file_type().is_file() || m.len() != f.bytes {
                return None;
            }
            Some((m.len(), m.modified().ok()))
        })
        .collect();
    let Some(sig) = sig else {
        return false;
    };
    let Ok(mut c) = CACHE.get_or_init(Default::default).lock() else {
        return false;
    };
    if let Some((old, valid)) = c.get(dir) {
        if *old == sig {
            return *valid;
        }
    }
    let valid = verify(dir);
    c.insert(dir.to_path_buf(), (sig, valid));
    valid
}
fn normalize(lang: &str) -> &str {
    match lang {
        "zh_cn" | "zh_tw" | "zh" | "cmn" => "zh",
        "pt_br" | "pt_pt" | "pt" => "pt",
        other => other,
    }
}
fn phoneme_language(lang: &str) -> Option<&'static str> {
    Some(match normalize(lang) {
        "zh" => "cmn",
        "en" => "en-us",
        "fr" => "fr",
        "es" => "es",
        "it" => "it",
        "pt" => "pt-br",
        "hi" => "hi",
        _ => return None,
    })
}
fn selected_voice(lang: &str, sid: Option<i32>) -> Result<Voice, String> {
    let lang = normalize(lang);
    if phoneme_language(lang).is_none() {
        return Err("Kokoro does not support this text language in this build".into());
    }
    let all = voices();
    if let Some(id) = sid {
        return all
            .into_iter()
            .find(|v| v.sid == id && v.language == lang)
            .ok_or_else(|| "Selected Kokoro voice does not match this text language".into());
    }
    all.into_iter()
        .find(|v| v.language == lang)
        .ok_or_else(|| "No Kokoro voice for this text language".into())
}
struct Runtime {
    _library: libloading::Library,
    create: unsafe extern "C" fn(*const ffi::OfflineTtsConfig) -> *const ffi::SherpaOnnxOfflineTts,
    destroy: unsafe extern "C" fn(*const ffi::SherpaOnnxOfflineTts),
    generate: unsafe extern "C" fn(
        *const ffi::SherpaOnnxOfflineTts,
        *const c_char,
        *const ffi::SherpaOnnxGenerationConfig,
        ffi::SherpaOnnxGeneratedAudioProgressCallbackWithArg,
        *mut c_void,
    ) -> *const ffi::SherpaOnnxGeneratedAudio,
    free_audio: unsafe extern "C" fn(*const ffi::SherpaOnnxGeneratedAudio),
}
fn runtime(cache: &Path) -> Result<&'static Runtime, String> {
    static RUNTIME: OnceLock<Result<Runtime, String>> = OnceLock::new();
    RUNTIME
        .get_or_init(|| {
            if KOKORO_LIBS.is_empty() {
                return Err("Kokoro runtime is unavailable on this platform".into());
            }
            let base = cache.join("sherpa-onnx-1.13.8");
            fs::create_dir_all(&base).map_err(err)?;
            let mut api = None;
            for (name, bytes) in KOKORO_LIBS {
                let path = base.join(name);
                if fs::read(&path).ok().as_deref() != Some(*bytes) {
                    fs::write(&path, bytes).map_err(err)?;
                }
                if name.contains("sherpa-onnx-c-api") {
                    api = Some(path);
                }
            }
            unsafe {
                let api = api.ok_or("Kokoro C API missing")?;
                #[cfg(windows)]
                let library: libloading::Library =
                    libloading::os::windows::Library::load_with_flags(
                        &api,
                        libloading::os::windows::LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR
                            | libloading::os::windows::LOAD_LIBRARY_SEARCH_DEFAULT_DIRS,
                    )
                    .map_err(|_| "Cannot load bundled Kokoro runtime")?
                    .into();
                #[cfg(not(windows))]
                let library = libloading::Library::new(api)
                    .map_err(|_| "Cannot load bundled Kokoro runtime")?;
                let create = *library.get(b"SherpaOnnxCreateOfflineTts\0").map_err(err)?;
                let destroy = *library.get(b"SherpaOnnxDestroyOfflineTts\0").map_err(err)?;
                let generate = *library
                    .get(b"SherpaOnnxOfflineTtsGenerateWithConfig\0")
                    .map_err(err)?;
                let free_audio = *library
                    .get(b"SherpaOnnxDestroyOfflineTtsGeneratedAudio\0")
                    .map_err(err)?;
                Ok(Runtime {
                    _library: library,
                    create,
                    destroy,
                    generate,
                    free_audio,
                })
            }
        })
        .as_ref()
        .map_err(Clone::clone)
}
struct Session<'a> {
    ptr: *const ffi::SherpaOnnxOfflineTts,
    runtime: &'a Runtime,
}
impl Drop for Session<'_> {
    fn drop(&mut self) {
        unsafe {
            (self.runtime.destroy)(self.ptr);
        }
    }
}
struct Audio<'a> {
    ptr: *const ffi::SherpaOnnxGeneratedAudio,
    runtime: &'a Runtime,
}
impl Drop for Audio<'_> {
    fn drop(&mut self) {
        unsafe {
            (self.runtime.free_audio)(self.ptr);
        }
    }
}
fn synthesize(
    cache: &Path,
    dir: &Path,
    text: &str,
    lang: &str,
    sid: Option<i32>,
) -> Result<Vec<u8>, String> {
    let v = selected_voice(lang, sid)?;
    let lang = phoneme_language(lang).ok_or("Unsupported language")?;
    let r = runtime(cache)?;
    let mut strings = Vec::<CString>::new();
    let mut cstr = |s: String| -> Result<*const c_char, String> {
        strings.push(CString::new(s).map_err(|_| "Invalid speech text or path")?);
        Ok(strings.last().unwrap().as_ptr())
    };
    let mut config: ffi::OfflineTtsConfig = unsafe { std::mem::zeroed() };
    config.model.num_threads = 2;
    config.model.provider = cstr("cpu".into())?;
    config.max_num_sentences = 1;
    config.silence_scale = 1.;
    config.model.kokoro.model = cstr(dir.join("model.int8.onnx").to_string_lossy().into())?;
    config.model.kokoro.voices = cstr(dir.join("voices.bin").to_string_lossy().into())?;
    config.model.kokoro.tokens = cstr(dir.join("tokens.txt").to_string_lossy().into())?;
    config.model.kokoro.data_dir = cstr(dir.join("espeak-ng-data").to_string_lossy().into())?;
    config.model.kokoro.dict_dir = cstr(dir.join("dict").to_string_lossy().into())?;
    config.model.kokoro.lexicon = cstr(
        ["lexicon-us-en.txt", "lexicon-zh.txt"]
            .map(|f| dir.join(f).to_string_lossy().into_owned())
            .join(","),
    )?;
    config.model.kokoro.lang = cstr(lang.into())?;
    config.model.kokoro.length_scale = 1.;
    if lang == "cmn" {
        config.rule_fsts = cstr(
            ["date-zh.fst", "number-zh.fst", "phone-zh.fst"]
                .map(|f| dir.join(f).to_string_lossy().into_owned())
                .join(","),
        )?;
    }
    let ptr = unsafe { (r.create)(&config) };
    if ptr.is_null() {
        return Err("Kokoro model initialization failed; verify or reinstall".into());
    }
    let session = Session { ptr, runtime: r };
    let text = CString::new(text).map_err(|_| "Speech text contains a null byte")?;
    let generation = ffi::SherpaOnnxGenerationConfig {
        silence_scale: 1.,
        speed: 1.,
        sid: v.sid,
        reference_audio: std::ptr::null(),
        reference_audio_len: 0,
        reference_sample_rate: 0,
        reference_text: std::ptr::null(),
        num_steps: 0,
        extra: std::ptr::null(),
    };
    let ptr = unsafe {
        (r.generate)(
            session.ptr,
            text.as_ptr(),
            &generation,
            None,
            std::ptr::null_mut(),
        )
    };
    if ptr.is_null() {
        return Err("Kokoro synthesis failed".into());
    }
    let audio = Audio { ptr, runtime: r };
    let data = unsafe { &*audio.ptr };
    if data.n <= 0 || data.n > 24_000 * 600 || data.samples.is_null() || data.sample_rate <= 0 {
        return Err("Kokoro produced invalid audio".into());
    }
    let samples = unsafe { std::slice::from_raw_parts(data.samples, data.n as usize) };
    wave(samples, data.sample_rate as u32)
}
fn wave(samples: &[f32], rate: u32) -> Result<Vec<u8>, String> {
    if samples.iter().any(|v| !v.is_finite()) {
        return Err("Invalid speech samples".into());
    }
    let len = (samples.len() * 2) as u32;
    let mut w = Vec::with_capacity(44 + len as usize);
    w.extend(b"RIFF");
    w.extend((36 + len).to_le_bytes());
    w.extend(b"WAVEfmt ");
    w.extend(16u32.to_le_bytes());
    w.extend(1u16.to_le_bytes());
    w.extend(1u16.to_le_bytes());
    w.extend(rate.to_le_bytes());
    w.extend((rate * 2).to_le_bytes());
    w.extend(2u16.to_le_bytes());
    w.extend(16u16.to_le_bytes());
    w.extend(b"data");
    w.extend(len.to_le_bytes());
    for v in samples {
        w.extend(((v.clamp(-1., 1.) * 32767.) as i16).to_le_bytes());
    }
    Ok(w)
}
#[tauri::command]
pub async fn kokoro_model_status(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move||{let supported=!KOKORO_LIBS.is_empty();let installed=ready(&root(&app)?);Ok(serde_json::json!({"supported":supported,"installed":installed,"model":manifest(),"voices":voices(),"task":task().lock().map_err(err)?.clone(),"reason":if supported{""}else{"Kokoro runtime is not bundled for this platform"}}))}).await.map_err(err)?
}
fn check_cancel() -> Result<(), String> {
    if task().lock().map_err(err)?.cancelled {
        Err("Kokoro download cancelled".into())
    } else {
        Ok(())
    }
}
fn unpack(archive: &Path, stage: &Path) -> Result<(), String> {
    let manifest = manifest();
    let mut tar = tar::Archive::new(bzip2::read::BzDecoder::new(
        fs::File::open(archive).map_err(err)?,
    ));
    let expected: HashMap<_, _> = manifest.files.iter().map(|f| (f.name.clone(), f)).collect();
    let mut count = 0;
    for item in tar.entries().map_err(err)? {
        check_cancel()?;
        let mut entry = item.map_err(err)?;
        let path = entry.path().map_err(err)?.into_owned();
        if path.is_absolute() {
            return Err("Unsafe Kokoro archive path".into());
        }
        let mut parts = path.components();
        if parts.next().and_then(|p| p.as_os_str().to_str()) != Some("kokoro-int8-multi-lang-v1_0")
        {
            return Err("Unexpected Kokoro archive root".into());
        }
        let relative: PathBuf = parts.collect();
        if relative
            .components()
            .any(|p| !matches!(p, std::path::Component::Normal(_)))
        {
            return Err("Unsafe Kokoro archive path".into());
        }
        if entry.header().entry_type().is_dir() {
            continue;
        }
        if !entry.header().entry_type().is_file() {
            return Err("Kokoro archive links are not permitted".into());
        }
        let name = relative.to_string_lossy().replace('\\', "/");
        let file = expected
            .get(&name)
            .ok_or("Unexpected Kokoro archive file")?;
        if entry.size() != file.bytes {
            return Err("Kokoro archive size mismatch".into());
        }
        let dest = stage.join(relative);
        fs::create_dir_all(dest.parent().unwrap()).map_err(err)?;
        let mut output = fs::File::create(&dest).map_err(err)?;
        std::io::copy(&mut entry, &mut output).map_err(err)?;
        output.sync_all().map_err(err)?;
        if hash_file(&dest)? != file.sha256 {
            return Err("Kokoro extracted file checksum mismatch".into());
        }
        count += 1;
    }
    if count != manifest.files.len() {
        return Err("Incomplete Kokoro archive".into());
    }
    Ok(())
}
#[tauri::command]
pub async fn kokoro_download(app: tauri::AppHandle, accepted: bool) -> Result<(), String> {
    if !accepted {
        return Err("Review the Kokoro Apache-2.0 license before downloading".into());
    }
    if KOKORO_LIBS.is_empty() {
        return Err("Kokoro unavailable on this platform".into());
    }
    let m = manifest();
    {
        let mut t = task().lock().map_err(err)?;
        if ["downloading", "checking"].contains(&t.state.as_str()) {
            return Err("Kokoro installation is already active".into());
        }
        *t = Task {
            state: "downloading".into(),
            total: m.archive_bytes,
            ..Default::default()
        };
    }
    let result = async {
        let destination = root(&app)?;
        let archive = destination.with_extension("tar.bz2");
        let stage = destination.with_extension("staging");
        fs::create_dir_all(destination.parent().unwrap()).map_err(err)?;
        if fs::metadata(&archive).ok().map(|v| v.len()) != Some(m.archive_bytes)
            || hash_file(&archive).ok().as_deref() != Some(&m.archive_sha256)
        {
            let client = reqwest::Client::builder()
                .https_only(true)
                .connect_timeout(Duration::from_secs(20))
                .timeout(Duration::from_secs(1200))
                .build()
                .map_err(err)?;
            let mut response = client
                .get(&m.url)
                .send()
                .await
                .map_err(|_| "Kokoro download failed")?
                .error_for_status()
                .map_err(|_| "Kokoro server returned an error")?;
            let mut file = fs::File::create(&archive).map_err(err)?;
            let mut received = 0;
            loop {
                check_cancel()?;
                let chunk = tokio::select! {
                    chunk = response.chunk() => chunk.map_err(|_| "Kokoro download interrupted")?,
                    _ = tokio::time::sleep(Duration::from_millis(200)) => continue,
                };
                let Some(chunk) = chunk else {
                    break;
                };
                received += chunk.len() as u64;
                if received > m.archive_bytes {
                    return Err("Kokoro package exceeded its pinned size".into());
                }
                file.write_all(&chunk).map_err(err)?;
                task().lock().map_err(err)?.downloaded = received;
            }
            file.sync_all().map_err(err)?;
        }
        check_cancel()?;
        if hash_file(&archive)? != m.archive_sha256 {
            return Err("Kokoro package checksum mismatch".into());
        }
        {
            let mut t = task().lock().map_err(err)?;
            t.state = "checking".into();
            t.downloaded = m.archive_bytes;
        }
        let cache = app
            .path_resolver()
            .app_cache_dir()
            .ok_or("Cache unavailable")?;
        tauri::async_runtime::spawn_blocking(move || {
            let _lock = engine_lock().lock().map_err(err)?;
            if stage.exists() {
                fs::remove_dir_all(&stage).map_err(err)?;
            }
            fs::create_dir_all(&stage).map_err(err)?;
            unpack(&archive, &stage)?;
            if !verify(&stage) {
                return Err("Incomplete Kokoro package".into());
            }
            synthesize(&cache, &stage, INSTALL_TEST_TEXT, "zh", Some(45))?;
            if destination.exists() {
                fs::remove_dir_all(&destination).map_err(err)?;
            }
            fs::rename(stage, destination).map_err(err)?;
            let _ = fs::remove_file(archive);
            Ok::<(), String>(())
        })
        .await
        .map_err(err)??;
        Ok(())
    }
    .await;
    let mut t = task().lock().map_err(err)?;
    match &result {
        Ok(()) => t.state = "ready".into(),
        Err(_) if t.cancelled => t.state = "cancelled".into(),
        Err(_) => {
            t.state = "error".into();
            t.error = "Kokoro installation failed; check the connection and disk space, then retry"
                .into();
        }
    }
    result
}
#[tauri::command]
pub fn kokoro_cancel() -> Result<(), String> {
    let mut t = task().lock().map_err(err)?;
    if t.state == "downloading" {
        t.cancelled = true;
    }
    Ok(())
}
#[tauri::command]
pub async fn kokoro_uninstall(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = engine_lock()
            .try_lock()
            .map_err(|_| "Kokoro is speaking; retry when complete")?;
        let mut t = task().lock().map_err(err)?;
        if ["downloading", "checking"].contains(&t.state.as_str()) {
            return Err("Cancel the Kokoro download before uninstalling".into());
        }
        let dir = root(&app)?;
        for p in [&dir, &dir.with_extension("staging")] {
            if p.is_dir() {
                fs::remove_dir_all(p).map_err(err)?;
            }
        }
        let p = dir.with_extension("tar.bz2");
        if p.is_file() {
            fs::remove_file(p).map_err(err)?;
        }
        *t = Task::default();
        Ok(())
    })
    .await
    .map_err(err)?
}
#[tauri::command]
pub async fn kokoro_speak(
    app: tauri::AppHandle,
    text: String,
    lang: String,
    sid: Option<i32>,
) -> Result<Vec<u8>, String> {
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    if text.chars().count() > 3000 || text.contains('\0') {
        return Err("Kokoro accepts up to 3000 characters per request".into());
    }
    selected_voice(&lang, sid)?;
    // One active synthesis plus one pending request; rapid source/target changes
    // should wait briefly instead of failing or building an unbounded work queue.
    static QUEUE: OnceLock<std::sync::Arc<tokio::sync::Semaphore>> = OnceLock::new();
    let permit = QUEUE
        .get_or_init(|| std::sync::Arc::new(tokio::sync::Semaphore::new(2)))
        .clone()
        .try_acquire_owned()
        .map_err(|_| "Kokoro speech queue is full; retry shortly")?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        let _lock = engine_lock().lock().map_err(err)?;
        let dir = root(&app)?;
        if !ready(&dir) {
            return Err(
                "Install the Kokoro multilingual model in Settings > Models and Connections".into(),
            );
        }
        synthesize(
            &app.path_resolver()
                .app_cache_dir()
                .ok_or("Cache unavailable")?,
            &dir,
            &text,
            &lang,
            sid,
        )
    })
    .await
    .map_err(err)?
}
#[tauri::command]
pub async fn kokoro_preview(app: tauri::AppHandle, sid: i32) -> Result<Vec<u8>, String> {
    let v = voices()
        .into_iter()
        .find(|v| v.sid == sid)
        .ok_or("Unknown Kokoro voice")?;
    if ready(&root(&app)?) {
        return kokoro_speak(app, v.sample, v.language, Some(sid)).await;
    }
    // Explicit uninstalled preview downloads only a pinned public audio sample.
    let client = reqwest::Client::builder()
        .https_only(true)
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(err)?;
    let mut response = client
        .get(&v.url)
        .send()
        .await
        .map_err(|_| "Kokoro preview download failed")?
        .error_for_status()
        .map_err(|_| "Kokoro preview unavailable")?;
    let mut data = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(err)? {
        if data.len() + chunk.len() > v.bytes as usize {
            return Err("Kokoro preview size mismatch".into());
        }
        data.extend(&chunk);
    }
    if data.len() as u64 != v.bytes || format!("{:x}", Sha256::digest(&data)) != v.sha256 {
        return Err("Kokoro preview checksum mismatch".into());
    }
    Ok(data)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn language_routing_rejects_cross_language_and_unimplemented_frontends() {
        assert_eq!(selected_voice("zh_cn", None).unwrap().language, "zh");
        assert!(selected_voice("fr", Some(3)).is_err());
        assert!(selected_voice("ja", None).is_err());
        assert!(selected_voice("auto", None).is_err());
        assert_eq!(selected_voice("fr", None).unwrap().sid, 30);
    }
    #[test]
    fn manifest_is_pinned_and_paths_are_relative() {
        let m = manifest();
        assert!(m.archive_bytes > 100_000_000);
        for f in m.files {
            assert!(!Path::new(&f.name).is_absolute());
            assert!(!f.name.contains(".."));
            assert_eq!(f.sha256.len(), 64);
        }
        assert!(voices().len() > 40);
    }
    #[test]
    fn archive_rejects_links_and_unexpected_files() {
        for link in [false, true] {
            let base = std::env::temp_dir()
                .join(format!("cup-kokoro-archive-{}-{link}", std::process::id()));
            fs::create_dir_all(&base).unwrap();
            let path = base.join("model.tar.bz2");
            let writer = bzip2::write::BzEncoder::new(
                fs::File::create(&path).unwrap(),
                bzip2::Compression::fast(),
            );
            let mut archive = tar::Builder::new(writer);
            let mut header = tar::Header::new_gnu();
            header.set_mode(0o644);
            header.set_size(0);
            if link {
                header.set_entry_type(tar::EntryType::Symlink);
                header.set_link_name("../../escape").unwrap();
            }
            header.set_cksum();
            archive
                .append_data(
                    &mut header,
                    "kokoro-int8-multi-lang-v1_0/unexpected",
                    std::io::empty(),
                )
                .unwrap();
            archive.into_inner().unwrap().finish().unwrap();
            let stage = base.join("stage");
            fs::create_dir_all(&stage).unwrap();
            let error = unpack(&path, &stage).unwrap_err();
            assert!(error.contains(if link { "links" } else { "Unexpected" }));
            assert_eq!(fs::read_dir(&stage).unwrap().count(), 0);
            fs::remove_dir_all(base).unwrap();
        }
    }
    #[test]
    #[ignore = "requires Kokoro fixture in CUP_KOKORO_MODEL_DIR"]
    fn real_multilingual_kokoro_produces_audio() {
        let dir = PathBuf::from(std::env::var("CUP_KOKORO_MODEL_DIR").unwrap());
        assert!(verify(&dir));
        let cache = std::env::temp_dir().join("cup-kokoro-runtime-test");
        for lang in ["zh", "en", "fr", "es", "it", "pt", "hi"] {
            let v = selected_voice(lang, None).unwrap();
            let start = std::time::Instant::now();
            let w = synthesize(&cache, &dir, &v.sample, lang, Some(v.sid)).unwrap();
            assert!(w.len() > 44);
            assert_eq!(&w[..4], b"RIFF");
            println!("Kokoro {lang}: {} bytes {:?}", w.len(), start.elapsed());
        }
    }
}
