// Keep the desktop and online engines available on unsupported native-model targets.
// The bundled CTranslate2 backend has no CPU dispatch for these platform/compiler combinations.
#![allow(unused_variables)]
use serde_json::{json, Value};
use tauri::AppHandle;

const UNSUPPORTED: &str = "Embedded local translation requires x64 Windows or x64/ARM64 macOS/Linux; online translation remains available";

#[tauri::command]
pub async fn local_mt_model_status(app_handle: AppHandle, pair: String) -> Result<Value, String> {
    Ok(
        json!({"pair":pair,"supported":false,"installed":false,"loaded":false,"missing":[],"reason":UNSUPPORTED}),
    )
}

#[tauri::command]
pub async fn local_mt_download_model(
    app_handle: AppHandle,
    pair: String,
    download_base: Option<String>,
) -> Result<(), String> {
    Err(UNSUPPORTED.into())
}

#[tauri::command]
pub async fn local_mt_delete_model(app_handle: AppHandle, pair: String) -> Result<(), String> {
    Err(UNSUPPORTED.into())
}

#[tauri::command]
pub async fn local_mt_unload_model(pair: String) -> Result<(), String> {
    Ok(())
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
    Err(UNSUPPORTED.into())
}

#[tauri::command]
pub async fn local_mt_install_control(
    app_handle: AppHandle,
    pair: String,
    action: String,
) -> Result<(), String> {
    Err(UNSUPPORTED.into())
}
#[tauri::command]
pub async fn local_mt_device_check(
    app_handle: AppHandle,
    model: Option<String>,
) -> Result<Value, String> {
    Ok(json!({"supported":false,"reason":UNSUPPORTED}))
}

#[tauri::command]
pub async fn local_mt_import_model(
    app_handle: AppHandle,
    pair: String,
    source_dir: String,
) -> Result<(), String> {
    Err(UNSUPPORTED.into())
}
