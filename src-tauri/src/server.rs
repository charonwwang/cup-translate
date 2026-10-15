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
                    // 文案按 app_language 本地化（见 notification.rs）
                    let text = crate::notification::text(crate::notification::NotificationKind::ServerStartFailed);
                    let _ = notification::Notification::new(&identifier)
                        .title(text.title)
                        .body(text.body)
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

    // 按**路径**路由，查询串交给各处理器自己解析。
    //
    // 修复前这里是一组精确字符串匹配，把 `?screenshot=true/false` 也写进了 match 臂：
    //   "/ocr_recognize?screenshot=false" => handle_ocr_recognize(request),
    //   "/ocr_recognize?screenshot=true"  => handle_ocr_recognize(request),
    // 于是只有这 4 个硬编码 URL 能进来，其余组合（如
    // `/ocr_recognize?screenshot=false&extra=1`、`/ocr_recognize?x=1`）一律 404——
    // 而 ocr_uses_internal_screenshot() **专门**为这些组合写了参数解析、
    // 还配了单元测试，却永远走不到（实测确认：带额外参数的 URL 返回 404）。
    //
    // 这正是它要处理的情况：文档给的 curl 示例是
    // `/ocr_recognize?screenshot=false`，但用户从 shell/脚本里追加参数
    // （常用于 cache-busting，或让不同截图工具共用同一端点）是常见做法，
    // 而 HTTP 语义也要求「同路径、不同查询串」应命中同一资源。
    let path = request_path(request.url());
    match path.as_str() {
        "/" => handle_translate(request),
        "/config" => handle_config(request),
        "/translate" => handle_translate(request),
        "/selection_translate" => handle_selection_translate(request),
        "/input_translate" => handle_input_translate(request),
        "/ocr_recognize" => handle_ocr_recognize(request),
        "/ocr_translate" => handle_ocr_translate(request),
        _ => {
            warn!("Unknown request url: {}", request.url());
            response(request, StatusCode(404), "not found");
        }
    }
}

/// 全部可路由的**路径**（不含查询串）。
///
/// 与 `http_handle` 的 match 臂一一对应，给测试一个可断言的清单：
/// 它保证「路由表里不会混进带 `?` 的条目」（那正是修复前的形态），
/// 而 [`request_path`] 保证运行时只按路径匹配。两者配对才算完整契约。
///
/// `#[cfg(test)]`：这个清单只服务于测试（发布构建里不必存在）。
/// 早先没加这个属性，clippy 报 `constant ROUTES is never used`——
/// 因为在非测试构建下它确实没有任何使用者。加上属性后两处都干净了，
/// 且不影响测试下的可见性。
#[cfg(test)]
const ROUTES: [&str; 7] = [
    "/",
    "/config",
    "/translate",
    "/selection_translate",
    "/input_translate",
    "/ocr_recognize",
    "/ocr_translate",
];

