use crate::{config, credentials::CredentialStore};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    future::Future,
    io::{Read, Write},
    net::{Shutdown, TcpListener, TcpStream},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
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
const UPSTREAM_RETRY_ATTEMPTS: usize = 2;
const UPSTREAM_RETRY_MAX_DELAY: Duration = Duration::from_secs(8);
const MAX_QUERY_BYTES: usize = 4 * 1024;
const MAX_IDENTIFIER_BYTES: usize = 256;
const MAX_TOOL_IDS: usize = 5;
const MAX_PARAMETERS_BYTES: usize = 256 * 1024;
const MAX_CONCURRENT_CONNECTIONS: usize = 16;
const EXECUTOR_STOP_TIMEOUT: Duration = Duration::from_secs(1);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEvent {
    pub operation: String,
    pub run_id: String,
    pub tool_call_id: String,
    pub outcome: String,
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parameters: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_unit: Option<String>,
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
    connections: Arc<ConnectionRegistry>,
}

struct ConnectionSlot {
    active: Arc<AtomicUsize>,
}

#[derive(Default)]
struct ConnectionRegistryState {
    stopped: bool,
    next_id: usize,
    sockets: HashMap<usize, TcpStream>,
}

#[derive(Default)]
struct ConnectionRegistry {
    inner: Mutex<ConnectionRegistryState>,
}

struct ConnectionRegistration {
    id: usize,
    registry: Arc<ConnectionRegistry>,
}

impl ConnectionRegistry {
    fn register(self: &Arc<Self>, stream: &TcpStream) -> Result<ConnectionRegistration, String> {
        let socket = stream
            .try_clone()
            .map_err(|_| "cannot track executor connection")?;
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "executor connection registry poisoned")?;
        if inner.stopped {
            return Err("executor stopped".into());
        }
        let id = inner.next_id;
        inner.next_id = inner.next_id.wrapping_add(1);
        inner.sockets.insert(id, socket);
        Ok(ConnectionRegistration {
            id,
            registry: self.clone(),
        })
    }

    fn shutdown_all(&self) {
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        inner.stopped = true;
        // Remove registrations while shutting down the cloned sockets. The
        // handler threads own their original streams and will still unwind
        // independently, but keeping stale registry entries here makes a
        // normal stop appear stuck on Windows where shutdown/read wakeups can
        // be scheduled after the close is observed by the peer.
        let sockets = std::mem::take(&mut inner.sockets);
        for socket in sockets.values() {
            let _ = socket.shutdown(Shutdown::Both);
        }
    }

    fn active_count(&self) -> usize {
        self.inner
            .lock()
            .map(|inner| inner.sockets.len())
            .unwrap_or_default()
    }

    fn wait_until_empty(&self, timeout: Duration) {
        let deadline = std::time::Instant::now() + timeout;
        while self.active_count() != 0 && std::time::Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
    }
}

impl Drop for ConnectionRegistration {
    fn drop(&mut self) {
        if let Ok(mut inner) = self.registry.inner.lock() {
            inner.sockets.remove(&self.id);
        }
    }
}

impl Drop for ConnectionSlot {
    fn drop(&mut self) {
        let previous = self.active.fetch_sub(1, Ordering::AcqRel);
        debug_assert!(previous > 0, "executor connection counter underflow");
    }
}

