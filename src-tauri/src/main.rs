//! Local-only Pi RPC host. The only listener is a run-scoped loopback executor.

mod credentials;
mod executor;

use credentials::{CredentialStore, OsCredentialStore};
use executor::{AuditEvent, BridgeEnvironment, RunExecutor};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{atomic::{AtomicU64, Ordering}, mpsc, Arc, Mutex},
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, State};

const EVENT_NAME: &str = "pi-runtime://event";
const MAX_JSONL_BYTES: usize = 1024 * 1024;
const DEFAULT_TIMEOUT_MS: u64 = 30_000;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct RuntimeStatus {
    state: RuntimeState,
    pid: Option<u32>,
    detail: Option<String>,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum RuntimeState { Stopped, Starting, Running, Stopping, Crashed }

impl Default for RuntimeStatus {
    fn default() -> Self { Self { state: RuntimeState::Stopped, pid: None, detail: None } }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeEvent { kind: String, status: RuntimeStatus, frame: Option<Value> }

struct Inner {
    child: Option<Arc<Mutex<Child>>>,
    writer: Option<mpsc::Sender<Value>>,
    pending: HashMap<String, mpsc::Sender<Result<Value, String>>>,
    status: RuntimeStatus,
    executor: Option<RunExecutor>,
}

#[derive(Clone)]
struct PiHost { inner: Arc<Mutex<Inner>>, next_id: Arc<AtomicU64>, credentials: Arc<dyn CredentialStore> }

impl Default for PiHost {
    fn default() -> Self {
        Self { inner: Arc::new(Mutex::new(Inner { child: None, writer: None, pending: HashMap::new(), status: RuntimeStatus::default(), executor: None })), next_id: Arc::new(AtomicU64::new(1)), credentials: Arc::new(OsCredentialStore) }
    }
}

impl PiHost {
    fn status(&self) -> RuntimeStatus { self.inner.lock().expect("host lock poisoned").status.clone() }

    fn publish(&self, app: &AppHandle, kind: &str, frame: Option<Value>) {
        let _ = app.emit(EVENT_NAME, RuntimeEvent { kind: kind.into(), status: self.status(), frame });
    }

    fn start(&self, app: AppHandle) -> Result<RuntimeStatus, String> {
        {
            let inner = self.inner.lock().map_err(|_| "host lock poisoned")?;
            if !matches!(inner.status.state, RuntimeState::Stopped | RuntimeState::Crashed) { return Err("Pi runtime is already active".into()); }
        }
        let binary = resolve_pi_binary(&app);
        let extension = resolve_bridge_extension(&app)?;
        self.set_status(&app, RuntimeState::Starting, None, None, "status");
        let audit_app = app.clone();
        let audit = Arc::new(move |event: AuditEvent| { let _ = audit_app.emit(EVENT_NAME, serde_json::json!({ "kind": "qveris_audit", "audit": event })); });
        let base_url = std::env::var("QVERIS_BASE_URL").unwrap_or_else(|_| "https://qveris.ai/api/v1".into());
        let (executor, bridge) = RunExecutor::start(self.credentials.clone(), base_url, audit).map_err(|error| { self.set_status(&app, RuntimeState::Crashed, None, Some(error.clone()), "crash"); error })?;
        let mut command = Command::new(binary);
        command.arg("--extension").arg(extension).args(["--mode", "rpc", "--no-session"]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        sanitized_environment(&mut command, &bridge);
        let mut child = match command.spawn() { Ok(child) => child, Err(error) => { executor.stop(); self.set_status(&app, RuntimeState::Crashed, None, Some(error.to_string()), "crash"); return Err(format!("cannot start Pi RPC runtime: {error}")); } };
        let pid = child.id();
        let stdin = child.stdin.take().ok_or("Pi stdin was not piped")?;
        let stdout = child.stdout.take().ok_or("Pi stdout was not piped")?;
        let stderr = child.stderr.take().ok_or("Pi stderr was not piped")?;
        let child = Arc::new(Mutex::new(child));
        let (writer, writer_rx) = mpsc::channel();
        {
            let mut inner = self.inner.lock().map_err(|_| "host lock poisoned")?;
            inner.child = Some(child.clone()); inner.writer = Some(writer); inner.executor = Some(executor); inner.status = RuntimeStatus { state: RuntimeState::Running, pid: Some(pid), detail: None };
        }
        self.publish(&app, "started", None);
        self.spawn_writer(stdin, writer_rx, app.clone());
        self.spawn_stdout(stdout, app.clone());
        self.spawn_stderr(stderr, app.clone());
        self.spawn_watcher(child, app);
        Ok(self.status())
    }

    fn stop(&self, app: AppHandle) -> Result<RuntimeStatus, String> {
        let (child, executor) = { let mut inner = self.inner.lock().map_err(|_| "host lock poisoned")?; if inner.child.is_none() { return Ok(inner.status.clone()); } inner.status.state = RuntimeState::Stopping; (inner.child.clone().unwrap(), inner.executor.take()) };
        self.publish(&app, "stopping", None);
        if let Some(executor) = executor { executor.stop(); }
        child.lock().map_err(|_| "child lock poisoned")?.kill().map_err(|e| format!("cannot stop Pi runtime: {e}"))?;
        Ok(self.status())
    }

    fn request(&self, payload: Value, timeout: Duration) -> Result<Value, String> {
        if !payload.is_object() { return Err("RPC payload must be a JSON object".into()); }
        let id = format!("foliomind-{}", self.next_id.fetch_add(1, Ordering::Relaxed));
        let mut payload = payload; payload["id"] = Value::String(id.clone());
        let (reply_tx, reply_rx) = mpsc::channel();
        let writer = {
            let mut inner = self.inner.lock().map_err(|_| "host lock poisoned")?;
            if inner.status.state != RuntimeState::Running { return Err("Pi runtime is not running".into()); }
            inner.pending.insert(id.clone(), reply_tx);
            inner.writer.clone().ok_or("Pi runtime writer is unavailable")?
        };
        if writer.send(payload).is_err() { self.remove_pending(&id); return Err("Pi runtime stdin is closed".into()); }
        match reply_rx.recv_timeout(timeout) { Ok(result) => result, Err(mpsc::RecvTimeoutError::Timeout) => { self.remove_pending(&id); Err("Pi RPC request timed out".into()) }, Err(_) => Err("Pi runtime closed before replying".into()) }
    }

    fn remove_pending(&self, id: &str) { if let Ok(mut inner) = self.inner.lock() { inner.pending.remove(id); } }
    fn resolve(&self, id: &str, frame: Value) { if let Ok(mut inner) = self.inner.lock() { if let Some(reply) = inner.pending.remove(id) { let _ = reply.send(Ok(frame)); } } }
    fn fail_all(&self, reason: &str) { if let Ok(mut inner) = self.inner.lock() { for (_, reply) in inner.pending.drain() { let _ = reply.send(Err(reason.into())); } inner.writer = None; } }
    fn set_status(&self, app: &AppHandle, state: RuntimeState, pid: Option<u32>, detail: Option<String>, kind: &str) { if let Ok(mut inner) = self.inner.lock() { inner.status = RuntimeStatus { state, pid, detail }; } self.publish(app, kind, None); }

    fn spawn_writer(&self, mut stdin: impl Write + Send + 'static, rx: mpsc::Receiver<Value>, app: AppHandle) { let host = self.clone(); std::thread::spawn(move || { for value in rx { let encoded = match encode_jsonl(&value) { Ok(v) => v, Err(e) => { host.publish(&app, "protocol_error", Some(Value::String(e))); continue; } }; if stdin.write_all(&encoded).and_then(|_| stdin.flush()).is_err() { host.fail_all("Pi runtime stdin write failed"); host.publish(&app, "transport_error", None); break; } } }); }
    fn spawn_stdout(&self, stdout: impl std::io::Read + Send + 'static, app: AppHandle) { let host = self.clone(); std::thread::spawn(move || { for line in BufReader::new(stdout).split(b'\n') { match line { Ok(raw) => match decode_jsonl(&raw) { Ok(frame) => { if let Some(id) = frame.get("id").and_then(Value::as_str) { host.resolve(id, frame); } else { host.publish(&app, "event", Some(frame)); } }, Err(error) => host.publish(&app, "protocol_error", Some(Value::String(error))), }, Err(_) => break, } } }); }
    fn spawn_stderr(&self, stderr: impl std::io::Read + Send + 'static, app: AppHandle) { let host = self.clone(); std::thread::spawn(move || { for line in BufReader::new(stderr).lines().map_while(Result::ok) { host.publish(&app, "diagnostic", Some(Value::String(line.chars().take(4096).collect()))); } }); }
    fn spawn_watcher(&self, child: Arc<Mutex<Child>>, app: AppHandle) { let host = self.clone(); std::thread::spawn(move || loop { std::thread::sleep(Duration::from_millis(100)); let exit = child.lock().ok().and_then(|mut child| child.try_wait().ok()).flatten(); if let Some(status) = exit { let next_state = state_after_process_exit(host.status().state); host.fail_all("Pi runtime exited"); if let Ok(mut inner) = host.inner.lock() { inner.child = None; if let Some(executor) = inner.executor.take() { executor.stop(); } } if next_state == RuntimeState::Stopped { host.set_status(&app, RuntimeState::Stopped, None, None, "stopped"); } else { host.set_status(&app, RuntimeState::Crashed, None, Some(status.to_string()), "crash"); } break; } }); }
}

fn resolve_pi_binary(app: &AppHandle) -> PathBuf {
    if let Some(path) = std::env::var_os("FOLIOMIND_PI_BINARY") { return path.into(); }
    let name = if cfg!(windows) { "pi.exe" } else { "pi" };
    app.path().resource_dir().ok().map(|dir| dir.join("pi").join(name)).filter(|path| path.is_file()).unwrap_or_else(|| name.into())
}

fn resolve_bridge_extension(app: &AppHandle) -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os("FOLIOMIND_BRIDGE_EXTENSION") { candidates.push(PathBuf::from(path)); }
    if let Ok(resources) = app.path().resource_dir() { candidates.push(resources.join("extensions").join("qveris-bridge.mjs")); }
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("packages").join("qveris-bridge").join("index.mjs"));
    candidates.into_iter().find(|path| path.is_file()).ok_or_else(|| "QVeris bridge extension is missing from the application bundle".into())
}

fn sanitized_environment(command: &mut Command, bridge: &BridgeEnvironment) {
    command.env_clear();
    // Keep only OS essentials. In particular, no QVERIS_* credential is inherited by Pi.
    for key in ["PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "SYSTEMROOT", "COMSPEC", "PATHEXT", "LANG"] { if let Some(value) = std::env::var_os(key) { command.env(key, value); } }
    command.env("QVERIS_EXECUTOR_URL", &bridge.url).env("QVERIS_MANAGED_CAPABILITY", &bridge.capability).env("QVERIS_PI_RUN_ID", &bridge.run_id).env("QVERIS_PRODUCT_RUN_ID", &bridge.product_run_id).env("QVERIS_EXECUTOR_TIMEOUT_MS", "15000");
}

fn state_after_process_exit(previous: RuntimeState) -> RuntimeState { if previous == RuntimeState::Stopping { RuntimeState::Stopped } else { RuntimeState::Crashed } }

fn encode_jsonl(value: &Value) -> Result<Vec<u8>, String> { let mut bytes = serde_json::to_vec(value).map_err(|e| format!("cannot encode RPC JSON: {e}"))?; if bytes.iter().any(|b| *b == b'\n' || *b == b'\r') { return Err("RPC JSON must be a single line".into()); } bytes.push(b'\n'); Ok(bytes) }
fn decode_jsonl(raw: &[u8]) -> Result<Value, String> { if raw.len() > MAX_JSONL_BYTES { return Err("Pi JSONL frame exceeds 1 MiB".into()); } if raw.is_empty() { return Err("Pi emitted an empty JSONL frame".into()); } serde_json::from_slice(raw).map_err(|e| format!("invalid Pi JSONL frame: {e}")) }

#[tauri::command]
fn runtime_status(host: State<'_, PiHost>) -> RuntimeStatus { host.status() }
#[tauri::command]
fn runtime_start(host: State<'_, PiHost>, app: AppHandle) -> Result<RuntimeStatus, String> { host.start(app) }
#[tauri::command]
fn runtime_stop(host: State<'_, PiHost>, app: AppHandle) -> Result<RuntimeStatus, String> { host.stop(app) }
#[tauri::command]
async fn runtime_send_rpc(host: State<'_, PiHost>, payload: Value, timeout_ms: Option<u64>) -> Result<Value, String> { let host = host.inner().clone(); tauri::async_runtime::spawn_blocking(move || host.request(payload, Duration::from_millis(timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS).clamp(1, 120_000)))).await.map_err(|e| format!("RPC task failed: {e}"))? }
#[tauri::command]
fn qveris_credential_configured(host: State<'_, PiHost>) -> Result<bool, String> { Ok(host.credentials.read_qveris_key()?.is_some()) }
#[tauri::command]
fn qveris_credential_save(host: State<'_, PiHost>, api_key: String) -> Result<(), String> { host.credentials.write_qveris_key(&api_key) }
#[tauri::command]
fn qveris_credential_clear(host: State<'_, PiHost>) -> Result<(), String> { host.credentials.delete_qveris_key() }

fn main() { tauri::Builder::default().manage(PiHost::default()).invoke_handler(tauri::generate_handler![runtime_status, runtime_start, runtime_stop, runtime_send_rpc, qveris_credential_configured, qveris_credential_save, qveris_credential_clear]).run(tauri::generate_context!()).expect("error while running FolioMind"); }

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn jsonl_round_trip_is_single_line() { let input = serde_json::json!({"id":"1","method":"ping"}); let wire = encode_jsonl(&input).unwrap(); assert_eq!(wire.last(), Some(&b'\n')); assert_eq!(decode_jsonl(&wire[..wire.len() - 1]).unwrap(), input); }
    #[test] fn jsonl_rejects_empty_and_oversized_frames() { assert!(decode_jsonl(b"").is_err()); assert!(decode_jsonl(&vec![b'x'; MAX_JSONL_BYTES + 1]).is_err()); }
    #[test] fn status_defaults_to_stopped_and_request_needs_runtime() { let host = PiHost::default(); assert_eq!(host.status().state, RuntimeState::Stopped); assert!(host.request(serde_json::json!({"method":"ping"}), Duration::from_millis(1)).is_err()); }
    #[test] fn process_exit_is_crash_unless_stop_was_requested() { assert_eq!(state_after_process_exit(RuntimeState::Running), RuntimeState::Crashed); assert_eq!(state_after_process_exit(RuntimeState::Starting), RuntimeState::Crashed); assert_eq!(state_after_process_exit(RuntimeState::Stopping), RuntimeState::Stopped); }
}
