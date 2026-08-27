#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
//! Local-only Pi RPC host. The only listener is a run-scoped loopback executor.

mod config;
mod credentials;
mod executor;
mod process_command;

use config::IntegrationSettings;
use credentials::{CredentialStore, OsCredentialStore};
use executor::{AuditEvent, BridgeEnvironment, RunExecutor};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, State};

const EVENT_NAME: &str = "pi-runtime://event";
const MAX_JSONL_BYTES: usize = 1024 * 1024;
const MAX_DIAGNOSTIC_LINE_BYTES: usize = 16 * 1024;
const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const SETTINGS_APPLY_STOP_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct RuntimeStatus {
    state: RuntimeState,
    pid: Option<u32>,
    detail: Option<String>,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum RuntimeState {
    Stopped,
    Starting,
    Running,
    Stopping,
    Crashed,
}

impl Default for RuntimeStatus {
    fn default() -> Self {
        Self {
            state: RuntimeState::Stopped,
            pid: None,
            detail: None,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeEvent {
    kind: String,
    status: RuntimeStatus,
    frame: Option<Value>,
}

struct Inner {
    child: Option<Arc<Mutex<Child>>>,
    writer: Option<mpsc::Sender<Value>>,
    pending: HashMap<String, mpsc::Sender<Result<Value, String>>>,
    status: RuntimeStatus,
    executor: Option<RunExecutor>,
}

#[derive(Clone)]
struct PiHost {
    inner: Arc<Mutex<Inner>>,
    next_id: Arc<AtomicU64>,
    credentials: Arc<dyn CredentialStore>,
}

impl Default for PiHost {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                child: None,
                writer: None,
                pending: HashMap::new(),
                status: RuntimeStatus::default(),
                executor: None,
            })),
            next_id: Arc::new(AtomicU64::new(1)),
            credentials: Arc::new(OsCredentialStore),
        }
    }
}

impl PiHost {
    fn status(&self) -> RuntimeStatus {
        self.inner
            .lock()
            .expect("host lock poisoned")
            .status
            .clone()
    }

    fn publish(&self, app: &AppHandle, kind: &str, frame: Option<Value>) {
        let _ = app.emit(
            EVENT_NAME,
            RuntimeEvent {
                kind: kind.into(),
                status: self.status(),
                frame,
            },
        );
    }

