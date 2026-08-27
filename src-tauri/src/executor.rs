use crate::{config, credentials::CredentialStore};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    io::{Read, Write},
    net::{Shutdown, TcpListener, TcpStream},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::Duration,
};
use url::Url;
use uuid::Uuid;

pub const BRIDGE_VERSION: &str = "foliomind-bridge.v1";
const MAX_REQUEST_BYTES: usize = 512 * 1024;
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const MAX_MODEL_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
const UPSTREAM_TIMEOUT: Duration = Duration::from_secs(15);
const MODEL_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_QUERY_BYTES: usize = 4 * 1024;
const MAX_IDENTIFIER_BYTES: usize = 256;
const MAX_TOOL_IDS: usize = 5;
const MAX_PARAMETERS_BYTES: usize = 256 * 1024;
const STREAM_CHUNK_BYTES: usize = 16 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEvent {
    pub operation: String,
    pub run_id: String,
    pub tool_call_id: String,
    pub outcome: String,
    pub detail: Option<String>,
}

#[derive(Clone)]
pub struct BridgeEnvironment {
    pub url: String,
    pub capability: String,
    pub model_base_url: String,
    pub model_capability: String,
    pub run_id: String,
    pub product_run_id: String,
}

pub struct RunExecutor {
    address: std::net::SocketAddr,
    shutdown: Arc<AtomicBool>,
}

#[derive(Debug, Deserialize)]
struct BridgeRequest {
    bridge_version: String,
    run_id: String,
    product_run_id: String,
    tool_call_id: String,
    operation: String,
    input: Value,
}

impl RunExecutor {
    pub fn start(
        credential_store: Arc<dyn CredentialStore>,
        base_url: String,
        model_gateway_url: String,
        audit: Arc<dyn Fn(AuditEvent) + Send + Sync>,
    ) -> Result<(Self, BridgeEnvironment), String> {
        let listener = TcpListener::bind("127.0.0.1:0")
            .map_err(|error| format!("cannot bind loopback executor: {error}"))?;
        listener
            .set_nonblocking(true)
            .map_err(|error| format!("cannot configure loopback executor: {error}"))?;
        let address = listener
            .local_addr()
            .map_err(|error| format!("cannot inspect loopback executor: {error}"))?;
        let shutdown = Arc::new(AtomicBool::new(false));
        let environment = BridgeEnvironment {
            url: format!("http://127.0.0.1:{}/execute", address.port()),
            capability: format!("cap_{}", Uuid::new_v4()),
            model_base_url: format!("http://127.0.0.1:{}/model/v1", address.port()),
            model_capability: format!("model_{}", Uuid::new_v4()),
            run_id: format!("run_{}", Uuid::new_v4()),
            product_run_id: format!("product_{}", Uuid::new_v4()),
        };
        let worker_environment = environment.clone();
        let worker_shutdown = shutdown.clone();
        thread::spawn(move || {
            while !worker_shutdown.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((stream, peer)) if peer.ip().is_loopback() => {
                        let store = credential_store.clone();
                        let env = worker_environment.clone();
                        let audit = audit.clone();
                        let base = base_url.clone();
                        let model_base = model_gateway_url.clone();
                        thread::spawn(move || {
                            handle_connection(stream, store, env, base, model_base, audit)
                        });
                    }
                    Ok((stream, _)) => {
                        let _ = write_response(stream, 403, json!({"error":"loopback only"}));
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(25))
                    }
                    Err(_) => break,
                }
            }
        });
        Ok((Self { address, shutdown }, environment))
    }

    pub fn stop(&self) {
        self.shutdown.store(true, Ordering::Relaxed);
        let _ = TcpStream::connect_timeout(&self.address, Duration::from_millis(100))
            .and_then(|stream| stream.shutdown(Shutdown::Both));
    }
}

impl Drop for RunExecutor {
    fn drop(&mut self) {
        self.stop();
    }
}

