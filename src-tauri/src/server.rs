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
    if ocr_uses_internal_screenshot(request.url()) {
        ocr_recognize();
    } else {
        recognize_window();
    }
    response_ok(request);
}

fn handle_ocr_translate(request: Request) {
    if ocr_uses_internal_screenshot(request.url()) {
        ocr_translate();
    } else {
        image_translate();
    }
    response_ok(request);
}

/// 判断 OCR 请求是否应使用软件内截图。
///
/// 契约（UPSTREAM_README §API）：
/// - `/ocr_recognize`（无参数）与 `?screenshot=true` → 应用自己截图
/// - `?screenshot=false` → 外部工具已截好图，只做识别
///
/// 不能用 `url.ends_with("false")`：那样 `?x=notfalse`、`?foo=false`
/// 这类无关参数会被误判为「不截图」，而 `?screenshot=false&extra=1`
/// 又会被漏判。这里精确解析 `screenshot` 参数，未知取值按默认（截图）处理。
fn ocr_uses_internal_screenshot(url: &str) -> bool {
    let Some(query) = url.split_once('?').map(|(_, query)| query) else {
        // 无查询串：默认走软件内截图
        return true;
    };
    for pair in query.split('&') {
        let (key, value) = match pair.split_once('=') {
            Some((key, value)) => (key, value),
            None => (pair, ""),
        };
        if key == "screenshot" {
            // 只有显式 false 才交给外部截图；其余取值（含 true/空）按默认处理
            return value != "false";
        }
    }
    true
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
    use super::ocr_uses_internal_screenshot;

    #[test]
    fn ocr_screenshot_parameter_is_parsed_exactly() {
        // 契约：无参数 / screenshot=true → 软件内截图
        assert!(ocr_uses_internal_screenshot("/ocr_recognize"));
        assert!(ocr_uses_internal_screenshot("/ocr_translate"));
        assert!(ocr_uses_internal_screenshot("/ocr_recognize?screenshot=true"));
        assert!(ocr_uses_internal_screenshot("/ocr_translate?screenshot=true"));

        // 契约：screenshot=false → 使用外部已截好的图
        assert!(!ocr_uses_internal_screenshot("/ocr_recognize?screenshot=false"));
        assert!(!ocr_uses_internal_screenshot("/ocr_translate?screenshot=false"));
        // 参数顺序无关，附加参数不影响判定（旧 ends_with("false") 会漏判）
        assert!(!ocr_uses_internal_screenshot(
            "/ocr_recognize?screenshot=false&extra=1"
        ));
        assert!(!ocr_uses_internal_screenshot(
            "/ocr_recognize?extra=1&screenshot=false"
        ));

        // 无关参数以 false 结尾不得误判为「外部截图」
        // （旧 ends_with("false") 会把它们当成 screenshot=false）
        assert!(ocr_uses_internal_screenshot("/ocr_recognize?x=notfalse"));
        assert!(ocr_uses_internal_screenshot("/ocr_recognize?foo=false"));
        assert!(ocr_uses_internal_screenshot("/ocr_recognize?other=notfalse"));
    }

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