    fn start(&self, app: AppHandle) -> Result<RuntimeStatus, String> {
        self.ensure_startable()?;
        let binary = resolve_pi_binary(&app);
        let extension = resolve_bridge_extension(&app)?;
        let finance_skill = resolve_finance_skill(&app)?;
        let bundled_bash = resolve_bundled_bash(&app)?;
        let settings = config::load(&app)?;
        self.reserve_start()?;
        self.publish(&app, "status", None);
        let audit_app = app.clone();
        let audit = Arc::new(move |event: AuditEvent| {
            let _ = audit_app.emit(
                EVENT_NAME,
                serde_json::json!({ "kind": "qveris_audit", "audit": event }),
            );
        });
        let (executor, bridge) = RunExecutor::start(
            self.credentials.clone(),
            settings.capability_base_url.clone(),
            settings.model_gateway_base_url.clone(),
            audit,
        )
        .inspect_err(|error| {
            self.set_status(
                &app,
                RuntimeState::Crashed,
                None,
                Some(error.clone()),
                "crash",
            );
        })?;
        let agent_dir = match config::write_pi_config(
            &app,
            &settings,
            &bridge.model_base_url,
            bundled_bash.as_deref(),
        ) {
            Ok(path) => path,
            Err(error) => {
                executor.stop();
                self.set_status(
                    &app,
                    RuntimeState::Crashed,
                    None,
                    Some(error.clone()),
                    "crash",
                );
                return Err(error);
            }
        };
        let mut command = process_command::new_command(binary);
        command
            .arg("--extension")
            .arg(extension)
            .arg("--skill")
            .arg(finance_skill)
            .args([
                "--mode",
                "rpc",
                "--no-session",
                "--no-extensions",
                "--no-context-files",
                "--tools",
                "bash,qveris_search,qveris_inspect,qveris_call",
            ]);
        if !settings.model_id.trim().is_empty() {
            command.args(["--provider", "qveris", "--model", settings.model_id.trim()]);
        }
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        sanitized_environment(&mut command, &bridge, &agent_dir, bundled_bash.as_deref());
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                executor.stop();
                self.set_status(
                    &app,
                    RuntimeState::Crashed,
                    None,
                    Some(error.to_string()),
                    "crash",
                );
                return Err(format!("cannot start Pi RPC runtime: {error}"));
            }
        };
        let pid = child.id();
        let stdin = child.stdin.take().ok_or("Pi stdin was not piped")?;
        let stdout = child.stdout.take().ok_or("Pi stdout was not piped")?;
        let stderr = child.stderr.take().ok_or("Pi stderr was not piped")?;
        let child = Arc::new(Mutex::new(child));
        let (writer, writer_rx) = mpsc::channel();
        {
            let mut inner = self.inner.lock().map_err(|_| "host lock poisoned")?;
            inner.child = Some(child.clone());
            inner.writer = Some(writer);
            inner.executor = Some(executor);
            inner.status = RuntimeStatus {
                state: RuntimeState::Running,
                pid: Some(pid),
                detail: None,
            };
        }
        self.publish(&app, "started", None);
        self.spawn_writer(stdin, writer_rx, app.clone());
        self.spawn_stdout(stdout, app.clone());
        self.spawn_stderr(stderr, app.clone());
        self.spawn_watcher(child, app);
        Ok(self.status())
    }

    fn ensure_startable(&self) -> Result<(), String> {
        let inner = self.inner.lock().map_err(|_| "host lock poisoned")?;
        if matches!(
            inner.status.state,
            RuntimeState::Stopped | RuntimeState::Crashed
        ) {
            Ok(())
        } else {
            Err("Pi runtime is already active".into())
        }
    }

    fn reserve_start(&self) -> Result<(), String> {
        let mut inner = self.inner.lock().map_err(|_| "host lock poisoned")?;
        if !matches!(
            inner.status.state,
            RuntimeState::Stopped | RuntimeState::Crashed
        ) {
            return Err("Pi runtime is already active".into());
        }
        inner.status = RuntimeStatus {
            state: RuntimeState::Starting,
            pid: None,
            detail: None,
        };
        Ok(())
    }

    fn stop(&self, app: AppHandle) -> Result<RuntimeStatus, String> {
        let (child, executor) = {
            let mut inner = self.inner.lock().map_err(|_| "host lock poisoned")?;
            if inner.child.is_none() {
                return Ok(inner.status.clone());
            }
            inner.status.state = RuntimeState::Stopping;
            (inner.child.clone().unwrap(), inner.executor.take())
        };
        self.publish(&app, "stopping", None);
        if let Some(executor) = executor {
            executor.stop();
        }
        let mut process = child.lock().map_err(|_| "child lock poisoned")?;
        if process
            .try_wait()
            .map_err(|error| format!("cannot inspect Pi runtime: {error}"))?
            .is_none()
        {
            process
                .kill()
                .map_err(|error| format!("cannot stop Pi runtime: {error}"))?;
        }
        Ok(self.status())
    }

    fn stop_and_wait(&self, app: AppHandle, timeout: Duration) -> Result<(), String> {
        match self.status().state {
            RuntimeState::Stopped | RuntimeState::Crashed => return Ok(()),
            RuntimeState::Starting => {
                return Err("Pi runtime is still starting; retry settings apply shortly".into())
            }
            RuntimeState::Running => {
                self.stop(app)?;
            }
            RuntimeState::Stopping => {}
        }
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if self.status().state == RuntimeState::Stopped {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        Err("Pi runtime did not stop in time".into())
    }

    fn shutdown(&self) {
        let (child, executor, pending) = {
            let Ok(mut inner) = self.inner.lock() else {
                return;
            };
            inner.status = RuntimeStatus {
                state: RuntimeState::Stopping,
                pid: inner.status.pid,
                detail: None,
            };
            inner.writer = None;
            (
                inner.child.take(),
                inner.executor.take(),
                inner
                    .pending
                    .drain()
                    .map(|(_, reply)| reply)
                    .collect::<Vec<_>>(),
            )
        };

        for reply in pending {
            let _ = reply.send(Err("Pi runtime is shutting down".into()));
        }
        if let Some(executor) = executor {
            executor.stop();
        }
        if let Some(child) = child {
            if let Ok(mut child) = child.lock() {
                if matches!(child.try_wait(), Ok(None)) {
                    let _ = child.kill();
                }
                let _ = child.wait();
            }
        }
        if let Ok(mut inner) = self.inner.lock() {
            inner.status = RuntimeStatus::default();
        }
    }

    fn request(&self, payload: Value, timeout: Duration) -> Result<Value, String> {
        if !payload.is_object() {
            return Err("RPC payload must be a JSON object".into());
        }
        let id = format!("foliomind-{}", self.next_id.fetch_add(1, Ordering::Relaxed));
        let mut payload = payload;
        payload["id"] = Value::String(id.clone());
        let (reply_tx, reply_rx) = mpsc::channel();
        let writer = {
            let mut inner = self.inner.lock().map_err(|_| "host lock poisoned")?;
            if inner.status.state != RuntimeState::Running {
                return Err("Pi runtime is not running".into());
            }
            inner.pending.insert(id.clone(), reply_tx);
            inner
                .writer
                .clone()
                .ok_or("Pi runtime writer is unavailable")?
        };
        if writer.send(payload).is_err() {
            self.remove_pending(&id);
            return Err("Pi runtime stdin is closed".into());
        }
        match reply_rx.recv_timeout(timeout) {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                self.remove_pending(&id);
                Err("Pi RPC request timed out".into())
            }
            Err(_) => Err("Pi runtime closed before replying".into()),
        }
    }

    fn remove_pending(&self, id: &str) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.pending.remove(id);
        }
    }
    fn resolve(&self, id: &str, frame: Value) {
        if let Ok(mut inner) = self.inner.lock() {
            if let Some(reply) = inner.pending.remove(id) {
                let _ = reply.send(Ok(frame));
            }
        }
    }
    fn fail_all(&self, reason: &str) {
        if let Ok(mut inner) = self.inner.lock() {
            for (_, reply) in inner.pending.drain() {
                let _ = reply.send(Err(reason.into()));
            }
            inner.writer = None;
        }
    }
    fn fail_pending(&self, reason: &str) {
        if let Ok(mut inner) = self.inner.lock() {
            for (_, reply) in inner.pending.drain() {
                let _ = reply.send(Err(reason.into()));
            }
        }
    }
    fn set_status(
        &self,
        app: &AppHandle,
        state: RuntimeState,
        pid: Option<u32>,
        detail: Option<String>,
        kind: &str,
    ) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.status = RuntimeStatus { state, pid, detail };
        }
        self.publish(app, kind, None);
    }

    fn spawn_writer(
        &self,
        mut stdin: impl Write + Send + 'static,
        rx: mpsc::Receiver<Value>,
        app: AppHandle,
    ) {
        let host = self.clone();
        std::thread::spawn(move || {
            for value in rx {
                let encoded = match encode_jsonl(&value) {
                    Ok(v) => v,
                    Err(e) => {
                        host.publish(&app, "protocol_error", Some(Value::String(e)));
                        continue;
                    }
                };
                if stdin
                    .write_all(&encoded)
                    .and_then(|_| stdin.flush())
                    .is_err()
                {
                    host.fail_all("Pi runtime stdin write failed");
                    host.publish(&app, "transport_error", None);
                    break;
                }
            }
        });
    }
    fn spawn_stdout(&self, stdout: impl std::io::Read + Send + 'static, app: AppHandle) {
        let host = self.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                match read_bounded_line(&mut reader, MAX_JSONL_BYTES) {
                    Ok(BoundedLine::Line(raw)) => match decode_jsonl(&raw) {
                        Ok(frame) => {
                            if let Some(id) =
                                frame.get("id").and_then(Value::as_str).map(str::to_owned)
                            {
                                host.resolve(&id, frame);
                            } else {
                                host.publish(&app, "event", Some(frame));
                            }
                        }
                        Err(error) => {
                            host.fail_pending("Pi runtime emitted invalid JSONL");
                            host.publish(&app, "protocol_error", Some(Value::String(error)));
                        }
                    },
                    Ok(BoundedLine::TooLong) => {
                        host.fail_pending("Pi runtime emitted an oversized JSONL frame");
                        host.publish(
                            &app,
                            "protocol_error",
                            Some(Value::String("Pi JSONL frame exceeds 1 MiB".into())),
                        );
                    }
                    Ok(BoundedLine::Eof) => break,
                    Err(_) => {
                        host.fail_all("Pi runtime stdout read failed");
                        host.publish(&app, "transport_error", None);
                        break;
                    }
                }
            }
        });
    }
    fn spawn_stderr(&self, stderr: impl std::io::Read + Send + 'static, app: AppHandle) {
        let host = self.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stderr);
            loop {
                match read_bounded_line(&mut reader, MAX_DIAGNOSTIC_LINE_BYTES) {
                    Ok(BoundedLine::Line(raw)) => host.publish(
                        &app,
                        "diagnostic",
                        Some(Value::String(
                            String::from_utf8_lossy(&raw).chars().take(4096).collect(),
                        )),
                    ),
                    Ok(BoundedLine::TooLong) => host.publish(
                        &app,
                        "diagnostic",
                        Some(Value::String(
                            "Pi stderr line exceeded 16 KiB and was discarded".into(),
                        )),
                    ),
                    Ok(BoundedLine::Eof) | Err(_) => break,
                }
            }
        });
    }
    fn spawn_watcher(&self, child: Arc<Mutex<Child>>, app: AppHandle) {
        let host = self.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(100));
            let exit = child
                .lock()
                .ok()
                .and_then(|mut child| child.try_wait().ok())
                .flatten();
            if let Some(status) = exit {
                let next_state = state_after_process_exit(host.status().state);
                host.fail_all("Pi runtime exited");
                if let Ok(mut inner) = host.inner.lock() {
                    inner.child = None;
                    if let Some(executor) = inner.executor.take() {
                        executor.stop();
                    }
                }
                if next_state == RuntimeState::Stopped {
                    host.set_status(&app, RuntimeState::Stopped, None, None, "stopped");
                } else {
                    host.set_status(
                        &app,
                        RuntimeState::Crashed,
                        None,
                        Some(status.to_string()),
                        "crash",
                    );
                }
                break;
            }
        });
    }
}

