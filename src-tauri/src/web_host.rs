use super::{
    apply_integration_settings, config, sync_model_catalog, user_state, IntegrationStatus, PiHost,
    SettingsInput,
};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{Read, Write},
    net::{Shutdown, SocketAddr, TcpListener, TcpStream},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use tauri::AppHandle;
use uuid::Uuid;

const WEB_HOST_ADDR: &str = "127.0.0.1:43123";
const MAX_HEADER_BYTES: usize = 16 * 1024;
const MAX_BODY_BYTES: usize = 512 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(8);
const PROMPT_TIMEOUT: Duration = Duration::from_secs(125);

#[derive(Debug)]
struct HttpRequest {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CredentialInput {
    api_key: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InputEnvelope<T> {
    input: T,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StateEnvelope {
    state: user_state::UserState,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PromptInput {
    message: String,
    timeout_ms: Option<u64>,
}

pub struct WebHost {
    address: SocketAddr,
    shutdown: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}

impl WebHost {
    pub fn start(app: AppHandle, host: PiHost) -> Result<Self, String> {
        let listener = TcpListener::bind(WEB_HOST_ADDR)
            .map_err(|error| format!("cannot bind local web host at {WEB_HOST_ADDR}: {error}"))?;
        listener
            .set_nonblocking(true)
            .map_err(|error| format!("cannot configure local web host: {error}"))?;
        let address = listener
            .local_addr()
            .map_err(|error| format!("cannot inspect local web host address: {error}"))?;
        let shutdown = Arc::new(AtomicBool::new(false));
        let worker_shutdown = shutdown.clone();
        let token = format!("fh_{}", Uuid::new_v4());
        let worker_token = token.clone();
        let join = thread::spawn(move || {
            while !worker_shutdown.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let app = app.clone();
                        let host = host.clone();
                        let token = worker_token.clone();
                        thread::spawn(move || handle_connection(stream, &app, &host, &token));
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(25));
                    }
                    Err(_) => break,
                }
            }
        });
        Ok(Self {
            address,
            shutdown,
            join: Some(join),
        })
    }

    pub fn stop(&mut self) {
        self.shutdown.store(true, Ordering::Release);
        let _ = TcpStream::connect_timeout(&self.address, Duration::from_millis(100));
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

impl Drop for WebHost {
    fn drop(&mut self) {
        self.stop();
    }
}

fn handle_connection(mut stream: TcpStream, app: &AppHandle, host: &PiHost, token: &str) {
    let _ = stream.set_read_timeout(Some(REQUEST_TIMEOUT));
    let request = match read_request(&mut stream) {
        Ok(request) => request,
        Err(error) => {
            write_json(&mut stream, None, 400, json!({"error": error}));
            let _ = stream.shutdown(Shutdown::Both);
            return;
        }
    };
    let origin = request.headers.get("origin").cloned();
    if request.method == "OPTIONS" {
        if origin.as_deref().is_some_and(origin_allowed) {
            write_empty(&mut stream, origin.as_deref(), 204);
        } else {
            write_json(
                &mut stream,
                None,
                403,
                json!({"error": "origin is not allowed"}),
            );
        }
        return;
    }
    if request.path == "/api/health" && request.method == "GET" {
        write_json(
            &mut stream,
            origin.as_deref(),
            200,
            json!({"ok": true, "service": "foliomind-local-host"}),
        );
        return;
    }
    if !origin.as_deref().is_some_and(origin_allowed) {
        write_json(
            &mut stream,
            None,
            403,
            json!({"error": "origin is not allowed"}),
        );
        return;
    }
    if request.path == "/api/session" && request.method == "GET" {
        write_json(
            &mut stream,
            origin.as_deref(),
            200,
            json!({"token": token, "service": "foliomind-local-host"}),
        );
        return;
    }
    if request.headers.get("x-foliomind-host").map(String::as_str) != Some(token) {
        write_json(
            &mut stream,
            origin.as_deref(),
            401,
            json!({"error": "invalid local host session"}),
        );
        return;
    }

    let result = route_request(&request, app, host);
    match result {
        Ok(body) => write_json(&mut stream, origin.as_deref(), 200, body),
        Err((status, error)) => write_json(
            &mut stream,
            origin.as_deref(),
            status,
            json!({"error": error}),
        ),
    }
    let _ = stream.shutdown(Shutdown::Both);
}

fn route_request(
    request: &HttpRequest,
    app: &AppHandle,
    host: &PiHost,
) -> Result<Value, (u16, String)> {
    match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/api/integration/status") => {
            let status = IntegrationStatus {
                credential_configured: host
                    .credentials
                    .read_qveris_key()
                    .map_err(internal_error)?
                    .is_some(),
                settings: config::load(app).map_err(internal_error)?,
            };
            serde_json::to_value(status).map_err(internal_error)
        }
        ("POST", "/api/integration/credential") => {
            let input: CredentialInput = parse_body(request).map_err(client_error)?;
            host.credentials
                .write_qveris_key(&input.api_key)
                .map_err(internal_error)?;
            host.discard_staged_model_catalog(None);
            Ok(json!({"configured": true}))
        }
        ("DELETE", "/api/integration/credential") => {
            host.credentials
                .delete_qveris_key()
                .map_err(internal_error)?;
            host.discard_staged_model_catalog(None);
            Ok(json!({"configured": false}))
        }
        ("POST", "/api/integration/models/sync") => {
            let envelope: InputEnvelope<SettingsInput> =
                parse_body(request).map_err(client_error)?;
            serde_json::to_value(
                sync_model_catalog(host, app, envelope.input).map_err(internal_error)?,
            )
            .map_err(internal_error)
        }
        ("POST", "/api/integration/settings") => {
            let envelope: InputEnvelope<SettingsInput> =
                parse_body(request).map_err(client_error)?;
            serde_json::to_value(
                apply_integration_settings(host, app.clone(), envelope.input)
                    .map_err(internal_error)?,
            )
            .map_err(internal_error)
        }
        ("GET", "/api/user-state") => {
            serde_json::to_value(user_state::load(app).map_err(internal_error)?)
                .map_err(internal_error)
        }
        ("POST", "/api/user-state") => {
            let envelope: StateEnvelope = parse_body(request).map_err(client_error)?;
            serde_json::to_value(user_state::save(app, &envelope.state).map_err(internal_error)?)
                .map_err(internal_error)
        }
        ("GET", "/api/runtime/status") => {
            serde_json::to_value(host.status()).map_err(internal_error)
        }
        ("POST", "/api/runtime/start") => {
            serde_json::to_value(host.start(app.clone()).map_err(internal_error)?)
                .map_err(internal_error)
        }
        ("POST", "/api/runtime/stop") => {
            serde_json::to_value(host.stop(app.clone()).map_err(internal_error)?)
                .map_err(internal_error)
        }
        ("POST", "/api/runtime/abort") => {
            let response = host
                .request(json!({"type": "abort"}), Duration::from_secs(5))
                .map_err(internal_error)?;
            ensure_rpc_success(&response)?;
            Ok(response)
        }
        ("POST", "/api/runtime/prompt") => {
            let input: PromptInput = parse_body(request).map_err(client_error)?;
            run_prompt(host, app, input)
        }
        _ => Err((404, "route not found".into())),
    }
}