fn handle_connection(
    mut stream: TcpStream,
    store: Arc<dyn CredentialStore>,
    environment: BridgeEnvironment,
    base_url: String,
    model_gateway_url: String,
    audit: Arc<dyn Fn(AuditEvent) + Send + Sync>,
) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let request = match read_request(&mut stream) {
        Ok(request) => request,
        Err(error) => {
            let _ = write_response(stream, 400, json!({"error": redact(&error)}));
            return;
        }
    };
    if request.path.starts_with("/model/v1/") {
        if !has_capability(&request.headers, &environment.model_capability) {
            let _ = write_response(stream, 401, json!({"error":"unauthorized"}));
            return;
        }
        if let Err(error) = proxy_model_request(&mut stream, &store, &model_gateway_url, request) {
            let _ = write_response(&mut stream, 502, json!({"error": redact(&error)}));
        }
        return;
    }
    if request.method != "POST" || request.path != "/execute" {
        let _ = write_response(stream, 404, json!({"error":"not found"}));
        return;
    }
    if !has_capability(&request.headers, &environment.capability) {
        let _ = write_response(stream, 401, json!({"error":"unauthorized"}));
        return;
    }
    let bridge: BridgeRequest = match serde_json::from_slice(&request.body) {
        Ok(value) => value,
        Err(_) => {
            let _ = write_response(stream, 400, json!({"error":"invalid JSON"}));
            return;
        }
    };
    if let Err(error) = validate_bridge_request(&bridge, &environment) {
        let _ = write_response(stream, 400, json!({"error":error}));
        return;
    }
    let tool_call_id = bridge.tool_call_id.clone();
    let operation = bridge.operation.clone();
    let result = execute_official_api(&store, &base_url, &bridge);
    match result {
        Ok(result) => {
            audit(AuditEvent {
                operation,
                run_id: environment.run_id,
                tool_call_id,
                outcome: "success".into(),
                detail: None,
            });
            let _ = write_response(stream, 200, json!({"result":result}));
        }
        Err(error) => {
            let safe = redact(&error);
            audit(AuditEvent {
                operation,
                run_id: environment.run_id,
                tool_call_id,
                outcome: "error".into(),
                detail: Some(safe.clone()),
            });
            let _ = write_response(stream, 502, json!({"error":safe}));
        }
    }
}

fn validate_bridge_request(
    request: &BridgeRequest,
    environment: &BridgeEnvironment,
) -> Result<(), String> {
    if request.bridge_version != BRIDGE_VERSION {
        return Err("unsupported bridge_version".into());
    }
    if request.run_id != environment.run_id || request.product_run_id != environment.product_run_id
    {
        return Err("run identity mismatch".into());
    }
    if request.tool_call_id.trim().is_empty() || request.tool_call_id.len() > 256 {
        return Err("invalid tool_call_id".into());
    }
    if !matches!(request.operation.as_str(), "search" | "inspect" | "call") {
        return Err("unsupported operation".into());
    }
    if !request.input.is_object() {
        return Err("operation input must be an object".into());
    }
    let text = |key: &str, max_bytes: usize| {
        request
            .input
            .get(key)
            .and_then(Value::as_str)
            .is_some_and(|value| !value.trim().is_empty() && value.len() <= max_bytes)
    };
    let allowed_fields: &[&str] = match request.operation.as_str() {
        "search" => &["query", "limit"],
        "inspect" => &["search_id", "tool_ids"],
        "call" => &["search_id", "tool_id", "parameters"],
        _ => unreachable!(),
    };
    if request.input.as_object().is_some_and(|input| {
        input
            .keys()
            .any(|key| !allowed_fields.contains(&key.as_str()))
    }) {
        return Err("operation input contains unsupported fields".into());
    }
    match request.operation.as_str() {
        "search"
            if !text("query", MAX_QUERY_BYTES)
                || request
                    .input
                    .get("limit")
                    .is_some_and(|limit| !matches!(limit.as_u64(), Some(1..=20))) =>
        {
            return Err("search requires a valid query and optional limit from 1 to 20".into())
        }
        "inspect"
            if !text("search_id", MAX_IDENTIFIER_BYTES)
                || !valid_tool_ids(request.input.get("tool_ids")) =>
        {
            return Err("inspect requires search_id and tool_ids".into())
        }
        "call"
            if !text("search_id", MAX_IDENTIFIER_BYTES)
                || !text("tool_id", MAX_IDENTIFIER_BYTES)
                || !valid_parameters(request.input.get("parameters")) =>
        {
            return Err("call requires search_id, tool_id and parameters".into())
        }
        _ => {}
    }
    Ok(())
}