fn resolve_pi_binary(app: &AppHandle) -> PathBuf {
    if let Some(path) = std::env::var_os("FOLIOMIND_PI_BINARY") {
        return path.into();
    }
    let name = if cfg!(windows) { "pi.exe" } else { "pi" };
    app.path()
        .resource_dir()
        .ok()
        .map(|dir| dir.join("pi").join(name))
        .filter(|path| path.is_file())
        .unwrap_or_else(|| name.into())
}

fn resolve_bridge_extension(app: &AppHandle) -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os("FOLIOMIND_BRIDGE_EXTENSION") {
        candidates.push(PathBuf::from(path));
    }
    if let Ok(resources) = app.path().resource_dir() {
        candidates.push(resources.join("extensions").join("qveris-bridge.mjs"));
    }
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("packages")
            .join("qveris-bridge")
            .join("index.mjs"),
    );
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| "QVeris bridge extension is missing from the application bundle".into())
}

fn resolve_finance_skill(app: &AppHandle) -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    if let Ok(resources) = app.path().resource_dir() {
        candidates.push(resources.join("skills").join("qveris-finance-research"));
    }
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("skills")
            .join("qveris-finance-research"),
    );
    candidates
        .into_iter()
        .find(|path| path.join("SKILL.md").is_file())
        .ok_or_else(|| "QVeris finance Skill is missing from the application bundle".into())
}

