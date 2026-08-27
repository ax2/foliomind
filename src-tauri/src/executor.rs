use crate::credentials::CredentialStore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    net::{Shutdown, TcpListener, TcpStream},
    sync::{atomic::{AtomicBool, Ordering}, Arc},
    thread,
    time::Duration,
};
use url::Url;
use uuid::Uuid;

pub const BRIDGE_VERSION: &str = "foliomind-bridge.v1";
const MAX_REQUEST_BYTES: usize = 512 * 1024;
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const UPSTREAM_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEvent { pub operation: String, pub run_id: String, pub tool_call_id: String, pub outcome: String, pub detail: Option<String> }

#[derive(Clone)]
pub struct BridgeEnvironment { pub url: String, pub capability: String, pub run_id: String, pub product_run_id: String }

pub struct RunExecutor { address: std::net::SocketAddr, shutdown: Arc<AtomicBool> }

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
        audit: Arc<dyn Fn(AuditEvent) + Send + Sync>,
    ) -> Result<(Self, BridgeEnvironment), String> {
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|error| format!("cannot bind loopback executor: {error}"))?;
        listener.set_nonblocking(true).map_err(|error| format!("cannot configure loopback executor: {error}"))?;
        let address = listener.local_addr().map_err(|error| format!("cannot inspect loopback executor: {error}"))?;
        let shutdown = Arc::new(AtomicBool::new(false));
        let environment = BridgeEnvironment {
            url: format!("http://127.0.0.1:{}/execute", address.port()),
            capability: format!("cap_{}", Uuid::new_v4()),
            run_id: format!("run_{}", Uuid::new_v4()),
            product_run_id: format!("product_{}", Uuid::new_v4()),
        };
        let worker_environment = environment.clone();
        let worker_shutdown = shutdown.clone();
        thread::spawn(move || {
            while !worker_shutdown.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((stream, peer)) if peer.ip().is_loopback() => {
                        let store = credential_store.clone(); let env = worker_environment.clone(); let audit = audit.clone(); let base = base_url.clone();
                        thread::spawn(move || handle_connection(stream, store, env, base, audit));
                    }
                    Ok((stream, _)) => { let _ = write_response(stream, 403, json!({"error":"loopback only"})); }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => thread::sleep(Duration::from_millis(25)),
                    Err(_) => break,
                }
            }
        });
        Ok((Self { address, shutdown }, environment))
    }

    pub fn stop(&self) {
        self.shutdown.store(true, Ordering::Relaxed);
        let _ = TcpStream::connect_timeout(&self.address, Duration::from_millis(100)).and_then(|stream| stream.shutdown(Shutdown::Both));
    }
}

fn handle_connection(mut stream: TcpStream, store: Arc<dyn CredentialStore>, environment: BridgeEnvironment, base_url: String, audit: Arc<dyn Fn(AuditEvent) + Send + Sync>) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let request = match read_request(&mut stream) { Ok(request) => request, Err(error) => { let _ = write_response(stream, 400, json!({"error": redact(&error)})); return; } };
    if !has_capability(&request.0, &environment.capability) { let _ = write_response(stream, 401, json!({"error":"unauthorized"})); return; }
    let bridge: BridgeRequest = match serde_json::from_slice(&request.1) { Ok(value) => value, Err(_) => { let _ = write_response(stream, 400, json!({"error":"invalid JSON"})); return; } };
    if let Err(error) = validate_bridge_request(&bridge, &environment) { let _ = write_response(stream, 400, json!({"error":error})); return; }
    let tool_call_id = bridge.tool_call_id.clone(); let operation = bridge.operation.clone();
    let result = execute_official_api(&store, &base_url, &bridge);
    match result {
        Ok(result) => { audit(AuditEvent { operation, run_id: environment.run_id, tool_call_id, outcome: "success".into(), detail: None }); let _ = write_response(stream, 200, json!({"result":result})); }
        Err(error) => { let safe = redact(&error); audit(AuditEvent { operation, run_id: environment.run_id, tool_call_id, outcome: "error".into(), detail: Some(safe.clone()) }); let _ = write_response(stream, 502, json!({"error":safe})); }
    }
}

fn validate_bridge_request(request: &BridgeRequest, environment: &BridgeEnvironment) -> Result<(), String> {
    if request.bridge_version != BRIDGE_VERSION { return Err("unsupported bridge_version".into()); }
    if request.run_id != environment.run_id || request.product_run_id != environment.product_run_id { return Err("run identity mismatch".into()); }
    if request.tool_call_id.trim().is_empty() || request.tool_call_id.len() > 256 { return Err("invalid tool_call_id".into()); }
    if !matches!(request.operation.as_str(), "search" | "inspect" | "call") { return Err("unsupported operation".into()); }
    if !request.input.is_object() { return Err("operation input must be an object".into()); }
    let text = |key: &str| request.input.get(key).and_then(Value::as_str).is_some_and(|value| !value.trim().is_empty());
    match request.operation.as_str() {
        "search" if !text("query") => return Err("search requires query".into()),
        "inspect" if !text("search_id") || request.input.get("tool_ids").and_then(Value::as_array).map(|items| items.is_empty()).unwrap_or(true) => return Err("inspect requires search_id and tool_ids".into()),
        "call" if !text("search_id") || !text("tool_id") || !request.input.get("parameters").is_some_and(Value::is_object) => return Err("call requires search_id, tool_id and parameters".into()),
        _ => {}
    }
    Ok(())
}

fn has_capability(headers: &std::collections::HashMap<String, String>, capability: &str) -> bool {
    headers.get("authorization").is_some_and(|value| value == &format!("Bearer {capability}"))
}