fn valid_tool_ids(value: Option<&Value>) -> bool {
    let Some(items) = value.and_then(Value::as_array) else {
        return false;
    };
    if items.is_empty() || items.len() > MAX_TOOL_IDS {
        return false;
    }
    let mut unique = HashSet::with_capacity(items.len());
    items.iter().all(|item| {
        item.as_str().is_some_and(|id| {
            let id = id.trim();
            !id.is_empty() && id.len() <= MAX_IDENTIFIER_BYTES && unique.insert(id)
        })
    })
}

fn valid_parameters(value: Option<&Value>) -> bool {
    value.is_some_and(|parameters| {
        parameters.is_object()
            && serde_json::to_vec(parameters)
                .is_ok_and(|encoded| encoded.len() <= MAX_PARAMETERS_BYTES)
    })
}

fn has_capability(headers: &std::collections::HashMap<String, String>, capability: &str) -> bool {
    headers
        .get("authorization")
        .is_some_and(|value| value == &format!("Bearer {capability}"))
}

fn execute_official_api(
    store: &Arc<dyn CredentialStore>,
    base_url: &str,
    request: &BridgeRequest,
) -> Result<Value, String> {
    let key = store
        .read_qveris_key()?
        .filter(|key| !key.trim().is_empty())
        .ok_or("QVeris credential is not configured")?;
    let mut endpoint =
        Url::parse(base_url.trim_end_matches('/')).map_err(|_| "invalid QVeris API base URL")?;
    let path = match request.operation.as_str() {
        "search" => "search",
        "inspect" => "tools/by-ids",
        "call" => "tools/execute",
        _ => unreachable!(),
    };
    endpoint.set_path(&format!(
        "{}/{}",
        endpoint.path().trim_end_matches('/'),
        path
    ));
    if request.operation == "call" {
        let tool_id = request
            .input
            .get("tool_id")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or("call requires tool_id")?;
        endpoint.query_pairs_mut().append_pair("tool_id", tool_id);
    }
    let body = match request.operation.as_str() {
        "search" => {
            let mut body = with_policy_fields(
                &request.input,
                &[
                    ("session_id", json!(request.product_run_id.clone())),
                    ("view", json!("routing")),
                    ("lang", json!("zh")),
                ],
            );
            body.as_object_mut()
                .expect("validated object")
                .entry("limit")
                .or_insert(json!(8));
            body
        }
        "inspect" => with_policy_fields(
            &request.input,
            &[
                ("session_id", json!(request.product_run_id.clone())),
                ("view", json!("lean")),
            ],
        ),
        "call" => {
            let mut body = with_policy_fields(
                &request.input,
                &[
                    ("session_id", json!(request.product_run_id.clone())),
                    ("max_response_size", json!(20_480)),
                    ("respond_with", json!("full")),
                ],
            );
            body.as_object_mut()
                .expect("validated object")
                .remove("tool_id");
            body
        }
        _ => unreachable!(),
    };
    let client = reqwest::blocking::Client::builder()
        .timeout(UPSTREAM_TIMEOUT)
        .build()
        .map_err(|_| "cannot initialize QVeris client")?;
    let response = client
        .post(endpoint)
        .bearer_auth(key)
        .json(&body)
        .send()
        .map_err(|_| "QVeris request failed or timed out")?;
    let status = response.status();
    let mut limited = response.take((MAX_RESPONSE_BYTES + 1) as u64);
    let mut bytes = Vec::new();
    limited
        .read_to_end(&mut bytes)
        .map_err(|_| "cannot read QVeris response")?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err("QVeris response exceeds size limit".into());
    }
    if !status.is_success() {
        return Err(format!("QVeris API returned HTTP {}", status.as_u16()));
    }
    serde_json::from_slice(&bytes).map_err(|_| "QVeris API returned invalid JSON".into())
}

fn with_policy_fields(input: &Value, fields: &[(&str, Value)]) -> Value {
    let mut result = input.clone();
    let object = result.as_object_mut().expect("validated object");
    for (key, value) in fields {
        object.insert((*key).to_owned(), value.clone());
    }
    result
}