fn resolve_bundled_bash(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    if !cfg!(target_os = "windows") {
        return Ok(None);
    }
    let mut candidates = Vec::new();
    if let Ok(resources) = app.path().resource_dir() {
        candidates.push(resources.join("portable-git").join("bin").join("bash.exe"));
    }
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("portable-git")
            .join("bin")
            .join("bash.exe"),
    );
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .map(Some)
        .ok_or_else(|| {
            "Bundled Bash is missing; reinstall FolioMind or run npm run fetch:bash".into()
        })
}

fn sanitized_environment(
    command: &mut Command,
    bridge: &BridgeEnvironment,
    agent_dir: &std::path::Path,
    bundled_bash: Option<&std::path::Path>,
) {
    command.env_clear();
    // Keep only OS essentials. In particular, no QVERIS_* credential is inherited by Pi.
    for key in [
        "HOME",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "TEMP",
        "TMP",
        "SYSTEMROOT",
        "COMSPEC",
        "PATHEXT",
        "LANG",
    ] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    let mut paths = bundled_bash
        .and_then(|path| path.parent()?.parent())
        .map(|root| {
            vec![
                root.join("cmd"),
                root.join("bin"),
                root.join("usr").join("bin"),
            ]
        })
        .unwrap_or_default();
    if let Some(ambient) = std::env::var_os("PATH") {
        paths.extend(std::env::split_paths(&ambient));
    }
    if let Ok(path) = std::env::join_paths(paths) {
        command.env("PATH", path);
    }
    command
        .env("PI_CODING_AGENT_DIR", agent_dir)
        .env("QVERIS_EXECUTOR_URL", &bridge.url)
        .env("QVERIS_MANAGED_CAPABILITY", &bridge.capability)
        .env("QVERIS_PI_RUN_ID", &bridge.run_id)
        .env("QVERIS_PRODUCT_RUN_ID", &bridge.product_run_id)
        .env("QVERIS_EXECUTOR_TIMEOUT_MS", "30000")
        .env("FOLIOMIND_MODEL_TOKEN", &bridge.model_capability);
}

