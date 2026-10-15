#[cfg(updater)]
use crate::config::{get_bool, set};
#[cfg(updater)]
use crate::window::updater_window;
#[cfg(updater)]
use log::{info, warn};

#[cfg(updater)]
pub fn check_update(app_handle: tauri::AppHandle) {
    let enable = match get_bool("check_update") {
        Some(v) => v,
        None => {
            set("check_update", true);
            true
        }
    };
    if enable {
        tauri::async_runtime::spawn(async move {
            match tauri::updater::builder(app_handle).check().await {
                Ok(update) => {
                    if update.is_update_available() {
                        info!("New version available");
                        updater_window();
                    }
                }
                Err(e) => {
                    warn!("Failed to check update: {}", e);
                }
            }
        });
    }
}

#[cfg(not(updater))]
pub fn check_update(_app_handle: tauri::AppHandle) {}