pub fn fetch_model_catalog(api_key: &str, base_url: &str) -> Result<Vec<Value>, String> {
    let endpoint = model_endpoint(base_url, "models")?;
    let client = reqwest::blocking::Client::builder()
        .timeout(UPSTREAM_TIMEOUT)
        .build()
        .map_err(|_| "cannot initialize QVeris model client")?;
    let response = client
        .get(endpoint)
        .bearer_auth(api_key)
        .header("Accept", "application/json")
        .send()
        .map_err(|_| "QVeris model catalog request failed or timed out")?;
    let status = response.status();
    let mut limited = response.take((MAX_RESPONSE_BYTES + 1) as u64);
    let mut bytes = Vec::new();
    limited
        .read_to_end(&mut bytes)
        .map_err(|_| "cannot read QVeris model catalog")?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err("QVeris model catalog exceeds size limit".into());
    }
    if !status.is_success() {
        return Err(format!(
            "QVeris model catalog returned HTTP {}",
            status.as_u16()
        ));
    }
    let payload: Value =
        serde_json::from_slice(&bytes).map_err(|_| "QVeris model catalog returned invalid JSON")?;
    let values = payload
        .get("data")
        .and_then(Value::as_array)
        .ok_or("QVeris model catalog is missing data")?;
    normalize_model_catalog(values)
}

fn normalize_model_catalog(values: &[Value]) -> Result<Vec<Value>, String> {
    let mut seen = HashSet::new();
    let mut models = values
        .iter()
        .filter_map(normalize_model)
        .filter(|model| {
            model
                .get("id")
                .and_then(Value::as_str)
                .is_some_and(|id| seen.insert(id.to_owned()))
        })
        .collect::<Vec<_>>();
    if models.len() > config::MAX_MODEL_CATALOG_ITEMS {
        return Err("QVeris model catalog contains too many chat models".into());
    }
    models.sort_by(|left, right| {
        left.get("id")
            .and_then(Value::as_str)
            .cmp(&right.get("id").and_then(Value::as_str))
    });
    if models.is_empty() {
        return Err("QVeris model catalog contains no chat models".into());
    }
    Ok(models)
}

fn normalize_model(value: &Value) -> Option<Value> {
    let id = value.get("id")?.as_str()?.trim();
    if id.is_empty() || id.len() > config::MAX_MODEL_ID_BYTES || id.chars().any(char::is_control) {
        return None;
    }
    let capabilities = value
        .get("capabilities")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let has = |name: &str| capabilities.iter().any(|item| item.as_str() == Some(name));
    if !capabilities.is_empty() && !has("chat") {
        return None;
    }
    let context_window = value
        .get("context_window")
        .and_then(Value::as_u64)
        .unwrap_or(128_000);
    let max_tokens = value
        .get("max_output_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(16_384);
    Some(
        json!({ "id": id, "name": id, "reasoning": has("reasoning"), "input": if has("vision") { json!(["text", "image"]) } else { json!(["text"]) }, "contextWindow": context_window, "maxTokens": max_tokens }),
    )
}

fn model_endpoint(base_url: &str, suffix: &str) -> Result<Url, String> {
    let mut endpoint = Url::parse(base_url.trim_end_matches('/'))
        .map_err(|_| "invalid QVeris model gateway URL")?;
    endpoint.set_path(&format!(
        "{}/{}",
        endpoint.path().trim_end_matches('/'),
        suffix.trim_start_matches('/')
    ));
    Ok(endpoint)
}

fn proxy_model_request(
    stream: &mut TcpStream,
    store: &Arc<dyn CredentialStore>,
    base_url: &str,
    request: HttpRequest,
) -> Result<(), String> {
    let key = store
        .read_qveris_key()?
        .filter(|value| !value.trim().is_empty())
        .ok_or("QVeris credential is not configured")?;
    let suffix = request
        .path
        .strip_prefix("/model/v1/")
        .ok_or("invalid model proxy path")?;
    if !matches!(suffix, "models" | "chat/completions" | "responses") {
        let _ = write_response(
            &mut *stream,
            404,
            json!({"error":"unsupported model endpoint"}),
        );
        return Ok(());
    }
    if (suffix == "models" && request.method != "GET")
        || (suffix != "models" && request.method != "POST")
    {
        let _ = write_response(&mut *stream, 405, json!({"error":"method not allowed"}));
        return Ok(());
    }
    let endpoint = model_endpoint(base_url, suffix)?;
    let client = reqwest::blocking::Client::builder()
        .timeout(MODEL_TIMEOUT)
        .build()
        .map_err(|_| "cannot initialize model proxy")?;
    let builder = if request.method == "GET" {
        client.get(endpoint)
    } else {
        client.post(endpoint).body(request.body)
    };
    let response = builder
        .bearer_auth(key)
        .header(
            "Accept",
            request
                .headers
                .get("accept")
                .map(String::as_str)
                .unwrap_or("application/json"),
        )
        .header("Content-Type", "application/json")
        .send()
        .map_err(|_| "QVeris model request failed or timed out")?;
    let status = response.status();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/json")
        .to_owned();
    if status.is_success() && is_event_stream(&content_type) {
        write_streaming_response_head(stream, status.as_u16(), &content_type)
            .map_err(|_| "cannot write model stream headers".to_string())?;
        // Headers are already visible to Pi. On an upstream/read/size failure, close the
        // response instead of appending a second HTTP response to the SSE byte stream.
        let _ = copy_stream_limited(response, stream, MAX_MODEL_RESPONSE_BYTES);
        return Ok(());
    }
    let mut limited = response.take((MAX_MODEL_RESPONSE_BYTES + 1) as u64);
    let mut bytes = Vec::new();
    limited
        .read_to_end(&mut bytes)
        .map_err(|_| "cannot read model response")?;
    if bytes.len() > MAX_MODEL_RESPONSE_BYTES {
        return Err("QVeris model response exceeds size limit".into());
    }
    write_raw_response(stream, status.as_u16(), &content_type, &bytes)
        .map_err(|_| "cannot write model response".to_string())
}

fn is_event_stream(content_type: &str) -> bool {
    content_type
        .split(';')
        .next()
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("text/event-stream"))
}