fn state_after_process_exit(previous: RuntimeState) -> RuntimeState {
    if matches!(previous, RuntimeState::Stopping | RuntimeState::Stopped) {
        RuntimeState::Stopped
    } else {
        RuntimeState::Crashed
    }
}

fn encode_jsonl(value: &Value) -> Result<Vec<u8>, String> {
    let mut bytes =
        serde_json::to_vec(value).map_err(|e| format!("cannot encode RPC JSON: {e}"))?;
    if bytes.len() > MAX_JSONL_BYTES {
        return Err("Pi JSONL frame exceeds 1 MiB".into());
    }
    if bytes.iter().any(|b| *b == b'\n' || *b == b'\r') {
        return Err("RPC JSON must be a single line".into());
    }
    bytes.push(b'\n');
    Ok(bytes)
}
fn decode_jsonl(raw: &[u8]) -> Result<Value, String> {
    if raw.len() > MAX_JSONL_BYTES {
        return Err("Pi JSONL frame exceeds 1 MiB".into());
    }
    if raw.is_empty() {
        return Err("Pi emitted an empty JSONL frame".into());
    }
    serde_json::from_slice(raw).map_err(|e| format!("invalid Pi JSONL frame: {e}"))
}

#[derive(Debug, PartialEq, Eq)]
enum BoundedLine {
    Line(Vec<u8>),
    TooLong,
    Eof,
}

