// Keep the desktop and online engines available on legacy 32-bit targets.
// CTranslate2's CPU dispatch has no implementation for these architectures.
#![allow(unused_variables)]
use serde_json::{json, Value};
use tauri::AppHandle;

const UNSUPPORTED: &str = "Embedded local translation requires a 64-bit x86 or ARM build; online translation remains available";

#[tauri::command]
pub async fn local_mt_model_status(app_handle: AppHandle, pair: String) -> Result<Value, String> {
    Ok(json!({"pair":pair,"supported":false,"installed":false,"loaded":false,"missing":[],"reason":UNSUPPORTED}))
}

#[tauri::command]
pub async fn local_mt_download_model(app_handle: AppHandle, pair: String) -> Result<(), String> {
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
) -> Result<String, String> {
    Err(UNSUPPORTED.into())
}