fn run_prompt(host: &PiHost, app: &AppHandle, input: PromptInput) -> Result<Value, (u16, String)> {
    let message = input.message.trim();
    if message.is_empty() || message.len() > 32_000 {
        return Err((400, "分析问题不能为空且不能超过 32,000 个字符".into()));
    }
    let receiver = host.subscribe_web_events();
    if matches!(
        host.status().state,
        super::RuntimeState::Stopped | super::RuntimeState::Crashed
    ) {
        host.start(app.clone()).map_err(internal_error)?;
    }
    let response = host
        .request(
            json!({"type": "prompt", "message": message}),
            Duration::from_secs(30),
        )
        .map_err(internal_error)?;
    ensure_rpc_success(&response)?;
    let timeout = Duration::from_millis(
        input
            .timeout_ms
            .unwrap_or(PROMPT_TIMEOUT.as_millis() as u64)
            .clamp(1_000, 125_000),
    );
    let deadline = Instant::now() + timeout;
    let mut text = String::new();
    let mut audits = Vec::new();
    let mut terminal_error = None;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err((504, "Pi 分析等待超时".into()));
        }
        let event = receiver
            .recv_timeout(remaining)
            .map_err(|error| match error {
                std::sync::mpsc::RecvTimeoutError::Timeout => (504, "Pi 分析等待超时".into()),
                std::sync::mpsc::RecvTimeoutError::Disconnected => {
                    (502, "本地 Host 事件通道已关闭".into())
                }
            })?;
        if event.kind == "qveris_audit" {
            if let Some(audit) = event.frame.as_ref().and_then(|frame| frame.get("audit")) {
                audits.push(audit.clone());
            }
            continue;
        }
        let Some(frame) = event.frame else { continue };
        if frame.get("type").and_then(Value::as_str) == Some("message_end") {
            if let Some(message) = frame.get("message") {
                if message.get("role").and_then(Value::as_str) == Some("assistant") {
                    if let Some(value) = frame_text(message) {
                        text = value;
                    }
                    if message.get("stopReason").and_then(Value::as_str) == Some("error") {
                        terminal_error = message
                            .get("errorMessage")
                            .and_then(Value::as_str)
                            .map(str::to_owned);
                    }
                }
            }
        }
        if frame.get("type").and_then(Value::as_str) == Some("agent_settled") {
            if let Some(error) = terminal_error {
                return Err((502, error));
            }
            return Ok(json!({"text": text, "audits": audits}));
        }
    }
}