fn execute_official_api(store: &Arc<dyn CredentialStore>, base_url: &str, request: &BridgeRequest) -> Result<Value, String> {
    let key = store.read_qveris_key()?.filter(|key| !key.trim().is_empty()).ok_or("QVeris credential is not configured")?;
    let mut endpoint = Url::parse(base_url.trim_end_matches('/')).map_err(|_| "invalid QVeris API base URL")?;
    let path = match request.operation.as_str() { "search" => "search", "inspect" => "tools/by-ids", "call" => "tools/execute", _ => unreachable!() };
    endpoint.set_path(&format!("{}/{}", endpoint.path().trim_end_matches('/'), path));
    if request.operation == "call" {
        let tool_id = request.input.get("tool_id").and_then(Value::as_str).filter(|value| !value.is_empty()).ok_or("call requires tool_id")?;
        endpoint.query_pairs_mut().append_pair("tool_id", tool_id);
    }
    let body = match request.operation.as_str() {
        "search" => request.input.clone(),
        "inspect" => request.input.clone(),
        "call" => {
            let mut body = request.input.clone(); body.as_object_mut().expect("validated object").remove("tool_id"); body
        }
        _ => unreachable!(),
    };
    let client = reqwest::blocking::Client::builder().timeout(UPSTREAM_TIMEOUT).build().map_err(|_| "cannot initialize QVeris client")?;
    let response = client.post(endpoint).bearer_auth(key).json(&body).send().map_err(|_| "QVeris request failed or timed out")?;
    let status = response.status();
    let mut limited = response.take((MAX_RESPONSE_BYTES + 1) as u64);
    let mut bytes = Vec::new(); limited.read_to_end(&mut bytes).map_err(|_| "cannot read QVeris response")?;
    if bytes.len() > MAX_RESPONSE_BYTES { return Err("QVeris response exceeds size limit".into()); }
    if !status.is_success() { return Err(format!("QVeris API returned HTTP {}", status.as_u16())); }
    serde_json::from_slice(&bytes).map_err(|_| "QVeris API returned invalid JSON".into())
}

fn read_request(stream: &mut TcpStream) -> Result<(std::collections::HashMap<String, String>, Vec<u8>), String> {
    let mut raw = Vec::new(); let mut buffer = [0_u8; 4096];
    let header_end = loop { let size = stream.read(&mut buffer).map_err(|_| "unable to read request")?; if size == 0 { return Err("incomplete request".into()); } raw.extend_from_slice(&buffer[..size]); if raw.len() > MAX_REQUEST_BYTES + 16 * 1024 { return Err("request too large".into()); } if let Some(index) = raw.windows(4).position(|part| part == b"\r\n\r\n") { break index + 4; } };
    let header = std::str::from_utf8(&raw[..header_end]).map_err(|_| "invalid request headers")?;
    let mut lines = header.split("\r\n"); let request_line = lines.next().ok_or("missing request line")?;
    if request_line != "POST /execute HTTP/1.1" { return Err("only POST /execute is accepted".into()); }
    let mut headers = std::collections::HashMap::new();
    for line in lines { if let Some((name, value)) = line.split_once(':') { headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_owned()); } }
    let length = headers.get("content-length").ok_or("content-length is required")?.parse::<usize>().map_err(|_| "invalid content-length")?;
    if length > MAX_REQUEST_BYTES { return Err("request too large".into()); }
    while raw.len() - header_end < length { let size = stream.read(&mut buffer).map_err(|_| "unable to read request body")?; if size == 0 { return Err("incomplete request body".into()); } raw.extend_from_slice(&buffer[..size]); if raw.len() - header_end > length { return Err("invalid request body".into()); } }
    Ok((headers, raw[header_end..].to_vec()))
}

fn write_response(mut stream: TcpStream, status: u16, body: Value) -> std::io::Result<()> { let body = serde_json::to_vec(&body).unwrap_or_else(|_| b"{\"error\":\"internal error\"}".to_vec()); write!(stream, "HTTP/1.1 {status} \r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len())?; stream.write_all(&body) }

fn redact(value: &str) -> String { value.replace("QVERIS_API_KEY", "credential").chars().take(800).collect() }

#[cfg(test)]
mod tests {
    use super::*;
    fn environment() -> BridgeEnvironment { BridgeEnvironment { url: "http://127.0.0.1:1/execute".into(), capability: "cap_test".into(), run_id: "run_test".into(), product_run_id: "product_test".into() } }
    fn request() -> BridgeRequest { BridgeRequest { bridge_version: BRIDGE_VERSION.into(), run_id: "run_test".into(), product_run_id: "product_test".into(), tool_call_id: "call_test".into(), operation: "search".into(), input: json!({"query":"weather"}) } }
    #[test] fn rejects_mismatched_run_and_unknown_operation() { let env = environment(); let mut item = request(); item.run_id = "other".into(); assert!(validate_bridge_request(&item, &env).is_err()); item.run_id = env.run_id.clone(); item.operation = "delete".into(); assert!(validate_bridge_request(&item, &env).is_err()); }
    #[test] fn accepts_exact_run_identity_and_valid_operation() { assert!(validate_bridge_request(&request(), &environment()).is_ok()); }
    #[test] fn rejects_operation_payload_missing_required_fields() { let mut item = request(); item.operation = "call".into(); item.input = json!({"tool_id":"tool"}); assert!(validate_bridge_request(&item, &environment()).is_err()); }
    #[test] fn requires_exact_bearer_capability() { let mut headers = std::collections::HashMap::new(); headers.insert("authorization".into(), "Bearer cap_test".into()); assert!(has_capability(&headers, "cap_test")); headers.insert("authorization".into(), "Bearer cap_other".into()); assert!(!has_capability(&headers, "cap_test")); }
}