fn write_streaming_response_head(
    stream: &mut impl Write,
    status: u16,
    content_type: &str,
) -> std::io::Result<()> {
    write!(
        stream,
        "HTTP/1.1 {status} \r\nContent-Type: {content_type}\r\nCache-Control: no-cache\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n"
    )?;
    stream.flush()
}

fn copy_stream_limited(
    mut source: impl Read,
    target: &mut impl Write,
    max_bytes: usize,
) -> Result<usize, String> {
    let mut total = 0;
    let mut buffer = [0_u8; STREAM_CHUNK_BYTES];
    loop {
        let size = source
            .read(&mut buffer)
            .map_err(|_| "cannot read model stream")?;
        if size == 0 {
            return Ok(total);
        }
        if total.saturating_add(size) > max_bytes {
            return Err("QVeris model stream exceeds size limit".into());
        }
        target
            .write_all(&buffer[..size])
            .and_then(|_| target.flush())
            .map_err(|_| "cannot write model stream")?;
        total += size;
    }
}

struct HttpRequest {
    method: String,
    path: String,
    headers: std::collections::HashMap<String, String>,
    body: Vec<u8>,
}

fn read_request(stream: &mut TcpStream) -> Result<HttpRequest, String> {
    let mut raw = Vec::new();
    let mut buffer = [0_u8; 4096];
    let header_end = loop {
        let size = stream
            .read(&mut buffer)
            .map_err(|_| "unable to read request")?;
        if size == 0 {
            return Err("incomplete request".into());
        }
        raw.extend_from_slice(&buffer[..size]);
        if raw.len() > MAX_REQUEST_BYTES + 16 * 1024 {
            return Err("request too large".into());
        }
        if let Some(index) = raw.windows(4).position(|part| part == b"\r\n\r\n") {
            break index + 4;
        }
    };
    let header = std::str::from_utf8(&raw[..header_end]).map_err(|_| "invalid request headers")?;
    let mut lines = header.split("\r\n");
    let request_line = lines.next().ok_or("missing request line")?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().ok_or("missing request method")?.to_owned();
    let path = parts.next().ok_or("missing request path")?.to_owned();
    if parts.next() != Some("HTTP/1.1") || parts.next().is_some() {
        return Err("invalid request line".into());
    }
    let mut headers = std::collections::HashMap::new();
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_owned());
        }
    }
    let length = headers
        .get("content-length")
        .map(String::as_str)
        .unwrap_or("0")
        .parse::<usize>()
        .map_err(|_| "invalid content-length")?;
    if length > MAX_REQUEST_BYTES {
        return Err("request too large".into());
    }
    while raw.len() - header_end < length {
        let size = stream
            .read(&mut buffer)
            .map_err(|_| "unable to read request body")?;
        if size == 0 {
            return Err("incomplete request body".into());
        }
        raw.extend_from_slice(&buffer[..size]);
        if raw.len() - header_end > length {
            return Err("invalid request body".into());
        }
    }
    Ok(HttpRequest {
        method,
        path,
        headers,
        body: raw[header_end..].to_vec(),
    })
}