fn read_bounded_line(reader: &mut impl BufRead, max_bytes: usize) -> std::io::Result<BoundedLine> {
    let mut line = Vec::with_capacity(max_bytes.min(8192));
    let mut too_long = false;
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return Ok(if too_long {
                BoundedLine::TooLong
            } else if line.is_empty() {
                BoundedLine::Eof
            } else {
                BoundedLine::Line(line)
            });
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let consumed = newline.map_or(available.len(), |index| index + 1);
        let content_len = newline.unwrap_or(available.len());
        if !too_long {
            if line.len().saturating_add(content_len) <= max_bytes {
                line.extend_from_slice(&available[..content_len]);
            } else {
                too_long = true;
                line.clear();
            }
        }
        reader.consume(consumed);
        if newline.is_some() {
            return Ok(if too_long {
                BoundedLine::TooLong
            } else {
                BoundedLine::Line(line)
            });
        }
    }
}

#[tauri::command]
fn runtime_status(host: State<'_, PiHost>) -> RuntimeStatus {
    host.status()
}
#[tauri::command]
fn runtime_start(host: State<'_, PiHost>, app: AppHandle) -> Result<RuntimeStatus, String> {
    host.start(app)
}
#[tauri::command]
fn runtime_stop(host: State<'_, PiHost>, app: AppHandle) -> Result<RuntimeStatus, String> {
    host.stop(app)
}
#[tauri::command]
async fn runtime_send_rpc(
    host: State<'_, PiHost>,
    payload: Value,
    timeout_ms: Option<u64>,
) -> Result<Value, String> {
    let host = host.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        host.request(
            payload,
            Duration::from_millis(timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS).clamp(1, 120_000)),
        )
    })
    .await
    .map_err(|e| format!("RPC task failed: {e}"))?
}
#[tauri::command]
fn qveris_credential_configured(host: State<'_, PiHost>) -> Result<bool, String> {
    Ok(host.credentials.read_qveris_key()?.is_some())
}
#[tauri::command]
fn qveris_credential_save(host: State<'_, PiHost>, api_key: String) -> Result<(), String> {
    host.credentials.write_qveris_key(&api_key)
}
#[tauri::command]
fn qveris_credential_clear(host: State<'_, PiHost>) -> Result<(), String> {
    host.credentials.delete_qveris_key()
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct IntegrationStatus {
    credential_configured: bool,
    settings: IntegrationSettings,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettingsInput {
    capability_base_url: String,
    model_gateway_base_url: String,
    model_id: String,
}

#[tauri::command]
fn integration_status(
    host: State<'_, PiHost>,
    app: AppHandle,
) -> Result<IntegrationStatus, String> {
    Ok(IntegrationStatus {
        credential_configured: host.credentials.read_qveris_key()?.is_some(),
        settings: config::load(&app)?,
    })
}

fn settings_from_input(
    current: &IntegrationSettings,
    input: SettingsInput,
) -> Result<IntegrationSettings, String> {
    let mut settings = current.clone();
    let capability_base_url = input
        .capability_base_url
        .trim()
        .trim_end_matches('/')
        .to_owned();
    let model_gateway_base_url = input
        .model_gateway_base_url
        .trim()
        .trim_end_matches('/')
        .to_owned();
    if model_gateway_base_url != settings.model_gateway_base_url.trim().trim_end_matches('/') {
        return Err("模型网关地址已更改，请先同步模型目录".into());
    }
    settings.capability_base_url = capability_base_url;
    settings.model_gateway_base_url = model_gateway_base_url;
    settings.model_id = input.model_id.trim().to_owned();
    config::validate(&settings)?;
    config::validate_model_selection(&settings)?;
    Ok(settings)
}

fn apply_integration_settings(
    host: &PiHost,
    app: AppHandle,
    input: SettingsInput,
) -> Result<IntegrationSettings, String> {
    let previous = config::load(&app)?;
    let settings = settings_from_input(&previous, input)?;
    host.stop_and_wait(app.clone(), SETTINGS_APPLY_STOP_TIMEOUT)?;
    if let Err(error) = config::save(&app, &settings) {
        if let Err(restore) = config::save(&app, &previous) {
            return Err(format!(
                "cannot save integration settings: {error}; previous settings recovery failed: {restore}"
            ));
        }
        return Err(match host.start(app) {
            Ok(_) => {
                format!("cannot save integration settings: {error}; previous Runtime restored")
            }
            Err(recovery) => format!(
                "cannot save integration settings: {error}; previous settings restored, but Runtime recovery failed: {recovery}"
            ),
        });
    }
    if let Err(error) = host.start(app.clone()) {
        if let Err(restore) = config::save(&app, &previous) {
            return Err(format!(
                "new settings failed to apply: {error}; previous settings recovery failed: {restore}"
            ));
        }
        return Err(match host.start(app) {
            Ok(_) => format!(
                "new settings failed to apply: {error}; previous settings and Runtime restored"
            ),
            Err(recovery) => format!(
                "new settings failed to apply: {error}; previous settings restored, but Runtime recovery failed: {recovery}"
            ),
        });
    }
    Ok(settings)
}

#[tauri::command]
async fn integration_settings_apply(
    host: State<'_, PiHost>,
    app: AppHandle,
    input: SettingsInput,
) -> Result<IntegrationSettings, String> {
    let host = host.inner().clone();
    tauri::async_runtime::spawn_blocking(move || apply_integration_settings(&host, app, input))
        .await
        .map_err(|error| format!("settings apply task failed: {error}"))?
}

#[tauri::command]
async fn qveris_model_catalog_sync(
    host: State<'_, PiHost>,
    app: AppHandle,
    input: SettingsInput,
) -> Result<IntegrationSettings, String> {
    let key = host
        .credentials
        .read_qveris_key()?
        .ok_or("QVeris credential is not configured")?;
    let mut settings = config::load(&app)?;
    settings.capability_base_url = input
        .capability_base_url
        .trim()
        .trim_end_matches('/')
        .to_owned();
    settings.model_gateway_base_url = input
        .model_gateway_base_url
        .trim()
        .trim_end_matches('/')
        .to_owned();
    settings.model_id = input.model_id.trim().to_owned();
    config::validate(&settings)?;
    let base_url = settings.model_gateway_base_url.clone();
    let models = tauri::async_runtime::spawn_blocking(move || {
        executor::fetch_model_catalog(&key, &base_url)
    })
    .await
    .map_err(|error| format!("model catalog task failed: {error}"))??;
    settings.models = models;
    settings.model_id = config::reconcile_model_id(&settings.model_id, &settings.models);
    config::validate_model_selection(&settings)?;
    config::save(&app, &settings)?;
    Ok(settings)
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(PiHost::default())
        .invoke_handler(tauri::generate_handler![
            runtime_status,
            runtime_start,
            runtime_stop,
            runtime_send_rpc,
            qveris_credential_configured,
            qveris_credential_save,
            qveris_credential_clear,
            integration_status,
            integration_settings_apply,
            qveris_model_catalog_sync
        ])
        .build(tauri::generate_context!())
        .expect("error while building FolioMind");
    app.run(|app_handle, event| {
        if matches!(
            event,
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
        ) {
            app_handle.state::<PiHost>().shutdown();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn jsonl_round_trip_is_single_line() {
        let input = serde_json::json!({"id":"1","method":"ping"});
        let wire = encode_jsonl(&input).unwrap();
        assert_eq!(wire.last(), Some(&b'\n'));
        assert_eq!(decode_jsonl(&wire[..wire.len() - 1]).unwrap(), input);
    }
    #[test]
    fn jsonl_rejects_empty_and_oversized_frames() {
        assert!(decode_jsonl(b"").is_err());
        assert!(decode_jsonl(&vec![b'x'; MAX_JSONL_BYTES + 1]).is_err());
        assert!(encode_jsonl(&serde_json::json!({
            "payload": "x".repeat(MAX_JSONL_BYTES)
        }))
        .is_err());
    }
    #[test]
    fn status_defaults_to_stopped_and_request_needs_runtime() {
        let host = PiHost::default();
        assert_eq!(host.status().state, RuntimeState::Stopped);
        assert!(host
            .request(
                serde_json::json!({"method":"ping"}),
                Duration::from_millis(1)
            )
            .is_err());
    }
    #[test]
    fn runtime_start_reservation_is_atomic() {
        let host = PiHost::default();
        let successes = (0..8)
            .map(|_| {
                let host = host.clone();
                std::thread::spawn(move || host.reserve_start().is_ok())
            })
            .map(|thread| thread.join().unwrap())
            .filter(|success| *success)
            .count();
        assert_eq!(successes, 1);
        assert_eq!(host.status().state, RuntimeState::Starting);
    }
    #[test]
    fn bounded_line_reader_discards_oversized_frames_without_losing_the_next_line() {
        let mut input = BufReader::with_capacity(3, &b"123456\nok\nlast"[..]);
        assert_eq!(
            read_bounded_line(&mut input, 4).unwrap(),
            BoundedLine::TooLong
        );
        assert_eq!(
            read_bounded_line(&mut input, 4).unwrap(),
            BoundedLine::Line(b"ok".to_vec())
        );
        assert_eq!(
            read_bounded_line(&mut input, 4).unwrap(),
            BoundedLine::Line(b"last".to_vec())
        );
        assert_eq!(read_bounded_line(&mut input, 4).unwrap(), BoundedLine::Eof);
    }
    #[test]
    fn process_exit_is_crash_unless_stop_was_requested() {
        assert_eq!(
            state_after_process_exit(RuntimeState::Running),
            RuntimeState::Crashed
        );
        assert_eq!(
            state_after_process_exit(RuntimeState::Starting),
            RuntimeState::Crashed
        );
        assert_eq!(
            state_after_process_exit(RuntimeState::Stopping),
            RuntimeState::Stopped
        );
        assert_eq!(
            state_after_process_exit(RuntimeState::Stopped),
            RuntimeState::Stopped
        );
    }

    #[test]
    fn settings_input_is_normalized_and_must_keep_the_synced_gateway() {
        let current = IntegrationSettings {
            model_id: "model-a".into(),
            models: vec![serde_json::json!({"id":"model-a"})],
            ..IntegrationSettings::default()
        };
        let normalized = settings_from_input(
            &current,
            SettingsInput {
                capability_base_url: " https://qveris.ai/api/v1/ ".into(),
                model_gateway_base_url: " https://aigateway.qveris.ai/v1/ ".into(),
                model_id: " model-a ".into(),
            },
        )
        .unwrap();
        assert_eq!(normalized.capability_base_url, "https://qveris.ai/api/v1");
        assert_eq!(normalized.model_id, "model-a");

        assert!(settings_from_input(
            &current,
            SettingsInput {
                capability_base_url: "https://qveris.ai/api/v1".into(),
                model_gateway_base_url: "https://other.example.com/v1".into(),
                model_id: "model-a".into(),
            },
        )
        .is_err());
    }

    #[test]
    fn shutdown_terminates_the_child_and_fails_pending_requests() {
        let mut command = process_command::new_command(
            std::env::current_exe().expect("test executable should resolve"),
        );
        command.args(["tests::shutdown_child_fixture", "--ignored", "--exact"]);
        let child = Arc::new(Mutex::new(
            command
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .expect("test child should start"),
        ));
        std::thread::sleep(Duration::from_millis(50));
        assert!(child.lock().unwrap().try_wait().unwrap().is_none());
        let (reply, response) = mpsc::channel();
        let host = PiHost::default();
        {
            let mut inner = host.inner.lock().expect("host lock should be available");
            inner.status = RuntimeStatus {
                state: RuntimeState::Running,
                pid: child.lock().ok().map(|child| child.id()),
                detail: None,
            };
            inner.child = Some(child.clone());
            inner.pending.insert("pending".into(), reply);
        }

        host.shutdown();

        assert_eq!(host.status(), RuntimeStatus::default());
        assert!(response
            .recv_timeout(Duration::from_secs(1))
            .unwrap()
            .is_err());
        assert!(child.lock().unwrap().try_wait().unwrap().is_some());
    }

    #[test]
    #[ignore = "spawned by shutdown cleanup test"]
    fn shutdown_child_fixture() {
        std::thread::sleep(Duration::from_secs(30));
    }
}