/// 取出 URL 的路径部分（丢掉 `?` 之后的查询串）。
///
/// 单独抽成函数是为了能被测试直接调用：路由表只认路径，
/// 查询串一律交给处理器（如 [`ocr_uses_internal_screenshot`]）解析。
fn request_path(url: &str) -> String {
    url.split('?').next().unwrap_or("").to_string()
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
    use super::request_path;
    use super::ROUTES;

    /// 路由表必须与 [`ROUTES`] 完全一致，且**不含查询串**。
    ///
    /// 为什么要读源码：`request_path` 是纯函数，单独测它无法证明路由真的用了它——
    /// 实测过这个变异：把 `http_handle` 的 match 改回精确字符串匹配
    /// （臂里写死 `?screenshot=true/false`），仅测 `request_path` 的断言**全部照过**。
    /// 所以这里直接扫描 `http_handle` 里的 match 臂，把两边钉在一起。
    #[test]
    fn the_router_matches_on_bare_paths_only() {
        let source = include_str!("server.rs");
        // 只看 http_handle 函数体，避免把测试里的字符串也算进来
        let start = source
            .find("fn http_handle(")
            .expect("http_handle should exist");
        let body = &source[start..];
        let end = body.find("\n/// 全部可路由").expect("ROUTES marker should exist");
        let router = &body[..end];

        // 1) 路由必须先把查询串剥掉
        assert!(
            router.contains("request_path(request.url())"),
            "http_handle must route on the path, not on the raw url"
        );

        // 2) 每一条 match 臂都必须是裸路径，不能带 '?'
        for line in router.lines() {
            let trimmed = line.trim();
            if !trimmed.starts_with('"') {
                continue;
            }
            let arm = trimmed.split("=>").next().unwrap_or("").trim();
            assert!(
                !arm.contains('?'),
                "route arms must not embed a query string (found {arm}); \
                 the query string is the handler's job (see ocr_uses_internal_screenshot)"
            );
            assert!(
                ROUTES.contains(&arm.trim_matches('"')),
                "route arm {arm} is missing from the ROUTES list used by the tests"
            );
        }

        // 3) ROUTES 里也不许出现带 '?' 或重复的条目
        for route in ROUTES {
            assert!(!route.contains('?'), "ROUTES must hold bare paths, got {route}");
        }
        let mut seen = ROUTES.to_vec();
        seen.sort_unstable();
        seen.dedup();
        assert_eq!(seen.len(), ROUTES.len(), "ROUTES must not contain duplicates");
    }

    /// 文档里的四个 OCR 端点必须仍然可达——其中包括过去唯一能进的那几种写法。
    #[test]
    fn documented_ocr_endpoints_still_route() {
        for url in [
            "/ocr_recognize",
            "/ocr_recognize?screenshot=true",
            "/ocr_recognize?screenshot=false",
            "/ocr_translate?screenshot=false",
        ] {
            assert!(
                ROUTES.contains(&request_path(url).as_str()),
                "documented endpoint must still route: {url}"
            );
        }
    }

    /// 路由必须按**路径**匹配，而不是整条 URL。
    ///
    /// 修复前 match 的臂里写死了 `?screenshot=true` / `?screenshot=false` 四种组合，
    /// 于是 `/ocr_recognize?screenshot=false&extra=1` 这类 URL 直接 404——
    /// 尽管 `ocr_uses_internal_screenshot` 专门支持它（上面那条测试就断言了支持）。
    /// 两处逻辑互相矛盾，只有一种能生效；这里把路由一侧钉死。
    #[test]
    fn routing_key_is_the_path_and_ignores_the_query_string() {
        // 同一路径 + 任意查询串，都必须归约到同一个路由键
        for url in [
            "/ocr_recognize",
            "/ocr_recognize?screenshot=true",
            "/ocr_recognize?screenshot=false",
            "/ocr_recognize?screenshot=false&extra=1",
            "/ocr_recognize?extra=1&screenshot=false",
            "/ocr_recognize?x=notfalse",
            "/ocr_recognize?foo=false",
            "/ocr_recognize?a=1&b=2&c=3",
        ] {
            assert_eq!(
                request_path(url),
                "/ocr_recognize",
                "every query string on the same path must route identically ({url})"
            );
        }

        for url in [
            "/ocr_translate",
            "/ocr_translate?screenshot=true",
            "/ocr_translate?screenshot=false",
            "/ocr_translate?screenshot=false&extra=1",
        ] {
            assert_eq!(request_path(url), "/ocr_translate", "…({url})");
        }

        assert_eq!(request_path("/"), "/");
        assert_eq!(request_path("/?x=1"), "/");
        assert_eq!(request_path("/config"), "/config");
        assert_eq!(request_path("/translate"), "/translate");
        assert_eq!(request_path("/selection_translate"), "/selection_translate");
        assert_eq!(request_path("/input_translate"), "/input_translate");
    }

    /// 未知路径仍要被拒（不要让上面那条放宽变成「什么都能进」）。
    #[test]
    fn unknown_paths_still_do_not_route() {
        let known = [
            "/",
            "/config",
            "/translate",
            "/selection_translate",
            "/input_translate",
            "/ocr_recognize",
            "/ocr_translate",
        ];
        for url in [
            "/nope",
            "/nope?x=1",
            "/ocr_recognition",
            "/ocr_recognize/sub",
            "/translate/extra",
            "/OCR_RECOGNIZE",
            "",
            "?screenshot=false",
        ] {
            assert!(
                !known.contains(&request_path(url).as_str()),
                "unknown path must not match any route: {url}"
            );
        }
    }

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
