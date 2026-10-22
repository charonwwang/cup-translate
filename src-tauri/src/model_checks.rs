//! Read-only preflight for speech models whose native runtimes ship with the app.
use serde_json::{json, Value};
#[tauri::command]
pub async fn native_speech_device_check(
    app: tauri::AppHandle,
    family: String,
    voice_id: Option<String>,
) -> Result<Value, String> {
    let root = app
        .path_resolver()
        .app_config_dir()
        .ok_or("Application directory unavailable")?;
    let (supported, bytes, reason) = match family.as_str() {
        "kokoro" => {
            let status = crate::kokoro::kokoro_model_status(app.clone()).await?;
            (
                status["supported"] == true,
                status["model"]["archiveBytes"].as_u64().unwrap_or(0),
                status["reason"].as_str().unwrap_or_default().to_owned(),
            )
        }
        "piper" => {
            let status = crate::piper::piper_catalog(app.clone()).await?;
            let id = voice_id.ok_or("Select a Piper voice first")?;
            let voice = status["voices"]
                .as_array()
                .and_then(|entries| entries.iter().find(|v| v["voice"]["id"] == id))
                .ok_or("Piper voice unavailable on this platform")?;
            let bytes = voice["voice"]["files"]
                .as_array()
                .map(|files| {
                    files
                        .iter()
                        .filter(|v| {
                            !v["name"]
                                .as_str()
                                .unwrap_or_default()
                                .starts_with("samples/")
                        })
                        .filter_map(|v| v["bytes"].as_u64())
                        .sum()
                })
                .unwrap_or(0);
            (
                status["supported"] == true,
                bytes,
                status["reason"].as_str().unwrap_or_default().to_owned(),
            )
        }
        _ => return Err("Unknown speech model family".into()),
    };
    Ok(
        json!({"supported":supported,"reason":reason,"platform":std::env::consts::OS,"architecture":std::env::consts::ARCH,"diskAvailable":fs2::available_space(root).map_err(|e|e.to_string())?,"diskRequired":bytes.saturating_mul(3)+200_000_000,"modelBytes":bytes,"bundledRuntime":true,"dependencyBytes":0}),
    )
}
