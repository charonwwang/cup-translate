#![allow(unused_variables)]
const REASON: &str =
    "Bundled Piper requires macOS 14+ ARM64, Linux x86_64/ARM64, or Windows x86_64";
#[tauri::command]
pub async fn piper_catalog(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({"supported":false,"voices":[],"reason":REASON}))
}
#[tauri::command]
pub async fn piper_download(
    app: tauri::AppHandle,
    id: String,
    accepted: bool,
) -> Result<(), String> {
    Err(REASON.into())
}
#[tauri::command]
pub fn piper_cancel(id: String) -> Result<(), String> {
    Err(REASON.into())
}
#[tauri::command]
pub async fn piper_uninstall(app: tauri::AppHandle, id: String) -> Result<(), String> {
    Err(REASON.into())
}
#[tauri::command]
pub async fn piper_speak(
    app: tauri::AppHandle,
    text: String,
    lang: String,
    _voiceid: Option<String>,
) -> Result<Vec<u8>, String> {
    Err(REASON.into())
}
#[tauri::command]
pub async fn piper_preview(app: tauri::AppHandle, id: String) -> Result<Vec<u8>, String> {
    Err(REASON.into())
}