fn try_acquire_connection_slot(active: &Arc<AtomicUsize>) -> Option<ConnectionSlot> {
    active
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| {
            (count < MAX_CONCURRENT_CONNECTIONS).then_some(count + 1)
        })
        .ok()?;
    Some(ConnectionSlot {
        active: active.clone(),
    })
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
        let active_connections = Arc::new(AtomicUsize::new(0));
        let connections = Arc::new(ConnectionRegistry::default());
        let worker_connections = connections.clone();
        thread::spawn(move || {
            while !worker_shutdown.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((stream, peer)) if peer.ip().is_loopback() => {
                        // The listener is non-blocking so the accept loop can observe
                        // shutdown. Accepted sockets can inherit that mode on some
                        // platforms (notably macOS), while request handlers require
                        // bounded blocking reads and writes.
                        if stream.set_nonblocking(false).is_err() {
                            let _ = stream.shutdown(Shutdown::Both);
                            continue;
                        }
                        let Some(slot) = try_acquire_connection_slot(&active_connections) else {
                            let _ = write_response(
                                stream,
                                503,
                                json!({"error":"executor connection limit reached"}),
                            );
                            continue;
                        };
                        let registration = match worker_connections.register(&stream) {
                            Ok(registration) => registration,
                            Err(_) => {
                                let _ = stream.shutdown(Shutdown::Both);
                                continue;
                            }
                        };
                        let store = credential_store.clone();
                        let env = worker_environment.clone();
                        let audit = audit.clone();
                        let base = base_url.clone();
                        let model_base = model_gateway_url.clone();
                        let connection_shutdown = worker_shutdown.clone();
                        thread::spawn(move || {
                            let _slot = slot;
                            let _registration = registration;
                            handle_connection(
                                stream,
                                store,
                                env,
                                base,
                                model_base,
                                audit,
                                connection_shutdown,
                            )
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
        Ok((
            Self {
                address,
                shutdown,
                connections,
            },
            environment,
        ))
    }

    pub fn stop(&self) {
        self.shutdown.store(true, Ordering::Release);
        self.connections.shutdown_all();
        let _ = TcpStream::connect_timeout(&self.address, Duration::from_millis(100))
            .and_then(|stream| stream.shutdown(Shutdown::Both));
        self.connections.wait_until_empty(EXECUTOR_STOP_TIMEOUT);
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
    shutdown: Arc<AtomicBool>,
) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
    if ensure_executor_running(&shutdown).is_err() {
        return;
    }
    let request = match read_request(&mut stream) {
        Ok(request) => request,
        Err(error) => {
            let _ = write_response(stream, 400, json!({"error": redact(&error)}));
            return;
        }
    };
    if ensure_executor_running(&shutdown).is_err() {
        return;
    }
    if request.path.starts_with("/model/v1/") {
        if !has_capability(&request.headers, &environment.model_capability) {
            let _ = write_response(stream, 401, json!({"error":"unauthorized"}));
            return;
        }
        if let Err(error) = block_on_upstream(proxy_model_request(
            &mut stream,
            &store,
            &model_gateway_url,
            request,
            &shutdown,
        )) {
            if ensure_executor_running(&shutdown).is_ok() {
                let _ = write_response(&mut stream, 502, json!({"error": redact(&error)}));
            }
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
    let result = block_on_upstream(execute_official_api(&store, &base_url, &bridge, &shutdown));
    if ensure_executor_running(&shutdown).is_err() {
        return;
    }
    match result {
        Ok(result) => {
            audit(AuditEvent {
                operation: operation.clone(),
                run_id: environment.run_id,
                tool_call_id,
                outcome: "success".into(),
                detail: None,
                endpoint: Some(format!("{base_url}/{}", operation)),
                parameters: Some(bridge.input.clone()),
                response: Some(audit_response(&result)),
                cost: extract_cost(&result),
                cost_unit: extract_cost(&result).map(|_| "credits".into()),
            });
            let _ = write_response(stream, 200, json!({"result":result}));
        }
        Err(error) => {
            let safe = redact(&error);
            audit(AuditEvent {
                operation: operation.clone(),
                run_id: environment.run_id,
                tool_call_id,
                outcome: "error".into(),
                detail: Some(safe.clone()),
                endpoint: Some(format!("{base_url}/{}", operation)),
                parameters: Some(bridge.input.clone()),
                response: None,
                cost: None,
                cost_unit: None,
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

fn ensure_executor_running(shutdown: &AtomicBool) -> Result<(), String> {
    if shutdown.load(Ordering::Acquire) {
        Err("executor stopped".into())
    } else {
        Ok(())
    }
}

async fn wait_for_executor_stop(shutdown: &AtomicBool) {
    while !shutdown.load(Ordering::Acquire) {
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

fn is_retryable_upstream_status(status: reqwest::StatusCode) -> bool {
    matches!(status.as_u16(), 408 | 425 | 429 | 500 | 502 | 503 | 504)
}

fn retry_after(response: &reqwest::Response) -> Option<Duration> {
    let seconds = response
        .headers()
        .get(reqwest::header::RETRY_AFTER)?
        .to_str()
        .ok()?
        .trim()
        .parse::<f64>()
        .ok()?;
    if !seconds.is_finite() || seconds < 0.0 {
        return None;
    }
    Some(Duration::from_secs_f64(seconds.min(30.0)))
}

fn retry_delay(attempt: usize, server_delay: Option<Duration>) -> Duration {
    let exponential =
        Duration::from_millis(500_u64.saturating_mul(2_u64.saturating_pow(attempt.min(4) as u32)));
    exponential
        .max(server_delay.unwrap_or_default())
        .min(UPSTREAM_RETRY_MAX_DELAY)
}

async fn wait_for_retry(shutdown: &AtomicBool, delay: Duration) -> Result<(), String> {
    tokio::select! {
        biased;
        _ = wait_for_executor_stop(shutdown) => Err("executor stopped".into()),
        _ = tokio::time::sleep(delay) => Ok(()),
    }
}

fn block_on_upstream<T>(future: impl Future<Output = Result<T, String>>) -> Result<T, String> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| "cannot initialize executor network runtime")?
        .block_on(future)
}

async fn send_cancellable(
    builder: reqwest::RequestBuilder,
    shutdown: &AtomicBool,
    error: &'static str,
) -> Result<reqwest::Response, String> {
    tokio::select! {
        biased;
        _ = wait_for_executor_stop(shutdown) => Err("executor stopped".into()),
        response = builder.send() => response.map_err(|_| error.into()),
    }
}

async fn read_response_limited(
    mut response: reqwest::Response,
    max_bytes: usize,
    shutdown: &AtomicBool,
    read_error: &'static str,
    size_error: &'static str,
) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    loop {
        let chunk = tokio::select! {
            biased;
            _ = wait_for_executor_stop(shutdown) => return Err("executor stopped".into()),
            chunk = response.chunk() => chunk.map_err(|_| read_error)?,
        };
        let Some(chunk) = chunk else {
            return Ok(bytes);
        };
        if bytes.len().saturating_add(chunk.len()) > max_bytes {
            return Err(size_error.into());
        }
        bytes.extend_from_slice(&chunk);
    }
}

async fn execute_official_api(
    store: &Arc<dyn CredentialStore>,
    base_url: &str,
    request: &BridgeRequest,
    shutdown: &AtomicBool,
) -> Result<Value, String> {
    ensure_executor_running(shutdown)?;
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
    let client = reqwest::Client::builder()
        .timeout(UPSTREAM_TIMEOUT)
        .build()
        .map_err(|_| "cannot initialize QVeris client")?;
    for attempt in 0..=UPSTREAM_RETRY_ATTEMPTS {
        ensure_executor_running(shutdown)?;
        let response = match send_cancellable(
            client
                .post(endpoint.clone())
                .bearer_auth(key.clone())
                .json(&body),
            shutdown,
            "QVeris request failed or timed out",
        )
        .await
        {
            Ok(response) => response,
            Err(error) if error != "executor stopped" && attempt < UPSTREAM_RETRY_ATTEMPTS => {
                wait_for_retry(shutdown, retry_delay(attempt, None)).await?;
                continue;
            }
            Err(error) => return Err(error),
        };
        ensure_executor_running(shutdown)?;
        let status = response.status();
        let server_delay = retry_after(&response);
        if !status.is_success()
            && is_retryable_upstream_status(status)
            && attempt < UPSTREAM_RETRY_ATTEMPTS
        {
            drop(response);
            wait_for_retry(shutdown, retry_delay(attempt, server_delay)).await?;
            continue;
        }
        let bytes = read_response_limited(
            response,
            MAX_RESPONSE_BYTES,
            shutdown,
            "cannot read QVeris response",
            "QVeris response exceeds size limit",
        )
        .await?;
        if !status.is_success() {
            return Err(format!("QVeris API returned HTTP {}", status.as_u16()));
        }
        return serde_json::from_slice(&bytes)
            .map_err(|_| "QVeris API returned invalid JSON".into());
    }
    unreachable!("upstream retry loop always returns")
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

async fn proxy_model_request(
    stream: &mut TcpStream,
    store: &Arc<dyn CredentialStore>,
    base_url: &str,
    request: HttpRequest,
    shutdown: &AtomicBool,
) -> Result<(), String> {
    ensure_executor_running(shutdown)?;
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
    let client = reqwest::Client::builder()
        .timeout(MODEL_TIMEOUT)
        .build()
        .map_err(|_| "cannot initialize model proxy")?;
    let builder = if request.method == "GET" {
        client.get(endpoint)
    } else {
        client.post(endpoint).body(request.body)
    };
    let response = send_cancellable(
        builder
            .bearer_auth(key)
            .header(
                "Accept",
                request
                    .headers
                    .get("accept")
                    .map(String::as_str)
                    .unwrap_or("application/json"),
            )
            .header("Content-Type", "application/json"),
        shutdown,
        "QVeris model request failed or timed out",
    )
    .await?;
    let status = response.status();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/json")
        .to_owned();
    if status.is_success() && is_event_stream(&content_type) {
        ensure_executor_running(shutdown)?;
        write_streaming_response_head(stream, status.as_u16(), &content_type)
            .map_err(|_| "cannot write model stream headers".to_string())?;
        // Headers are already visible to Pi. On an upstream/read/size failure, close the
        // response instead of appending a second HTTP response to the SSE byte stream.
        let _ = copy_response_stream_limited(response, stream, MAX_MODEL_RESPONSE_BYTES, shutdown)
            .await;
        return Ok(());
    }
    let bytes = read_response_limited(
        response,
        MAX_MODEL_RESPONSE_BYTES,
        shutdown,
        "cannot read model response",
        "QVeris model response exceeds size limit",
    )
    .await?;
    ensure_executor_running(shutdown)?;
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

async fn copy_response_stream_limited(
    mut source: reqwest::Response,
    target: &mut impl Write,
    max_bytes: usize,
    shutdown: &AtomicBool,
) -> Result<usize, String> {
    let mut total = 0;
    loop {
        let chunk = tokio::select! {
            biased;
            _ = wait_for_executor_stop(shutdown) => return Err("executor stopped".into()),
            chunk = source.chunk() => chunk.map_err(|_| "cannot read model stream")?,
        };
        let Some(chunk) = chunk else {
            return Ok(total);
        };
        ensure_executor_running(shutdown)?;
        write_stream_chunk_limited(target, &chunk, &mut total, max_bytes)?;
    }
}

fn write_stream_chunk_limited(
    target: &mut impl Write,
    chunk: &[u8],
    total: &mut usize,
    max_bytes: usize,
) -> Result<(), String> {
    if total.saturating_add(chunk.len()) > max_bytes {
        return Err("QVeris model stream exceeds size limit".into());
    }
    target
        .write_all(chunk)
        .and_then(|_| target.flush())
        .map_err(|_| "cannot write model stream")?;
    *total += chunk.len();
    Ok(())
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

fn extract_cost(value: &Value) -> Option<f64> {
    fn candidate(value: &Value) -> Option<f64> {
        match value {
            Value::Number(number) => number
                .as_f64()
                .filter(|value| value.is_finite() && *value >= 0.0),
            Value::String(text) => text
                .parse::<f64>()
                .ok()
                .filter(|value| value.is_finite() && *value >= 0.0),
            Value::Object(map) => ["amount", "value", "credits", "chargedCredits"]
                .iter()
                .find_map(|key| map.get(*key).and_then(candidate)),
            Value::Array(_) | Value::Null | Value::Bool(_) => None,
        }
    }
    fn walk(value: &Value, depth: usize) -> Option<f64> {
        if depth > 4 {
            return None;
        }
        let map = value.as_object()?;
        for key in [
            "qveris_cost",
            "qverisCost",
            "cost",
            "charged_credits",
            "credits_used",
            "fee",
        ] {
            if let Some(found) = map.get(key).and_then(candidate) {
                return Some(found);
            }
        }
        ["usage", "billing", "meta", "metadata", "result", "data"]
            .iter()
            .find_map(|key| map.get(*key).and_then(|item| walk(item, depth + 1)))
    }
    walk(value, 0)
}

fn audit_response(value: &Value) -> Value {
    let encoded = serde_json::to_vec(value).unwrap_or_default();
    if encoded.len() <= 4_096 {
        return value.clone();
    }
    let keys = value
        .as_object()
        .map(|map| map.keys().take(40).cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    json!({"truncated": true, "bytes": encoded.len(), "keys": keys})
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credentials::InMemoryCredentialStore;
    use std::sync::mpsc;
    use std::time::Instant;
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
    fn socket_is_closed(stream: &mut TcpStream) -> bool {
        match stream.read(&mut [0_u8; 1]) {
            Ok(0) => true,
            Ok(_) => false,
            Err(error) => !matches!(
                error.kind(),
                std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
            ),
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
    fn retries_only_transient_upstream_statuses_with_a_bounded_delay() {
        assert!(is_retryable_upstream_status(
            reqwest::StatusCode::SERVICE_UNAVAILABLE
        ));
        assert!(is_retryable_upstream_status(
            reqwest::StatusCode::TOO_MANY_REQUESTS
        ));
        assert!(!is_retryable_upstream_status(
            reqwest::StatusCode::UNAUTHORIZED
        ));
        assert_eq!(retry_delay(0, None), Duration::from_millis(500));
        assert_eq!(retry_delay(1, None), Duration::from_secs(1));
        assert_eq!(retry_delay(99, None), UPSTREAM_RETRY_MAX_DELAY);
        assert_eq!(
            retry_delay(0, Some(Duration::from_secs(30))),
            UPSTREAM_RETRY_MAX_DELAY
        );
    }
    #[test]
    fn retries_a_transient_tool_response_before_returning_success() {
        let upstream = TcpListener::bind("127.0.0.1:0").unwrap();
        let upstream_address = upstream.local_addr().unwrap();
        let attempts = Arc::new(AtomicUsize::new(0));
        let captured_attempts = attempts.clone();
        let server = thread::spawn(move || {
            for attempt in 0..2 {
                let (mut stream, _) = upstream.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                read_request(&mut stream).unwrap();
                captured_attempts.fetch_add(1, Ordering::AcqRel);
                if attempt == 0 {
                    write!(
                        stream,
                        "HTTP/1.1 503 Service Unavailable\r\nRetry-After: 0\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    )
                    .unwrap();
                } else {
                    let body = br#"{"result":{"ok":true}}"#;
                    write!(
                        stream,
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    )
                    .unwrap();
                    stream.write_all(body).unwrap();
                }
            }
        });
        let store = Arc::new(InMemoryCredentialStore::new());
        store.write_qveris_key("test-key").unwrap();
        let store: Arc<dyn CredentialStore> = store;
        let shutdown = AtomicBool::new(false);
        let result = block_on_upstream(execute_official_api(
            &store,
            &format!("http://{upstream_address}"),
            &request(),
            &shutdown,
        ))
        .unwrap();
        server.join().unwrap();
        assert_eq!(result["result"]["ok"], true);
        assert_eq!(attempts.load(Ordering::Acquire), 2);
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
    fn connection_slots_enforce_and_release_the_hard_limit() {
        let active = Arc::new(AtomicUsize::new(0));
        let mut slots = (0..MAX_CONCURRENT_CONNECTIONS)
            .map(|_| try_acquire_connection_slot(&active).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(active.load(Ordering::Acquire), MAX_CONCURRENT_CONNECTIONS);
        assert!(try_acquire_connection_slot(&active).is_none());

        drop(slots.pop().expect("a connection slot should be present"));
        assert_eq!(
            active.load(Ordering::Acquire),
            MAX_CONCURRENT_CONNECTIONS - 1
        );
        let replacement = try_acquire_connection_slot(&active).unwrap();
        assert_eq!(active.load(Ordering::Acquire), MAX_CONCURRENT_CONNECTIONS);

        drop(replacement);
        drop(slots);
        assert_eq!(active.load(Ordering::Acquire), 0);
    }

    #[test]
    fn stop_closes_connections_blocked_on_incomplete_requests() {
        let store = Arc::new(InMemoryCredentialStore::new());
        let (executor, _) = RunExecutor::start(
            store,
            "http://127.0.0.1:1".into(),
            "http://127.0.0.1:1/v1".into(),
            Arc::new(|_| {}),
        )
        .unwrap();
        let mut client = TcpStream::connect(executor.address).unwrap();

        // Synchronize with the accept loop before starting the incomplete request. On
        // loaded CI hosts the executor thread may not be scheduled within one second.
        let deadline = Instant::now() + Duration::from_secs(3);
        while executor.connections.active_count() != 1 && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(executor.connections.active_count(), 1);

        client
            .write_all(b"POST /execute HTTP/1.1\r\nContent-Length: 100\r\n\r\npartial")
            .unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(1)))
            .unwrap();

        executor.stop();
        assert!(socket_is_closed(&mut client));

        let deadline = Instant::now() + Duration::from_secs(1);
        while executor.connections.active_count() != 0 && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(executor.connections.active_count(), 0);
    }

    fn assert_stop_cancels_upstream(model_request: bool) {
        let upstream = TcpListener::bind("127.0.0.1:0").unwrap();
        let upstream_address = upstream.local_addr().unwrap();
        let (request_seen_tx, request_seen_rx) = mpsc::channel();
        let (connection_closed_tx, connection_closed_rx) = mpsc::channel();
        let upstream_thread = thread::spawn(move || {
            let (mut stream, _) = upstream.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            read_request(&mut stream).unwrap();
            request_seen_tx.send(()).unwrap();
            connection_closed_tx
                .send(socket_is_closed(&mut stream))
                .unwrap();
        });

        let store = Arc::new(InMemoryCredentialStore::new());
        store.write_qveris_key("test-key").unwrap();
        let base_url = format!("http://{upstream_address}");
        let audit_events = Arc::new(Mutex::new(Vec::<AuditEvent>::new()));
        let captured_events = audit_events.clone();
        let (executor, environment) = RunExecutor::start(
            store,
            base_url.clone(),
            base_url,
            Arc::new(move |event| captured_events.lock().unwrap().push(event)),
        )
        .unwrap();
        let mut client = TcpStream::connect(executor.address).unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(1)))
            .unwrap();
        let (path, capability, body) = if model_request {
            (
                "/model/v1/chat/completions",
                environment.model_capability.as_str(),
                serde_json::to_vec(&json!({"model":"model-a","messages":[]})).unwrap(),
            )
        } else {
            (
                "/execute",
                environment.capability.as_str(),
                serde_json::to_vec(&json!({
                    "bridge_version": BRIDGE_VERSION,
                    "run_id": environment.run_id,
                    "product_run_id": environment.product_run_id,
                    "tool_call_id": "call-test",
                    "operation": "search",
                    "input": {"query":"AAPL"},
                }))
                .unwrap(),
            )
        };
        write!(
            client,
            "POST {path} HTTP/1.1\r\nAuthorization: Bearer {capability}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
            body.len()
        )
        .unwrap();
        client.write_all(&body).unwrap();

        request_seen_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("upstream should receive the request");
        executor.stop();
        assert!(socket_is_closed(&mut client));
        assert!(connection_closed_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("cancelled request should close its upstream connection"));
        upstream_thread.join().unwrap();
        assert!(audit_events.lock().unwrap().is_empty());
    }

    #[test]
    fn stop_cancels_an_inflight_tool_request() {
        assert_stop_cancels_upstream(false);
    }

    #[test]
    fn stop_cancels_an_inflight_model_request() {
        assert_stop_cancels_upstream(true);
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
    fn extracts_explicit_cost_without_business_amounts() {
        assert_eq!(
            extract_cost(&json!({"result": {"cost": {"credits": "0.2"}}})),
            Some(0.2)
        );
        assert_eq!(
            extract_cost(&json!({"data": {"amount": 99.0, "price": 12.3}})),
            None
        );
    }
    #[test]
    fn streams_and_flushes_with_a_hard_size_limit() {
        let payload = b"data: {\"delta\":\"first\"}\n\ndata: [DONE]\n\n";
        let mut output = Vec::new();
        let mut total = 0;
        write_stream_chunk_limited(&mut output, payload, &mut total, payload.len()).unwrap();
        assert_eq!(total, payload.len());
        assert_eq!(output, payload);

        let mut limited = Vec::new();
        let mut limited_total = 0;
        assert!(write_stream_chunk_limited(
            &mut limited,
            payload,
            &mut limited_total,
            payload.len() - 1,
        )
        .is_err());
        assert!(limited.is_empty());
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
