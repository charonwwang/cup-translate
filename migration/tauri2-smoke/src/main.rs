use std::sync::{
    atomic::{AtomicU8, Ordering},
    Arc,
};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

#[tauri::command]
fn probe(value: &str) -> String {
    format!("rust:{value}")
}

fn main() {
    let automated = std::env::args_os().skip(1).any(|arg| arg == "--automated");
    let profile = tempfile::Builder::new()
        .prefix("cup-tauri2-smoke-")
        .tempdir()
        .expect("create a disposable WebView profile");

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![probe])
        .setup(move |app| {
            let complete = Arc::new(AtomicU8::new(0));
            println!("Tauri 2 identifier: {}", app.config().identifier);
            for (label, expected, bit) in [
                ("smoke", "Tauri 2 IPC: allowed", 1),
                ("unprivileged", "Tauri 2 IPC: denied", 2),
            ] {
                let complete = Arc::clone(&complete);
                WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
                    .incognito(true)
                    .data_directory(profile.path().join(label))
                    .visible(!automated)
                    .on_document_title_changed(move |window, title| {
                        if !title.starts_with("Tauri 2 IPC:") {
                            return;
                        }
                        println!("{label}: {title}");
                        if title != expected {
                            if automated {
                                window.app_handle().exit(1);
                            }
                            return;
                        }
                        if complete.fetch_or(bit, Ordering::AcqRel) | bit == 3 && automated {
                            window.app_handle().exit(0);
                        }
                    })
                    .build()?;
            }
            app.manage(profile);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("run the Tauri 2 smoke app");
}
