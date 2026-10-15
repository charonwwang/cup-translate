use crate::config::{get, set};
use crate::window::*;
use crate::APP;
use log::{info, warn};
use std::io::Read;
use std::thread;
use tauri::api::notification;
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};

const DEFAULT_PORT: u16 = 60828;
const MAX_TRANSLATION_BYTES: u64 = 1024 * 1024;

pub fn start_server() {
    let port = match get("server_port")
        .and_then(|value| value.as_u64())
        .and_then(|value| u16::try_from(value).ok())
        .filter(|port| *port != 0)
    {
        Some(port) => port,
        None => {
            set("server_port", DEFAULT_PORT);
            DEFAULT_PORT
        }
    };
    thread::spawn(move || {
        let server = match Server::http(format!("127.0.0.1:{port}")) {
            Ok(v) => v,
            Err(e) => {
                if let Some(app_handle) = APP.get() {
                    let identifier = app_handle.config().tauri.bundle.identifier.clone();
                    let _ = notification::Notification::new(&identifier)
                        .title("Server start failed")
                        .body("Please Change Server Port and restart the application")
                        .show();
                }
                warn!("Server start failed: {}", e);
                return;
            }
        };
        for request in server.incoming_requests() {
            http_handle(request, port);
        }
    });
}

fn http_handle(request: Request, port: u16) {
    info!("Handle {} request", request.url());

    // A cross-site GET often has no Origin header. Fetch Metadata and Host also
    // protect that case while ordinary local HTTP clients remain supported.
    if !request_is_local(&request, port) {
        response(request, StatusCode(403), "forbidden");
        return;
    }
    if request.method() != &Method::Get && request.method() != &Method::Post {
        response(request, StatusCode(405), "method not allowed");
        return;
    }

    match request.url() {
        "/" => handle_translate(request),
        "/config" => handle_config(request),
        "/translate" => handle_translate(request),
        "/selection_translate" => handle_selection_translate(request),
        "/input_translate" => handle_input_translate(request),
        "/ocr_recognize" => handle_ocr_recognize(request),
        "/ocr_translate" => handle_ocr_translate(request),
        "/ocr_recognize?screenshot=false" => handle_ocr_recognize(request),
        "/ocr_translate?screenshot=false" => handle_ocr_translate(request),
        "/ocr_recognize?screenshot=true" => handle_ocr_recognize(request),
        "/ocr_translate?screenshot=true" => handle_ocr_translate(request),
        _ => {
            warn!("Unknown request url: {}", request.url());
            response(request, StatusCode(404), "not found");
        }
    }
}

fn header<'a>(request: &'a Request, name: &'static str) -> Option<&'a str> {
    request
        .headers()
        .iter()
        .find(|header| header.field.equiv(name))
        .map(|header| header.value.as_str())
}

fn request_is_local(request: &Request, port: u16) -> bool {
    browser_request_is_local(
        header(request, "Host"),
        header(request, "Origin"),
        header(request, "Referer"),
        header(request, "Sec-Fetch-Site"),
        port,
    )
}

fn browser_request_is_local(
    host: Option<&str>,
    origin: Option<&str>,
    referer: Option<&str>,
    fetch_site: Option<&str>,
    port: u16,
) -> bool {
    if !matches!(host, Some(value) if value == format!("127.0.0.1:{port}") || value == format!("localhost:{port}"))
    {
        return false;
    }
    if let Some(origin) = origin {
        if !matches!(
            origin,
            "tauri://localhost" | "https://tauri.localhost" | "http://localhost:1420"
        ) {
            return false;
        }
    }
    if let Some(referer) = referer {
        if ![
            "tauri://localhost/",
            "https://tauri.localhost/",
            "http://localhost:1420/",
        ]
        .iter()
        .any(|prefix| referer.starts_with(prefix))
        {
            return false;
        }
    }
    matches!(fetch_site, None | Some("none") | Some("same-origin"))
}

fn handle_config(request: Request) {
    config_window();
    response_ok(request);
}

fn handle_translate(mut request: Request) {
    let mut content = String::new();
    match request
        .as_reader()
        .take(MAX_TRANSLATION_BYTES + 1)
        .read_to_string(&mut content)
    {
        Ok(size) if size as u64 > MAX_TRANSLATION_BYTES => {
            response(request, StatusCode(413), "translation text is too large");
            return;
        }
        Err(error) => {
            warn!("Invalid translation request body: {}", error);
            response(request, StatusCode(400), "invalid translation text");
            return;
        }
        _ => {}
    }
    if content.trim().is_empty() {
        response(request, StatusCode(400), "translation text is empty");
        return;
    }
    text_translate(content);
    response_ok(request);
}

fn handle_selection_translate(request: Request) {
    selection_translate();
    response_ok(request);
}

fn handle_input_translate(request: Request) {
    input_translate();
    response_ok(request);
}

fn handle_ocr_recognize(request: Request) {
    if request.url().ends_with("false") {
        recognize_window();
    } else {
        ocr_recognize();
    }
    response_ok(request);
}

fn handle_ocr_translate(request: Request) {
    if request.url().ends_with("false") {
        image_translate();
    } else {
        ocr_translate();
    }
    response_ok(request);
}

fn response_ok(request: Request) {
    response(request, StatusCode(200), "ok");
}

fn response(request: Request, status: StatusCode, body: &str) {
    let mut response = Response::from_string(body).with_status_code(status);
    if let Ok(header) = Header::from_bytes("Content-Type", "text/plain; charset=utf-8") {
        response.add_header(header);
    }
    if let Err(error) = request.respond(response) {
        warn!("Failed to send local server response: {}", error);
    }
}

#[cfg(test)]
mod tests {
    use super::browser_request_is_local;

    #[test]
    fn browser_requests_cannot_trigger_local_actions_from_foreign_sites() {
        let port = 60828;
        assert!(browser_request_is_local(
            Some("127.0.0.1:60828"),
            None,
            None,
            None,
            port
        ));
        assert!(!browser_request_is_local(
            Some("127.0.0.1:60828"),
            None,
            None,
            Some("cross-site"),
            port
        ));
        assert!(!browser_request_is_local(
            Some("evil.example:60828"),
            None,
            None,
            Some("same-origin"),
            port
        ));
        assert!(!browser_request_is_local(
            Some("localhost:60828"),
            Some("https://evil.example"),
            None,
            None,
            port
        ));
        assert!(browser_request_is_local(
            Some("localhost:60828"),
            Some("tauri://localhost"),
            None,
            Some("same-origin"),
            port
        ));
    }
}
