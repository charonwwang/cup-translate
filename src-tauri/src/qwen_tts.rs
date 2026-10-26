//! Managed Qwen environment, pinned model downloads and a private child-process protocol.
use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Condvar, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};

const SCRIPT: &str = include_str!("../../scripts/qwen-runtime.py");
const MANIFEST: &str = include_str!("../resources/qwen-models.json");
static CANCELLED: AtomicBool = AtomicBool::new(false);
static SPEECH_EPOCH: AtomicU64 = AtomicU64::new(0);
static REQUEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);
const PREVIEW_TEXT: &str = "你好，欢迎使用。";
const VOICES: &[&str] = &[
    "Vivian", "Serena", "Uncle_Fu", "Dylan", "Eric", "Ryan", "Aiden", "Ono_Anna", "Sohee",
];
fn runtime_state() -> &'static Mutex<Value> {
    static STATE: OnceLock<Mutex<Value>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(json!({"state":"unloaded"})))
}
fn set_runtime(state: &str, variant: &str) {
    *runtime_state().lock().unwrap() = json!({"state":state,"variant":variant});
}
fn task() -> &'static Mutex<Value> {
    static TASK: OnceLock<Mutex<Value>> = OnceLock::new();
    TASK.get_or_init(|| Mutex::new(json!({"state":"idle"})))
}
fn installer_process() -> &'static Mutex<Option<Arc<Mutex<Child>>>> {
    static PROCESS: OnceLock<Mutex<Option<Arc<Mutex<Child>>>>> = OnceLock::new();
    PROCESS.get_or_init(|| Mutex::new(None))
}
fn worker_process() -> &'static Mutex<Option<Arc<Mutex<Child>>>> {
    static PROCESS: OnceLock<Mutex<Option<Arc<Mutex<Child>>>>> = OnceLock::new();
    PROCESS.get_or_init(|| Mutex::new(None))
}
fn terminate_worker() {
    let child = worker_process().lock().unwrap().clone();
    if let Some(child) = child {
        if let Ok(mut child) = child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
fn worker() -> &'static Mutex<Option<Worker>> {
    static WORKER: OnceLock<Mutex<Option<Worker>>> = OnceLock::new();
    WORKER.get_or_init(|| Mutex::new(None))
}
fn root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let path = app
        .path_resolver()
        .app_config_dir()
        .ok_or("Application directory unavailable")?
        .join("models/qwen3-tts");
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    for (name, content) in [("runtime.py", SCRIPT), ("manifest.json", MANIFEST)] {
        let file = path.join(name);
        if fs::read_to_string(&file).ok().as_deref() != Some(content) {
            let temporary = file.with_extension("new");
            fs::write(&temporary, content).map_err(|e| e.to_string())?;
            fs::rename(temporary, file).map_err(|e| e.to_string())?;
        }
    }
    Ok(path)
}
fn manifest(variant: &str) -> Result<Value, String> {
    let all: Value = serde_json::from_str(MANIFEST).map_err(|e| e.to_string())?;
    all["models"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["id"] == variant)
        .cloned()
        .ok_or("Unknown Qwen variant".into())
}
fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}
fn supported() -> bool {
    cfg!(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(
            target_os = "linux",
            any(target_arch = "x86_64", target_arch = "aarch64")
        ),
        all(windows, target_arch = "x86_64")
    ))
}
fn command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
        .env("PYTHONUNBUFFERED", "1")
        .env("HF_HUB_DISABLE_TELEMETRY", "1");
    command
}
fn python_in(dir: &Path) -> PathBuf {
    dir.join(if cfg!(windows) {
        "Scripts/python.exe"
    } else {
        "bin/python"
    })
}
fn probe(path: &Path, script: &Path) -> Option<Value> {
    let mut process = command(path)
        .args([script.as_os_str(), "probe".as_ref()])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let start = Instant::now();
    loop {
        match process.try_wait().ok()? {
            Some(_) => break,
            None if start.elapsed() > Duration::from_secs(60) => {
                let _ = process.kill();
                let _ = process.wait();
                return None;
            }
            None => std::thread::sleep(Duration::from_millis(50)),
        }
    }
    let output = process.wait_with_output().ok()?;
    if !output.status.success() {
        return None;
    }
    serde_json::from_slice(&output.stdout).ok()
}
fn candidates(root: &Path) -> Vec<PathBuf> {
    let mut paths = vec![python_in(&root.join("environment"))];
    for key in ["VIRTUAL_ENV", "CONDA_PREFIX"] {
        if let Some(dir) = std::env::var_os(key) {
            paths.push(python_in(Path::new(&dir)));
        }
    }
    let names = if cfg!(windows) {
        vec!["python.exe"]
    } else {
        vec!["python3.12", "python3.11", "python3.10", "python3"]
    };
    let mut dirs: Vec<PathBuf> =
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).collect();
    dirs.extend([
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/bin"),
    ]);
    if let Some(home) = dirs::home_dir() {
        dirs.extend([
            home.join(".local/bin"),
            home.join("miniconda3/bin"),
            home.join("anaconda3/bin"),
        ]);
        for base in [
            home.join(".virtualenvs"),
            home.join("miniconda3/envs"),
            home.join("anaconda3/envs"),
        ] {
            if let Ok(entries) = fs::read_dir(base) {
                for entry in entries.flatten().take(32) {
                    paths.push(python_in(&entry.path()));
                }
            }
        }
        #[cfg(windows)]
        if let Ok(entries) = fs::read_dir(home.join("AppData/Local/Programs/Python")) {
            for entry in entries.flatten().take(16) {
                paths.push(entry.path().join("python.exe"));
            }
        }
    }
    for directory in dirs {
        for name in &names {
            paths.push(directory.join(name));
        }
    }
    let mut unique = Vec::new();
    // Resolving the final symlink would turn a venv interpreter into its base Python.
    for path in paths {
        if path.is_file() && !unique.contains(&path) {
            unique.push(path);
        }
    }
    unique
}
fn environments(root: &Path) -> Vec<Value> {
    let mut values: Vec<Value> = candidates(root)
        .iter()
        .filter_map(|p| probe(p, &root.join("runtime.py")))
        .filter(|v| v["supported"] == true)
        .collect();
    values.sort_by_key(|v| v["ready"] != true);
    values.dedup_by(|a, b| a["python"] == b["python"]);
    values
}
fn installed(root: &Path, variant: &str) -> Option<Value> {
    let mut config = read_json(&root.join(format!("installed-{variant}.json")))?;
    if !Path::new(config["python"].as_str()?).is_file() {
        return None;
    }
    let directory = PathBuf::from(config["model"].as_str()?);
    let model = manifest(variant).ok()?;
    if config["revision"] != model["revision"] {
        return None;
    }
    if !model["files"].as_array()?.iter().all(|item| {
        fs::metadata(directory.join(item["name"].as_str().unwrap_or_default()))
            .is_ok_and(|m| m.len() == item["bytes"].as_u64().unwrap_or(0))
    }) {
        return None;
    }
    config["modelBytes"] = json!(model["files"]
        .as_array()?
        .iter()
        .filter_map(|f| f["bytes"].as_u64())
        .sum::<u64>());
    config["managedFiles"] =
        json!(directory == root.join(format!("model-{variant}")) && !directory.is_symlink());
    Some(config)
}
fn check(root: &Path, variant: &str) -> Result<Value, String> {
    let model = manifest(variant)?;
    let bytes: u64 = model["files"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|f| f["bytes"].as_u64())
        .sum();
    let envs = environments(root);
    let ready = envs.iter().any(|v| v["ready"] == true);
    let disk = if ready {
        bytes + 1_000_000_000
    } else {
        bytes + 5_000_000_000
    };
    Ok(
        json!({"supported":supported(),"environments":envs,"reuseEnvironment":ready,"downloadPython":envs.is_empty(),"modelBytes":bytes,"dependencyBytesEstimate":if ready {0} else {1_500_000_000u64},"diskRequired":disk,"diskAvailable":fs2::available_space(root).map_err(|e|e.to_string())?,"installed":installed(root,variant),"root":root,"variant":variant}),
    )
}
#[tauri::command]
pub async fn qwen_device_check(app: tauri::AppHandle, variant: String) -> Result<Value, String> {
    let root = root(&app)?;
    tauri::async_runtime::spawn_blocking(move || check(&root, &variant))
        .await
        .map_err(|e| e.to_string())?
}
fn set_stage(state: &str, variant: &str) {
    *task().lock().unwrap() = json!({"state":state,"variant":variant});
}
fn cancelled() -> Result<(), String> {
    if CANCELLED.load(Ordering::SeqCst) {
        Err("Installation cancelled; downloaded files retained".into())
    } else {
        Ok(())
    }
}
fn run(mut command: Command, root: &Path) -> Result<(), String> {
    cancelled()?;
    let log = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(root.join("install.log"))
        .map_err(|e| e.to_string())?;
    command
        .stdout(log.try_clone().map_err(|e| e.to_string())?)
        .stderr(log);
    let child = Arc::new(Mutex::new(command.spawn().map_err(|e| e.to_string())?));
    *installer_process().lock().unwrap() = Some(child.clone());
    let start = Instant::now();
    loop {
        if CANCELLED.load(Ordering::SeqCst) || start.elapsed() > Duration::from_secs(7200) {
            let _ = child.lock().unwrap().kill();
            let _ = child.lock().unwrap().wait();
            *installer_process().lock().unwrap() = None;
            cancelled()?;
            return Err("Installation timed out; retry to resume".into());
        }
        let status = child
            .lock()
            .unwrap()
            .try_wait()
            .map_err(|e| e.to_string())?;
        if let Some(status) = status {
            *installer_process().lock().unwrap() = None;
            if status.success() {
                return Ok(());
            }
            return Err(format!(
                "Installation step failed ({status}); see install.log for details"
            ));
        }
        std::thread::sleep(Duration::from_millis(150));
    }
}
fn find_uv(root: &Path) -> Option<PathBuf> {
    let name = if cfg!(windows) { "uv.exe" } else { "uv" };
    let mut paths = vec![root.join("bin").join(name)];
    if let Some(home) = dirs::home_dir() {
        paths.push(home.join(".local/bin").join(name));
        paths.push(home.join(".cargo/bin").join(name));
    }
    for dir in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
        paths.push(dir.join(name));
    }
    paths.into_iter().find(|path| {
        path.is_file()
            && command(path)
                .arg("--version")
                .output()
                .is_ok_and(|v| v.status.success())
    })
}
fn bootstrap_uv(root: &Path) -> Result<PathBuf, String> {
    if let Some(path) = find_uv(root) {
        return Ok(path);
    }
    let target = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "aarch64-apple-darwin",
        ("linux", "x86_64") => "x86_64-unknown-linux-gnu",
        ("linux", "aarch64") => "aarch64-unknown-linux-gnu",
        ("windows", "x86_64") => "x86_64-pc-windows-msvc",
        _ => return Err("Unsupported Qwen runtime platform".into()),
    };
    let all: Value = serde_json::from_str(MANIFEST).unwrap();
    let asset = &all["uv"][target];
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|e| e.to_string())?;
    let data = client
        .get(asset["url"].as_str().unwrap())
        .send()
        .and_then(|r| r.error_for_status())
        .and_then(|r| r.bytes())
        .map_err(|e| e.to_string())?;
    if format!("{:x}", Sha256::digest(&data)) != asset["sha256"].as_str().unwrap() {
        return Err("Runtime installer checksum mismatch".into());
    }
    cancelled()?;
    let name = if cfg!(windows) { "uv.exe" } else { "uv" };
    let dir = root.join("bin");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let destination = dir.join(name);
    let payload = if cfg!(windows) {
        let mut zip =
            zip::ZipArchive::new(std::io::Cursor::new(data)).map_err(|e| e.to_string())?;
        let index = (0..zip.len())
            .find(|i| {
                zip.by_index(*i)
                    .is_ok_and(|v| Path::new(v.name()).file_name().is_some_and(|s| s == name))
            })
            .ok_or("Runtime executable missing")?;
        let mut bytes = Vec::new();
        zip.by_index(index)
            .map_err(|e| e.to_string())?
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        bytes
    } else {
        let mut archive =
            tar::Archive::new(flate2::read::GzDecoder::new(std::io::Cursor::new(data)));
        let mut bytes = None;
        for entry in archive.entries().map_err(|e| e.to_string())? {
            let mut entry = entry.map_err(|e| e.to_string())?;
            if entry
                .path()
                .map_err(|e| e.to_string())?
                .file_name()
                .is_some_and(|s| s == name)
            {
                let mut value = Vec::new();
                entry.read_to_end(&mut value).map_err(|e| e.to_string())?;
                bytes = Some(value);
                break;
            }
        }
        bytes.ok_or("Runtime executable missing")?
    };
    fs::write(&destination, payload).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&destination, fs::Permissions::from_mode(0o755))
            .map_err(|e| e.to_string())?;
    }
    Ok(destination)
}
fn install(root: &Path, variant: &str, environment: Option<String>) -> Result<(), String> {
    manifest(variant)?;
    cancelled()?;
    let envs = environments(root);
    let selected = environment
        .as_ref()
        .and_then(|path| envs.iter().find(|v| v["python"].as_str() == Some(path)))
        .or_else(|| envs.first());
    let model = manifest(variant)?;
    let model_bytes: u64 = model["files"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|f| f["bytes"].as_u64())
        .sum();
    let required = model_bytes
        + if selected.is_some_and(|v| v["ready"] == true) {
            1_000_000_000
        } else {
            5_000_000_000
        };
    if fs2::available_space(root).map_err(|e| e.to_string())? < required {
        return Err("Insufficient disk space for selected runtime and model".into());
    }
    let python = if let Some(value) = selected.filter(|v| v["ready"] == true) {
        PathBuf::from(value["python"].as_str().unwrap())
    } else {
        set_stage("runtime", variant);
        let uv = bootstrap_uv(root)?;
        let destination = root.join("environment");
        let interpreter = selected
            .and_then(|v| v["python"].as_str())
            .unwrap_or("3.12");
        let mut venv = command(&uv);
        venv.args(["venv", "--allow-existing", "--python", interpreter])
            .arg(&destination)
            .env("UV_PYTHON_INSTALL_DIR", root.join("python"))
            .env("UV_CACHE_DIR", root.join("cache"));
        run(venv, root)?;
        set_stage("dependencies", variant);
        let python = python_in(&destination);
        let mut pip = command(&uv);
        pip.args(["pip", "install", "--python"])
            .arg(&python)
            .args(["qwen-tts==0.1.1", "torch==2.9.1", "torchaudio==2.9.1"])
            .env("UV_CACHE_DIR", root.join("cache"));
        #[cfg(not(target_os = "macos"))]
        pip.args(["--index", "https://download.pytorch.org/whl/cpu"]);
        run(pip, root)?;
        python
    };
    if !probe(&python, &root.join("runtime.py")).is_some_and(|v| v["ready"] == true) {
        return Err("Qwen runtime dependency check failed; see install.log".into());
    }
    set_stage("model", variant);
    let mut download = command(&python);
    download
        .arg(root.join("runtime.py"))
        .args(["install", "--root"])
        .arg(root)
        .args(["--variant", variant])
        .env("HF_HUB_DISABLE_XET", "1");
    run(download, root)?;
    if installed(root, variant).is_none() {
        return Err("Qwen installation verification failed".into());
    }
    Ok(())
}
#[tauri::command]
pub async fn qwen_install(
    app: tauri::AppHandle,
    variant: String,
    environment: Option<String>,
) -> Result<(), String> {
    if !supported() {
        return Err("Unsupported Qwen runtime platform".into());
    }
    manifest(&variant)?;
    let root = root(&app)?;
    {
        let mut current = task().lock().unwrap();
        if active(current["state"].as_str().unwrap_or("")) {
            return Err("An installation is already running".into());
        }
        *current = json!({"state":"checking","variant":variant});
    }
    CANCELLED.store(false, Ordering::SeqCst);
    let _ = fs::remove_file(root.join("progress.json"));
    tauri::async_runtime::spawn_blocking(move || {
        let result = check(&root, &variant).and_then(|check| {
            if check["diskAvailable"].as_u64().unwrap_or(0)
                < check["diskRequired"].as_u64().unwrap_or(u64::MAX)
            {
                return Err("Insufficient disk space for model and dependencies".into());
            }
            install(&root, &variant, environment)
        });
        match result {
            Ok(()) => set_stage("ready", &variant),
            Err(error) => {
                *task().lock().unwrap() = json!({"state":if CANCELLED.load(Ordering::SeqCst) {"cancelled"} else {"failed"},"variant":variant,"error":error})
            }
        };
    });
    Ok(())
}
fn active(state: &str) -> bool {
    matches!(
        state,
        "checking" | "runtime" | "dependencies" | "model" | "verifying" | "warming"
    )
}
#[tauri::command]
pub async fn qwen_cancel() {
    CANCELLED.store(true, Ordering::SeqCst);
}
#[tauri::command]
pub async fn qwen_status(app: tauri::AppHandle) -> Result<Value, String> {
    let root = root(&app)?;
    let mut status = task().lock().unwrap().clone();
    if active(status["state"].as_str().unwrap_or(""))
        && matches!(
            status["state"].as_str(),
            Some("model" | "warming" | "verifying")
        )
    {
        if let Some(progress) = read_json(&root.join("progress.json")) {
            if progress["variant"] == status["variant"] && progress["state"] != "ready" {
                status = progress;
            }
        }
    }
    if status["state"] == "model" {
        let variant = status["variant"].as_str().unwrap_or("0.6B");
        let partial: u64 = walkdir::WalkDir::new(root.join(format!("model-{variant}/.cache")))
            .into_iter()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry.file_type().is_file()
                    && entry.file_name().to_string_lossy().ends_with(".incomplete")
            })
            .filter_map(|entry| entry.metadata().ok().map(|meta| meta.len()))
            .sum();
        status["bytes"] = json!((status["bytes"].as_u64().unwrap_or(0) + partial)
            .min(status["total"].as_u64().unwrap_or(u64::MAX)));
    }
    Ok(
        json!({"task":status,"models":{"0.6B":installed(&root,"0.6B"),"1.7B":installed(&root,"1.7B")},"runtime":runtime_state().lock().unwrap().clone(),"logPath":root.join("runtime.log"),"installLogPath":root.join("install.log")}),
    )
}
struct Worker {
    child: Arc<Mutex<Child>>,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    variant: String,
}
impl Drop for Worker {
    fn drop(&mut self) {
        *worker_process().lock().unwrap() = None;
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
impl Worker {
    fn reply(&mut self, timeout: u64) -> Result<Value, String> {
        let completed = Arc::new((Mutex::new(false), Condvar::new()));
        let watchdog = completed.clone();
        let timed_out = Arc::new(AtomicBool::new(false));
        let expired = timed_out.clone();
        let child = self.child.clone();
        let guard = std::thread::spawn(move || {
            let (lock, wake) = &*watchdog;
            let done = lock.lock().unwrap();
            let (done, _) = wake
                .wait_timeout_while(done, Duration::from_secs(timeout), |v| !*v)
                .unwrap();
            if !*done {
                expired.store(true, Ordering::SeqCst);
                let _ = child.lock().unwrap().kill();
            }
        });
        let mut line = String::new();
        let result = self.output.read_line(&mut line);
        {
            let (lock, wake) = &*completed;
            *lock.lock().unwrap() = true;
            wake.notify_one();
        }
        let _ = guard.join();
        if timed_out.load(Ordering::SeqCst) {
            return Err(format!("Qwen operation timed out after {timeout}s; runtime stopped. Try a shorter text or use system speech for faster reading."));
        }
        result.map_err(|_| "Cannot read Qwen worker response")?;
        serde_json::from_str(&line).map_err(|_| "Qwen worker stopped; inspect runtime.log".into())
    }
}
fn speak(
    root: &Path,
    variant: &str,
    text: String,
    language: String,
    voice: String,
    epoch: u64,
) -> Result<Vec<u8>, String> {
    if text.trim().is_empty() || text.chars().count() > 2000 {
        return Err("Speech text must contain 1–2000 characters".into());
    }
    let mut slot = worker()
        .lock()
        .map_err(|_| "Qwen worker lock unavailable")?;
    if SPEECH_EPOCH.load(Ordering::SeqCst) != epoch {
        return Err("Qwen synthesis cancelled".into());
    }
    let config = installed(root, variant).ok_or("Install this Qwen model in Settings first")?;
    if slot.as_ref().is_some_and(|w| w.variant != variant) {
        *slot = None;
    }
    if slot.is_none() {
        set_runtime("loading", variant);
        let log = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(root.join("runtime.log"))
            .map_err(|e| e.to_string())?;
        let mut child = command(config["python"].as_str().unwrap())
            .arg(root.join("runtime.py"))
            .args(["serve", "--config"])
            .arg(root.join(format!("installed-{variant}.json")))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(log)
            .spawn()
            .map_err(|e| e.to_string())?;
        let mut runtime = Worker {
            input: child.stdin.take().unwrap(),
            output: BufReader::new(child.stdout.take().unwrap()),
            child: Arc::new(Mutex::new(child)),
            variant: variant.into(),
        };
        *worker_process().lock().unwrap() = Some(runtime.child.clone());
        if runtime.reply(120)?["ready"] != true {
            return Err("Qwen runtime startup failed".into());
        }
        *slot = Some(runtime);
    }
    let runtime = slot.as_mut().unwrap();
    set_runtime("synthesizing", variant);
    let request_id = REQUEST_SEQUENCE.fetch_add(1, Ordering::SeqCst).to_string();
    let text_hash = format!("{:x}", Sha256::digest(text.as_bytes()));
    let result = (|| {
        writeln!(
            runtime.input,
            "{}",
            json!({"request_id":request_id,"text":text,"language":language,"voice":voice,"preview":text == PREVIEW_TEXT})
        )
        .map_err(|_| "Qwen runtime disconnected")?;
        runtime
            .input
            .flush()
            .map_err(|_| "Qwen runtime disconnected")?;
        let response = runtime.reply(if text == PREVIEW_TEXT { 120 } else { 600 })?;
        validate_reply(&response, &request_id, &text_hash, &language, &voice)?;
        if let Some(error) = response["error"].as_str() {
            return Err(error.to_owned());
        }
        let audio = base64::engine::general_purpose::STANDARD
            .decode(response["audio"].as_str().ok_or("No Qwen audio returned")?)
            .map_err(|_| "Invalid Qwen audio")?;
        if audio.len() < 44 || !audio.starts_with(b"RIFF") {
            return Err("Invalid Qwen WAV response".into());
        }
        Ok(audio)
    })();
    if result.is_err() {
        *slot = None;
        set_runtime("unloaded", variant);
    } else {
        set_runtime("ready", variant);
    }
    result
}
fn validate_reply(
    response: &Value,
    request_id: &str,
    text_hash: &str,
    language: &str,
    voice: &str,
) -> Result<(), String> {
    if response["request_id"].as_str() != Some(request_id)
        || response["text_hash"].as_str() != Some(text_hash)
        || response["language"].as_str() != Some(language)
        || response["voice"].as_str() != Some(voice)
    {
        return Err(
            "Qwen response does not match the requested text, language or voice; audio discarded"
                .into(),
        );
    }
    Ok(())
}
#[tauri::command]
pub async fn qwen_tts_request(
    app: tauri::AppHandle,
    variant: String,
    text: String,
    language: String,
    voice: String,
) -> Result<Vec<u8>, String> {
    let root = root(&app)?;
    manifest(&variant)?;
    let epoch = SPEECH_EPOCH.load(Ordering::SeqCst);
    tauri::async_runtime::spawn_blocking(move || {
        let result = speak(&root, &variant, text, language, voice, epoch);
        if result.is_err() && SPEECH_EPOCH.load(Ordering::SeqCst) == epoch {
            set_runtime("unloaded", &variant);
        }
        result
    })
    .await
    .map_err(|e| e.to_string())?
}
fn preview_path(root: &Path, variant: &str, voice: &str) -> Result<PathBuf, String> {
    manifest(variant)?;
    if !VOICES.contains(&voice) {
        return Err("Unsupported Qwen voice".into());
    }
    // Vivian's installation sample already passed real synthesis verification.
    let revision = manifest(variant)?["revision"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    Ok(root.join(if voice == "Vivian" {
        format!("preview-{variant}.wav")
    } else {
        format!("preview-{variant}-{voice}-{revision}.wav")
    }))
}
fn preview_bytes(path: &Path) -> Option<Vec<u8>> {
    if fs::metadata(path).ok()?.len() > 8_000_000 {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    if !non_silent_pcm16(&bytes) {
        return None;
    }
    Some(bytes)
}
fn non_silent_pcm16(bytes: &[u8]) -> bool {
    if bytes.len() < 44 || &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return false;
    }
    let mut offset = 12;
    let mut format_ok = false;
    let mut audible = false;
    while offset + 8 <= bytes.len() {
        let tag = &bytes[offset..offset + 4];
        let size = u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().unwrap()) as usize;
        offset += 8;
        let Some(end) = offset.checked_add(size).filter(|end| *end <= bytes.len()) else {
            return false;
        };
        let data = &bytes[offset..end];
        if tag == b"fmt " {
            format_ok = size >= 16
                && data[..2] == [1, 0]
                && data[14..16] == [16, 0]
                && data[2..4] != [0, 0];
        } else if tag == b"data" {
            if size % 2 != 0 {
                return false;
            }
            audible |= data
                .chunks_exact(2)
                .any(|v| i16::from_le_bytes([v[0], v[1]]).unsigned_abs() > 32);
        }
        offset = end + size % 2;
    }
    format_ok && audible
}
#[tauri::command]
pub async fn qwen_preview(
    app: tauri::AppHandle,
    variant: String,
    voice: String,
) -> Result<Vec<u8>, String> {
    let root = root(&app)?;
    let path = preview_path(&root, &variant, &voice)?;
    let epoch = SPEECH_EPOCH.load(Ordering::SeqCst);
    tauri::async_runtime::spawn_blocking(move || {
        installed(&root, &variant).ok_or("Install this Qwen model in Settings first")?;
        if let Some(bytes) = preview_bytes(&path) {
            return Ok(bytes);
        }
        let result = speak(
            &root,
            &variant,
            PREVIEW_TEXT.into(),
            "Chinese".into(),
            voice,
            epoch,
        );
        if let Ok(bytes) = &result {
            // Uninstall and cancellation cannot resurrect preview files after completion.
            let _slot = worker()
                .lock()
                .map_err(|_| "Qwen worker lock unavailable")?;
            if SPEECH_EPOCH.load(Ordering::SeqCst) == epoch && installed(&root, &variant).is_some()
            {
                let _ = fs::write(path, bytes);
            }
        } else if SPEECH_EPOCH.load(Ordering::SeqCst) == epoch {
            set_runtime("unloaded", &variant);
        }
        result
    })
    .await
    .map_err(|e| e.to_string())?
}

// Only application-owned weights may be removed. Shared Hugging Face caches and
// user-selected Python environments are never deleted by this command.
fn remove_model_files(root: &Path, variant: &str) -> Result<(), String> {
    manifest(variant)?;
    let marker = root.join(format!("installed-{variant}.json"));
    let config = read_json(&marker).ok_or("Qwen model registration is missing")?;
    let owned = root.join(format!("model-{variant}"));
    if config["model"].as_str().map(Path::new) == Some(owned.as_path()) {
        if owned.is_symlink() {
            return Err("Refusing to remove a linked model directory".into());
        }
        if owned.exists() {
            fs::remove_dir_all(&owned)
                .map_err(|e| format!("Cannot remove Qwen model files: {e}"))?;
        }
    }
    fs::remove_file(marker).map_err(|e| e.to_string())?;
    for voice in VOICES {
        if let Ok(path) = preview_path(root, variant, voice) {
            let _ = fs::remove_file(path);
        }
    }
    Ok(())
}
#[tauri::command]
pub async fn qwen_remove(app: tauri::AppHandle, variant: String) -> Result<(), String> {
    manifest(&variant)?;
    let root = root(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut current = task().lock().unwrap();
        if active(current["state"].as_str().unwrap_or("")) {
            return Err("Wait for the Qwen installation to finish or cancel it first".into());
        }
        SPEECH_EPOCH.fetch_add(1, Ordering::SeqCst);
        terminate_worker();
        let mut slot = worker()
            .lock()
            .map_err(|_| "Qwen worker lock unavailable")?;
        *slot = None;
        set_runtime("unloaded", &variant);
        remove_model_files(&root, &variant)?;
        *current = json!({"state":"idle"});
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}
pub fn shutdown() {
    CANCELLED.store(true, Ordering::SeqCst);
    if let Some(child) = installer_process().lock().unwrap().as_ref() {
        let _ = child.lock().unwrap().kill();
    }
    terminate_worker();
    if let Ok(mut slot) = worker().try_lock() {
        *slot = None;
    }
}
#[tauri::command]
pub async fn qwen_stop() -> Result<(), String> {
    SPEECH_EPOCH.fetch_add(1, Ordering::SeqCst);
    tauri::async_runtime::spawn_blocking(|| {
        terminate_worker();
        if let Ok(mut slot) = worker().lock() {
            *slot = None;
        }
        *runtime_state().lock().unwrap() = json!({"state":"unloaded"});
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(all(test, unix))]
mod lifecycle_tests {
    use super::*;
    #[test]
    fn stale_or_mismatched_worker_audio_is_rejected() {
        let reply =
            json!({"request_id":"42","text_hash":"expected","language":"English","voice":"Vivian"});
        assert!(validate_reply(&reply, "42", "expected", "English", "Vivian").is_ok());
        for key in ["request_id", "text_hash", "language", "voice"] {
            let mut wrong = reply.clone();
            wrong[key] = json!("different");
            assert!(
                validate_reply(&wrong, "42", "expected", "English", "Vivian").is_err(),
                "{key}"
            );
        }
        assert!(validate_reply(
            &json!({"audio":"old"}),
            "42",
            "expected",
            "English",
            "Vivian"
        )
        .is_err());
    }
    struct TestDirectory(PathBuf);
    impl TestDirectory {
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn test_directory() -> TestDirectory {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "cup-qwen-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir(&path).unwrap();
        TestDirectory(path)
    }
    fn sample(value: i16) -> Vec<u8> {
        let mut bytes = b"RIFF".to_vec();
        bytes.extend(38u32.to_le_bytes());
        bytes.extend(b"WAVEfmt ");
        bytes.extend(16u32.to_le_bytes());
        bytes.extend([1, 0, 1, 0]);
        bytes.extend(24000u32.to_le_bytes());
        bytes.extend(48000u32.to_le_bytes());
        bytes.extend([2, 0, 16, 0]);
        bytes.extend(b"data");
        bytes.extend(2u32.to_le_bytes());
        bytes.extend(value.to_le_bytes());
        bytes
    }
    #[test]
    fn preview_rejects_silence_corruption_and_invalid_voice_paths() {
        let root = test_directory();
        assert!(preview_path(root.path(), "0.6B", "../../outside").is_err());
        assert!(preview_path(root.path(), "unknown", "Vivian").is_err());
        let path = preview_path(root.path(), "0.6B", "Vivian").unwrap();
        fs::write(&path, sample(0)).unwrap();
        assert!(preview_bytes(&path).is_none());
        fs::write(&path, sample(1000)).unwrap();
        assert_eq!(preview_bytes(&path).unwrap(), sample(1000));
        let mut truncated = sample(1000);
        truncated.pop();
        fs::write(path, truncated).unwrap();
        assert!(preview_bytes(&preview_path(root.path(), "0.6B", "Vivian").unwrap()).is_none());
    }
    #[test]
    fn removal_only_deletes_selected_owned_weights_and_keeps_runtime() {
        let root = test_directory();
        let model = root.path().join("model-0.6B");
        fs::create_dir(&model).unwrap();
        fs::write(model.join("weights"), b"test").unwrap();
        fs::create_dir(root.path().join("environment")).unwrap();
        fs::create_dir(root.path().join("model-1.7B")).unwrap();
        fs::write(
            root.path().join("installed-0.6B.json"),
            serde_json::to_vec(&json!({"model":model})).unwrap(),
        )
        .unwrap();
        fs::write(root.path().join("preview-0.6B.wav"), sample(1000)).unwrap();
        remove_model_files(root.path(), "0.6B").unwrap();
        assert!(!model.exists());
        assert!(!root.path().join("installed-0.6B.json").exists());
        assert!(!root.path().join("preview-0.6B.wav").exists());
        assert!(root.path().join("environment").exists());
        assert!(root.path().join("model-1.7B").exists());
    }
    #[test]
    fn removal_never_deletes_shared_or_symlinked_models() {
        let root = test_directory();
        let shared = test_directory();
        fs::write(shared.path().join("weights"), b"keep").unwrap();
        let marker = root.path().join("installed-0.6B.json");
        fs::write(
            &marker,
            serde_json::to_vec(&json!({"model":shared.path()})).unwrap(),
        )
        .unwrap();
        remove_model_files(root.path(), "0.6B").unwrap();
        assert!(shared.path().join("weights").exists());
        let linked = root.path().join("model-0.6B");
        std::os::unix::fs::symlink(shared.path(), &linked).unwrap();
        fs::write(
            &marker,
            serde_json::to_vec(&json!({"model":linked})).unwrap(),
        )
        .unwrap();
        assert!(remove_model_files(root.path(), "0.6B").is_err());
        assert!(shared.path().join("weights").exists());
        assert!(marker.exists());
    }
    #[test]
    fn unload_can_terminate_a_child_while_the_worker_is_busy() {
        let mut child = command("cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let input = child.stdin.take().unwrap();
        let output = BufReader::new(child.stdout.take().unwrap());
        let child = Arc::new(Mutex::new(child));
        let mut slot = worker().lock().unwrap();
        *slot = Some(Worker {
            child: child.clone(),
            input,
            output,
            variant: "test".into(),
        });
        *worker_process().lock().unwrap() = Some(child.clone());
        terminate_worker();
        assert!(child.lock().unwrap().try_wait().unwrap().is_some());
        *slot = None;
    }
}