fn frame_text(message: &Value) -> Option<String> {
    let content = message.get("content")?;
    if let Some(text) = content.as_str() {
        return Some(text.to_owned());
    }
    let values = content
        .as_array()?
        .iter()
        .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
        .map(|part| part.get("text").and_then(Value::as_str).unwrap_or_default());
    let text = values.collect::<Vec<_>>().join("");
    (!text.is_empty()).then_some(text)
}

fn ensure_rpc_success(response: &Value) -> Result<(), (u16, String)> {
    if response.get("success").and_then(Value::as_bool) == Some(false) {
        return Err((
            409,
            response
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("Pi 拒绝了请求")
                .into(),
        ));
    }
    Ok(())
}

fn parse_body<T: DeserializeOwned>(request: &HttpRequest) -> Result<T, String> {
    serde_json::from_slice(&request.body).map_err(|_| "请求 JSON 无效".into())
}

fn internal_error(error: impl ToString) -> (u16, String) {
    (500, error.to_string())
}

fn client_error(error: String) -> (u16, String) {
    (400, error)
}

fn read_request(stream: &mut TcpStream) -> Result<HttpRequest, String> {
    let mut buffer = Vec::with_capacity(4096);
    let header_end = loop {
        let mut chunk = [0_u8; 4096];
        let read = stream
            .read(&mut chunk)
            .map_err(|_| "无法读取本地 Host 请求".to_string())?;
        if read == 0 {
            return Err("请求提前关闭".into());
        }
        buffer.extend_from_slice(&chunk[..read]);
        if buffer.len() > MAX_HEADER_BYTES {
            return Err("请求头过大".into());
        }
        if let Some(index) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            break index;
        }
    };
    let header_bytes = &buffer[..header_end];
    let header_text =
        std::str::from_utf8(header_bytes).map_err(|_| "请求头不是 UTF-8".to_string())?;
    let mut lines = header_text.split("\r\n");
    let request_line = lines.next().ok_or("请求行缺失")?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().ok_or("请求方法缺失")?.to_owned();
    let target = parts.next().ok_or("请求路径缺失")?;
    let path = target.split('?').next().unwrap_or(target).to_owned();
    let mut headers = HashMap::new();
    for line in lines {
        let (name, value) = line.split_once(':').ok_or("请求头格式无效")?;
        headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_owned());
    }
    let content_length = headers.get("content-length").map_or(Ok(0), |value| {
        value.parse::<usize>().map_err(|_| "Content-Length 无效")
    })?;
    if content_length > MAX_BODY_BYTES {
        return Err("请求体过大".into());
    }
    let body_start = header_end + 4;
    while buffer.len() < body_start + content_length {
        let mut chunk = [0_u8; 4096];
        let read = stream
            .read(&mut chunk)
            .map_err(|_| "无法读取请求体".to_string())?;
        if read == 0 {
            return Err("请求体提前关闭".into());
        }
        buffer.extend_from_slice(&chunk[..read]);
    }
    Ok(HttpRequest {
        method,
        path,
        headers,
        body: buffer[body_start..body_start + content_length].to_vec(),
    })
}

fn origin_allowed(origin: &str) -> bool {
    let Ok(url) = url::Url::parse(origin) else {
        return false;
    };
    if url.scheme() != "http"
        || url.username() != ""
        || url.password().is_some()
        || url.path() != "/" && !url.path().is_empty()
    {
        return false;
    }
    matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1"))
}

fn write_empty(stream: &mut TcpStream, origin: Option<&str>, status: u16) {
    write_response(stream, origin, status, "text/plain; charset=utf-8", &[]);
}

fn write_json(stream: &mut TcpStream, origin: Option<&str>, status: u16, body: Value) {
    let bytes = serde_json::to_vec(&body)
        .unwrap_or_else(|_| b"{\"error\":\"response encoding failed\"}".to_vec());
    write_response(
        stream,
        origin,
        status,
        "application/json; charset=utf-8",
        &bytes,
    );
}

fn write_response(
    stream: &mut TcpStream,
    origin: Option<&str>,
    status: u16,
    content_type: &str,
    body: &[u8],
) {
    let reason = match status {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        409 => "Conflict",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        504 => "Gateway Timeout",
        _ => "Error",
    };
    let cors = origin
        .filter(|value| origin_allowed(value))
        .map_or(String::new(), |value| {
            format!("Access-Control-Allow-Origin: {value}\r\nVary: Origin\r\n")
        });
    let header = format!("HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nAccess-Control-Allow-Headers: Content-Type, X-FolioMind-Host\r\nAccess-Control-Allow-Methods: GET, POST, DELETE, OPTIONS\r\nConnection: close\r\n{cors}\r\n", body.len());
    let _ = stream.write_all(header.as_bytes());
    let _ = stream.write_all(body);
    let _ = stream.flush();
}