fn write_response(mut stream: impl Write, status: u16, body: Value) -> std::io::Result<()> {
    let body =
        serde_json::to_vec(&body).unwrap_or_else(|_| b"{\"error\":\"internal error\"}".to_vec());
    write!(stream, "HTTP/1.1 {status} \r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len())?;
    stream.write_all(&body)
}

fn write_raw_response(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &[u8],
) -> std::io::Result<()> {
    write!(stream, "HTTP/1.1 {status} \r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len())?;
    stream.write_all(body)
}

fn redact(value: &str) -> String {
    value
        .replace("QVERIS_API_KEY", "credential")
        .chars()
        .take(800)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    fn environment() -> BridgeEnvironment {
        BridgeEnvironment {
            url: "http://127.0.0.1:1/execute".into(),
            capability: "cap_test".into(),
            model_base_url: "http://127.0.0.1:1/model/v1".into(),
            model_capability: "model_test".into(),
            run_id: "run_test".into(),
            product_run_id: "product_test".into(),
        }
    }
    fn request() -> BridgeRequest {
        BridgeRequest {
            bridge_version: BRIDGE_VERSION.into(),
            run_id: "run_test".into(),
            product_run_id: "product_test".into(),
            tool_call_id: "call_test".into(),
            operation: "search".into(),
            input: json!({"query":"weather"}),
        }
    }
    #[test]
    fn rejects_mismatched_run_and_unknown_operation() {
        let env = environment();
        let mut item = request();
        item.run_id = "other".into();
        assert!(validate_bridge_request(&item, &env).is_err());
        item.run_id = env.run_id.clone();
        item.operation = "delete".into();
        assert!(validate_bridge_request(&item, &env).is_err());
    }
    #[test]
    fn accepts_exact_run_identity_and_valid_operation() {
        assert!(validate_bridge_request(&request(), &environment()).is_ok());
        let mut inspect = request();
        inspect.operation = "inspect".into();
        inspect.input = json!({"search_id":"search", "tool_ids":["tool-1", "tool-2"]});
        assert!(validate_bridge_request(&inspect, &environment()).is_ok());

        let mut call = request();
        call.operation = "call".into();
        call.input =
            json!({"search_id":"search", "tool_id":"tool-1", "parameters":{"symbol":"AAPL"}});
        assert!(validate_bridge_request(&call, &environment()).is_ok());
    }
    #[test]
    fn rejects_operation_payload_missing_required_fields() {
        let mut item = request();
        item.operation = "call".into();
        item.input = json!({"tool_id":"tool"});
        assert!(validate_bridge_request(&item, &environment()).is_err());
    }
    #[test]
    fn rejects_policy_fields_and_out_of_bounds_inputs() {
        let env = environment();
        let mut item = request();
        item.input = json!({"query":"quote", "session_id":"caller-controlled"});
        assert!(validate_bridge_request(&item, &env).is_err());

        item.input = json!({"query":"quote", "limit":21});
        assert!(validate_bridge_request(&item, &env).is_err());
        item.input = json!({"query":"x".repeat(MAX_QUERY_BYTES + 1)});
        assert!(validate_bridge_request(&item, &env).is_err());

        item.operation = "inspect".into();
        item.input = json!({"search_id":"search", "tool_ids":["same", "same"]});
        assert!(validate_bridge_request(&item, &env).is_err());
        item.input = json!({"search_id":"search", "tool_ids":["1", "2", "3", "4", "5", "6"]});
        assert!(validate_bridge_request(&item, &env).is_err());

        item.operation = "call".into();
        item.input = json!({"search_id":"search", "tool_id":"tool", "parameters":{"blob":"x".repeat(MAX_PARAMETERS_BYTES)}});
        assert!(validate_bridge_request(&item, &env).is_err());
    }
    #[test]
    fn host_policy_fields_override_caller_values() {
        let input = json!({"session_id":"caller", "view":"verbose", "respond_with":"raw"});
        let body = with_policy_fields(
            &input,
            &[
                ("session_id", json!("product-run")),
                ("view", json!("lean")),
                ("respond_with", json!("full")),
            ],
        );
        assert_eq!(body["session_id"], "product-run");
        assert_eq!(body["view"], "lean");
        assert_eq!(body["respond_with"], "full");
    }
    #[test]
    fn requires_exact_bearer_capability() {
        let mut headers = std::collections::HashMap::new();
        headers.insert("authorization".into(), "Bearer cap_test".into());
        assert!(has_capability(&headers, "cap_test"));
        headers.insert("authorization".into(), "Bearer cap_other".into());
        assert!(!has_capability(&headers, "cap_test"));
    }
    #[test]
    fn model_catalog_normalization_keeps_pi_required_fields() {
        let model = normalize_model(
            &json!({"id":"q-model","capabilities":["chat","reasoning"],"context_window":200000}),
        )
        .unwrap();
        assert_eq!(model["id"], "q-model");
        assert_eq!(model["reasoning"], true);
        assert_eq!(model["contextWindow"], 200000);
    }
    #[test]
    fn model_catalog_normalization_drops_invalid_and_duplicate_ids() {
        let models = normalize_model_catalog(&[
            json!({"id":" model-b ","capabilities":["chat"]}),
            json!({"id":"model-b","capabilities":["chat"]}),
            json!({"id":"model-a","capabilities":["chat"]}),
            json!({"id":"model\ncontrol","capabilities":["chat"]}),
            json!({"id":"x".repeat(config::MAX_MODEL_ID_BYTES + 1),"capabilities":["chat"]}),
            json!({"id":"embedding","capabilities":["embeddings"]}),
        ])
        .unwrap();
        assert_eq!(models.len(), 2);
        assert_eq!(models[0]["id"], "model-a");
        assert_eq!(models[1]["id"], "model-b");
    }
    #[test]
    fn model_catalog_normalization_rejects_too_many_models() {
        let values = (0..=config::MAX_MODEL_CATALOG_ITEMS)
            .map(|index| json!({"id":format!("model-{index}"),"capabilities":["chat"]}))
            .collect::<Vec<_>>();
        assert_eq!(
            normalize_model_catalog(&values).unwrap_err(),
            "QVeris model catalog contains too many chat models"
        );
    }
    #[test]
    fn recognizes_sse_content_types_only() {
        assert!(is_event_stream("text/event-stream"));
        assert!(is_event_stream("Text/Event-Stream; charset=utf-8"));
        assert!(!is_event_stream("application/json"));
        assert!(!is_event_stream("text/event-streaming"));
    }
    #[test]
    fn streams_and_flushes_with_a_hard_size_limit() {
        let payload = b"data: {\"delta\":\"first\"}\n\ndata: [DONE]\n\n";
        let mut output = Vec::new();
        assert_eq!(
            copy_stream_limited(Cursor::new(payload), &mut output, payload.len()).unwrap(),
            payload.len()
        );
        assert_eq!(output, payload);

        let mut limited = Vec::new();
        assert!(
            copy_stream_limited(Cursor::new(payload), &mut limited, payload.len() - 1).is_err()
        );
        assert!(limited.len() < payload.len());
    }
    #[test]
    fn streaming_headers_are_close_delimited_and_disable_sniffing() {
        let mut output = Vec::new();
        write_streaming_response_head(&mut output, 200, "text/event-stream").unwrap();
        let text = String::from_utf8(output).unwrap();
        assert!(text.starts_with("HTTP/1.1 200 "));
        assert!(text.contains("Content-Type: text/event-stream\r\n"));
        assert!(text.contains("Cache-Control: no-cache\r\n"));
        assert!(text.contains("X-Content-Type-Options: nosniff\r\n"));
        assert!(text.contains("Connection: close\r\n\r\n"));
        assert!(!text.contains("Content-Length"));
    }
}
