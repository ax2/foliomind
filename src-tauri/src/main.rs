#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
//! Local-only Pi RPC host. The only listener is a run-scoped loopback executor.

mod config;
mod credentials;
mod desktop_lifecycle;
mod executor;
mod market_calendar;
mod process_command;
mod user_state;
mod web_host;

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

#[derive(Clone, Debug, PartialEq)]
struct StagedModelCatalog {
    model_gateway_base_url: String,
    models: Vec<Value>,
}

struct Inner {
    child: Option<Arc<Mutex<Child>>>,
    writer: Option<mpsc::Sender<Value>>,
    pending: HashMap<String, mpsc::Sender<Result<Value, String>>>,
    status: RuntimeStatus,
    generation: u64,
    cancelled_start_generation: Option<u64>,
    executor: Option<RunExecutor>,
    staged_model_catalog: Option<StagedModelCatalog>,
}

#[derive(Clone)]
struct PiHost {
    inner: Arc<Mutex<Inner>>,
    next_id: Arc<AtomicU64>,
    credentials: Arc<dyn CredentialStore>,
    web_events: Arc<Mutex<Vec<mpsc::Sender<RuntimeEvent>>>>,
}

impl Default for PiHost {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                child: None,
                writer: None,
                pending: HashMap::new(),
                status: RuntimeStatus::default(),
                generation: 0,
                cancelled_start_generation: None,
                executor: None,
                staged_model_catalog: None,
            })),
            next_id: Arc::new(AtomicU64::new(1)),
            credentials: Arc::new(OsCredentialStore),
            web_events: Arc::new(Mutex::new(Vec::new())),
        }
    }
}

fn mark_start_cancelled(inner: &mut Inner) -> bool {
    if inner.child.is_some() || inner.status.state != RuntimeState::Starting {
        return false;
    }
    inner.cancelled_start_generation = Some(inner.generation);
    inner.status = RuntimeStatus {
        state: RuntimeState::Stopping,
        pid: None,
        detail: None,
    };
    true
}

impl PiHost {
    fn status(&self) -> RuntimeStatus {
        self.inner
            .lock()
            .expect("host lock poisoned")
            .status
            .clone()
    }

    fn emit_runtime_event(&self, app: &AppHandle, event: RuntimeEvent) {
        let _ = app.emit(EVENT_NAME, event.clone());
        if let Ok(mut subscribers) = self.web_events.lock() {
            subscribers.retain(|subscriber| subscriber.send(event.clone()).is_ok());
        }
    }

    fn subscribe_web_events(&self) -> mpsc::Receiver<RuntimeEvent> {
        let (sender, receiver) = mpsc::channel();
        if let Ok(mut subscribers) = self.web_events.lock() {
            subscribers.push(sender);
        }
        receiver
    }

    fn staged_model_catalog(&self) -> Result<Option<StagedModelCatalog>, String> {
        Ok(self
            .inner
            .lock()
            .map_err(|_| "host lock poisoned")?
            .staged_model_catalog
            .clone())
    }

    fn stage_model_catalog(&self, catalog: StagedModelCatalog) -> Result<(), String> {
        self.inner
            .lock()
            .map_err(|_| "host lock poisoned")?
            .staged_model_catalog = Some(catalog);
        Ok(())
    }

    fn discard_staged_model_catalog(&self, expected: Option<&StagedModelCatalog>) {
        if let Ok(mut inner) = self.inner.lock() {
            if expected.is_none() || inner.staged_model_catalog.as_ref() == expected {
                inner.staged_model_catalog = None;
            }
        }
    }

    fn publish(&self, app: &AppHandle, kind: &str, frame: Option<Value>) {
        self.emit_runtime_event(
            app,
            RuntimeEvent {
                kind: kind.into(),
                status: self.status(),
                frame,
            },
        );
    }

    fn start(&self, app: AppHandle) -> Result<RuntimeStatus, String> {
        let generation = self.reserve_start()?;
        self.publish(&app, "status", None);
        let (binary, extension, finance_skill, bundled_bash, settings) =
            match (|| -> Result<_, String> {
                Ok((
                    resolve_pi_binary(&app),
                    resolve_bridge_extension(&app)?,
                    resolve_finance_skill(&app)?,
                    resolve_bundled_bash(&app)?,
                    config::load(&app)?,
                ))
            })() {
                Ok(prepared) => prepared,
                Err(error) => {
                    self.finish_failed_start(&app, generation, &error);
                    return Err(error);
                }
            };
        if !self.start_is_current(generation)? {
            self.finish_cancelled_start(&app, generation);
            return Err("Pi runtime start was cancelled".into());
        }
        let audit_app = app.clone();
        let audit_host = self.clone();
        let audit = Arc::new(move |event: AuditEvent| {
            if let Ok(inner) = audit_host.inner.lock() {
                if inner.generation == generation && inner.status.state == RuntimeState::Running {
                    audit_host.emit_runtime_event(
                        &audit_app,
                        RuntimeEvent {
                            kind: "qveris_audit".into(),
                            status: inner.status.clone(),
                            frame: Some(serde_json::json!({ "audit": event })),
                        },
                    );
                }
            }
        });
        let (executor, bridge) = match RunExecutor::start(
            self.credentials.clone(),
            settings.capability_base_url.clone(),
            settings.model_gateway_base_url.clone(),
            audit,
        ) {
            Ok(started) => started,
            Err(error) => {
                self.finish_failed_start(&app, generation, &error);
                return Err(error);
            }
        };
        if !self.start_is_current(generation)? {
            executor.stop();
            self.finish_cancelled_start(&app, generation);
            return Err("Pi runtime start was cancelled".into());
        }
        let agent_dir = match config::write_pi_config(
            &app,
            &settings,
            &bridge.model_base_url,
            bundled_bash.as_deref(),
        ) {
            Ok(path) => path,
            Err(error) => {
                executor.stop();
                self.finish_failed_start(&app, generation, &error);
                return Err(error);
            }
        };
        if !self.start_is_current(generation)? {
            executor.stop();
            self.finish_cancelled_start(&app, generation);
            return Err("Pi runtime start was cancelled".into());
        }
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
                let error = format!("cannot start Pi RPC runtime: {error}");
                self.finish_failed_start(&app, generation, &error);
                return Err(error);
            }
        };
        let pid = child.id();
        let (stdin, stdout, stderr) =
            match (child.stdin.take(), child.stdout.take(), child.stderr.take()) {
                (Some(stdin), Some(stdout), Some(stderr)) => (stdin, stdout, stderr),
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    executor.stop();
                    let error = "Pi runtime pipes are unavailable";
                    self.finish_failed_start(&app, generation, error);
                    return Err(error.into());
                }
            };
        let child = Arc::new(Mutex::new(child));
        let (writer, writer_rx) = mpsc::channel();
        let installed = {
            let mut inner = self.inner.lock().map_err(|_| "host lock poisoned")?;
            if inner.generation == generation
                && inner.status.state == RuntimeState::Starting
                && inner.cancelled_start_generation != Some(generation)
            {
                inner.child = Some(child.clone());
                inner.writer = Some(writer);
                inner.executor = Some(executor);
                inner.status = RuntimeStatus {
                    state: RuntimeState::Running,
                    pid: Some(pid),
                    detail: None,
                };
                self.spawn_writer(stdin, writer_rx, app.clone(), generation);
                self.spawn_stdout(stdout, app.clone(), generation);
                self.spawn_stderr(stderr, app.clone(), generation);
                self.spawn_watcher(child.clone(), app.clone(), generation);
                let _ = app.emit(
                    EVENT_NAME,
                    RuntimeEvent {
                        kind: "started".into(),
                        status: inner.status.clone(),
                        frame: None,
                    },
                );
                true
            } else {
                false
            }
        };
        if !installed {
            if let Ok(mut process) = child.lock() {
                let _ = process.kill();
                let _ = process.wait();
            }
            self.finish_cancelled_start(&app, generation);
            return Err("Pi runtime start was cancelled".into());
        }
        Ok(self.status())
    }

    fn reserve_start(&self) -> Result<u64, String> {
        let mut inner = self.inner.lock().map_err(|_| "host lock poisoned")?;
        if !matches!(
            inner.status.state,
            RuntimeState::Stopped | RuntimeState::Crashed
        ) {
            return Err("Pi runtime is already active".into());
        }
        inner.generation = inner.generation.wrapping_add(1);
        inner.cancelled_start_generation = None;
        inner.status = RuntimeStatus {
            state: RuntimeState::Starting,
            pid: None,
            detail: None,
        };
        Ok(inner.generation)
    }

    fn start_is_current(&self, generation: u64) -> Result<bool, String> {
        let inner = self.inner.lock().map_err(|_| "host lock poisoned")?;
        Ok(inner.generation == generation
            && inner.status.state == RuntimeState::Starting
            && inner.cancelled_start_generation != Some(generation))
    }

    fn finish_cancelled_start(&self, app: &AppHandle, generation: u64) {
        if let Ok(mut inner) = self.inner.lock() {
            if inner.generation == generation {
                inner.child = None;
                inner.writer = None;
                inner.executor = None;
                inner.cancelled_start_generation = None;
                inner.status = RuntimeStatus::default();
                let _ = app.emit(
                    EVENT_NAME,
                    RuntimeEvent {
                        kind: "stopped".into(),
                        status: inner.status.clone(),
                        frame: None,
                    },
                );
            }
        }
    }

    fn finish_failed_start(&self, app: &AppHandle, generation: u64, error: &str) {
        if let Ok(mut inner) = self.inner.lock() {
            if inner.generation == generation {
                if inner.cancelled_start_generation == Some(generation)
                    || inner.status.state == RuntimeState::Stopping
                {
                    inner.cancelled_start_generation = None;
                    inner.status = RuntimeStatus::default();
                    let _ = app.emit(
                        EVENT_NAME,
                        RuntimeEvent {
                            kind: "stopped".into(),
                            status: inner.status.clone(),
                            frame: None,
                        },
                    );
                } else {
                    inner.status = RuntimeStatus {
                        state: RuntimeState::Crashed,
                        pid: None,
                        detail: Some(error.to_owned()),
                    };
                    let _ = app.emit(
                        EVENT_NAME,
                        RuntimeEvent {
                            kind: "crash".into(),
                            status: inner.status.clone(),
                            frame: None,
                        },
                    );
                }
            }
        }
    }

    fn stop(&self, app: AppHandle) -> Result<RuntimeStatus, String> {
        let (child, executor) = {
            let mut inner = self.inner.lock().map_err(|_| "host lock poisoned")?;
            let resources = if inner.child.is_none() {
                if mark_start_cancelled(&mut inner) {
                    (None, None)
                } else {
                    return Ok(inner.status.clone());
                }
            } else {
                inner.status.state = RuntimeState::Stopping;
                (inner.child.clone(), inner.executor.take())
            };
            let _ = app.emit(
                EVENT_NAME,
                RuntimeEvent {
                    kind: "stopping".into(),
                    status: inner.status.clone(),
                    frame: None,
                },
            );
            resources
        };
        let Some(child) = child else {
            return Ok(self.status());
        };
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
            RuntimeState::Starting | RuntimeState::Running => {
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
        let (generation, child, executor, pending) = {
            let Ok(mut inner) = self.inner.lock() else {
                return;
            };
            let generation = inner.generation;
            mark_start_cancelled(&mut inner);
            inner.status = RuntimeStatus {
                state: RuntimeState::Stopping,
                pid: inner.status.pid,
                detail: None,
            };
            inner.writer = None;
            (
                generation,
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
            if inner.generation == generation {
                inner.status = RuntimeStatus::default();
            }
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
    #[cfg(test)]
    fn is_generation_running(&self, generation: u64) -> bool {
        self.inner.lock().is_ok_and(|inner| {
            inner.generation == generation && inner.status.state == RuntimeState::Running
        })
    }
    fn publish_for_running_generation(
        &self,
        app: &AppHandle,
        generation: u64,
        kind: &str,
        frame: Option<Value>,
    ) {
        let event = self.inner.lock().ok().and_then(|inner| {
            (inner.generation == generation && inner.status.state == RuntimeState::Running).then(
                || RuntimeEvent {
                    kind: kind.into(),
                    status: inner.status.clone(),
                    frame,
                },
            )
        });
        if let Some(event) = event {
            self.emit_runtime_event(app, event);
        }
    }
    fn resolve(&self, generation: u64, id: &str, frame: Value) {
        if let Ok(mut inner) = self.inner.lock() {
            if inner.generation != generation {
                return;
            }
            if let Some(reply) = inner.pending.remove(id) {
                let _ = reply.send(Ok(frame));
            }
        }
    }
    fn fail_all(&self, generation: u64, reason: &str) -> bool {
        if let Ok(mut inner) = self.inner.lock() {
            if inner.generation != generation {
                return false;
            }
            for (_, reply) in inner.pending.drain() {
                let _ = reply.send(Err(reason.into()));
            }
            inner.writer = None;
            return true;
        }
        false
    }
    fn fail_pending(&self, generation: u64, reason: &str) -> bool {
        if let Ok(mut inner) = self.inner.lock() {
            if inner.generation != generation {
                return false;
            }
            for (_, reply) in inner.pending.drain() {
                let _ = reply.send(Err(reason.into()));
            }
            return true;
        }
        false
    }

    fn spawn_writer(
        &self,
        mut stdin: impl Write + Send + 'static,
        rx: mpsc::Receiver<Value>,
        app: AppHandle,
        generation: u64,
    ) {
        let host = self.clone();
        std::thread::spawn(move || {
            for value in rx {
                let encoded = match encode_jsonl(&value) {
                    Ok(v) => v,
                    Err(e) => {
                        host.publish_for_running_generation(
                            &app,
                            generation,
                            "protocol_error",
                            Some(Value::String(e)),
                        );
                        continue;
                    }
                };
                if stdin
                    .write_all(&encoded)
                    .and_then(|_| stdin.flush())
                    .is_err()
                {
                    if host.fail_all(generation, "Pi runtime stdin write failed") {
                        host.publish_for_running_generation(
                            &app,
                            generation,
                            "transport_error",
                            None,
                        );
                    }
                    break;
                }
            }
        });
    }
    fn spawn_stdout(
        &self,
        stdout: impl std::io::Read + Send + 'static,
        app: AppHandle,
        generation: u64,
    ) {
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
                                host.resolve(generation, &id, frame);
                            } else {
                                host.publish_for_running_generation(
                                    &app,
                                    generation,
                                    "event",
                                    Some(frame),
                                );
                            }
                        }
                        Err(error) => {
                            if host.fail_pending(generation, "Pi runtime emitted invalid JSONL") {
                                host.publish_for_running_generation(
                                    &app,
                                    generation,
                                    "protocol_error",
                                    Some(Value::String(error)),
                                );
                            }
                        }
                    },
                    Ok(BoundedLine::TooLong) => {
                        if host
                            .fail_pending(generation, "Pi runtime emitted an oversized JSONL frame")
                        {
                            host.publish_for_running_generation(
                                &app,
                                generation,
                                "protocol_error",
                                Some(Value::String("Pi JSONL frame exceeds 1 MiB".into())),
                            );
                        }
                    }
                    Ok(BoundedLine::Eof) => break,
                    Err(_) => {
                        if host.fail_all(generation, "Pi runtime stdout read failed") {
                            host.publish_for_running_generation(
                                &app,
                                generation,
                                "transport_error",
                                None,
                            );
                        }
                        break;
                    }
                }
            }
        });
    }
    fn spawn_stderr(
        &self,
        stderr: impl std::io::Read + Send + 'static,
        app: AppHandle,
        generation: u64,
    ) {
        let host = self.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stderr);
            loop {
                match read_bounded_line(&mut reader, MAX_DIAGNOSTIC_LINE_BYTES) {
                    Ok(BoundedLine::Line(raw)) => host.publish_for_running_generation(
                        &app,
                        generation,
                        "diagnostic",
                        Some(Value::String(
                            String::from_utf8_lossy(&raw).chars().take(4096).collect(),
                        )),
                    ),
                    Ok(BoundedLine::TooLong) => host.publish_for_running_generation(
                        &app,
                        generation,
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
    fn spawn_watcher(&self, child: Arc<Mutex<Child>>, app: AppHandle, generation: u64) {
        let host = self.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(100));
            let exit = child
                .lock()
                .ok()
                .and_then(|mut child| child.try_wait().ok())
                .flatten();
            if let Some(status) = exit {
                let cleanup = if let Ok(mut inner) = host.inner.lock() {
                    let owns_child = inner.generation == generation
                        && inner
                            .child
                            .as_ref()
                            .is_some_and(|current| Arc::ptr_eq(current, &child));
                    if !owns_child {
                        None
                    } else {
                        let next_state = state_after_process_exit(inner.status.state);
                        let pending = inner
                            .pending
                            .drain()
                            .map(|(_, reply)| reply)
                            .collect::<Vec<_>>();
                        inner.writer = None;
                        inner.child = None;
                        let executor = inner.executor.take();
                        inner.cancelled_start_generation = None;
                        inner.status.state = RuntimeState::Stopping;
                        Some((next_state, pending, executor))
                    }
                } else {
                    None
                };
                if let Some((next_state, pending, executor)) = cleanup {
                    for reply in pending {
                        let _ = reply.send(Err("Pi runtime exited".into()));
                    }
                    if let Some(executor) = executor {
                        executor.stop();
                    }
                    if let Ok(mut inner) = host.inner.lock() {
                        if inner.generation == generation
                            && inner.status.state == RuntimeState::Stopping
                        {
                            let kind = if next_state == RuntimeState::Stopped {
                                inner.status = RuntimeStatus::default();
                                "stopped"
                            } else {
                                inner.status = RuntimeStatus {
                                    state: RuntimeState::Crashed,
                                    pid: None,
                                    detail: Some(status.to_string()),
                                };
                                "crash"
                            };
                            let _ = app.emit(
                                EVENT_NAME,
                                RuntimeEvent {
                                    kind: kind.into(),
                                    status: inner.status.clone(),
                                    frame: None,
                                },
                            );
                        }
                    }
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
    host.credentials.write_qveris_key(&api_key)?;
    host.discard_staged_model_catalog(None);
    Ok(())
}
#[tauri::command]
fn qveris_credential_clear(host: State<'_, PiHost>) -> Result<(), String> {
    host.credentials.delete_qveris_key()?;
    host.discard_staged_model_catalog(None);
    Ok(())
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct IntegrationStatus {
    credential_configured: bool,
    key_prefix: Option<String>,
    settings: IntegrationSettings,
}

fn api_key_prefix(value: Option<String>) -> Option<String> {
    let value = value?.trim().to_owned();
    if value.is_empty() {
        return None;
    }
    let prefix: String = value.chars().take(8).collect();
    Some(if value.chars().count() > 8 {
        format!("{prefix}…")
    } else {
        prefix
    })
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
    let key = host.credentials.read_qveris_key()?;
    Ok(IntegrationStatus {
        credential_configured: key.is_some(),
        key_prefix: api_key_prefix(key),
        settings: config::load(&app)?,
    })
}

fn settings_from_input(
    current: &IntegrationSettings,
    staged: Option<&StagedModelCatalog>,
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
    if let Some(catalog) =
        staged.filter(|catalog| catalog.model_gateway_base_url == model_gateway_base_url)
    {
        settings.models.clone_from(&catalog.models);
    } else if model_gateway_base_url != settings.model_gateway_base_url.trim().trim_end_matches('/')
    {
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
    let staged = host.staged_model_catalog()?;
    let settings = settings_from_input(&previous, staged.as_ref(), input)?;
    let used_staged =
        staged.filter(|catalog| catalog.model_gateway_base_url == settings.model_gateway_base_url);
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
    host.discard_staged_model_catalog(used_staged.as_ref());
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

fn sync_model_catalog(
    host: &PiHost,
    app: &AppHandle,
    input: SettingsInput,
) -> Result<IntegrationSettings, String> {
    let key = host
        .credentials
        .read_qveris_key()?
        .ok_or("QVeris credential is not configured")?;
    let mut settings = config::load(app)?;
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
    let models = executor::fetch_model_catalog(&key, &base_url)?;
    settings.models = models;
    settings.model_id = config::reconcile_model_id(&settings.model_id, &settings.models);
    config::validate_model_selection(&settings)?;
    host.stage_model_catalog(StagedModelCatalog {
        model_gateway_base_url: settings.model_gateway_base_url.clone(),
        models: settings.models.clone(),
    })?;
    Ok(settings)
}

#[tauri::command]
async fn qveris_model_catalog_sync(
    host: State<'_, PiHost>,
    app: AppHandle,
    input: SettingsInput,
) -> Result<IntegrationSettings, String> {
    let host = host.inner().clone();
    tauri::async_runtime::spawn_blocking(move || sync_model_catalog(&host, &app, input))
        .await
        .map_err(|error| format!("model catalog task failed: {error}"))?
}

#[tauri::command]
async fn qveris_trading_calendar(
    host: State<'_, PiHost>,
    app: AppHandle,
    date: String,
    marketcode: Option<String>,
) -> Result<market_calendar::TradingCalendarResult, String> {
    let host = host.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let key = host
            .credentials
            .read_qveris_key()?
            .ok_or("请先配置 QVeris API Key")?;
        let settings = config::load(&app)?;
        market_calendar::fetch_trading_calendar(
            &key,
            &settings.capability_base_url,
            &date,
            marketcode.as_deref(),
        )
    })
    .await
    .map_err(|error| format!("交易日历任务失败: {error}"))?
}

#[tauri::command]
fn user_state_load(app: AppHandle) -> Result<user_state::UserState, String> {
    user_state::load(&app)
}

#[tauri::command]
fn user_state_save(
    app: AppHandle,
    state: user_state::UserState,
    expected_revision: u64,
) -> Result<user_state::UserState, String> {
    user_state::save_if_revision(&app, &state, expected_revision)
}

#[tauri::command]
fn desktop_lifecycle_status(
    lifecycle: State<'_, desktop_lifecycle::DesktopLifecycle>,
) -> desktop_lifecycle::DesktopLifecycleStatus {
    lifecycle.status()
}

#[tauri::command]
fn desktop_window_show(app: AppHandle) -> desktop_lifecycle::DesktopLifecycleStatus {
    desktop_lifecycle::show(&app)
}

#[tauri::command]
fn desktop_reconcile_now(app: AppHandle) -> desktop_lifecycle::DesktopLifecycleStatus {
    desktop_lifecycle::reconcile(&app)
}

#[tauri::command]
fn desktop_quit(app: AppHandle) {
    desktop_lifecycle::quit(&app);
}

fn main() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(desktop_lifecycle::DesktopLifecycle::default())
        .manage(desktop_lifecycle::ResidentTicker::default())
        .setup(|app| {
            desktop_lifecycle::install(app)?;
            app.state::<desktop_lifecycle::ResidentTicker>()
                .start(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    desktop_lifecycle::hide_on_close(window, api);
                }
            }
        });
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    let builder = builder.plugin(tauri_plugin_notification::init());
    let app = builder
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
            qveris_model_catalog_sync,
            qveris_trading_calendar,
            user_state_load,
            user_state_save,
            desktop_lifecycle_status,
            desktop_window_show,
            desktop_reconcile_now,
            desktop_quit
        ])
        .build(tauri::generate_context!())
        .expect("error while building FolioMind");
    let mut web_host =
        match web_host::WebHost::start(app.handle().clone(), (*app.state::<PiHost>()).clone()) {
            Ok(host) => Some(host),
            Err(error) => {
                eprintln!("local web host unavailable: {error}");
                None
            }
        };
    app.run(move |app_handle, event| {
        if matches!(
            event,
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
        ) {
            let lifecycle = app_handle.state::<desktop_lifecycle::DesktopLifecycle>();
            lifecycle.request_exit();
            if lifecycle.begin_cleanup() {
                app_handle
                    .state::<desktop_lifecycle::ResidentTicker>()
                    .stop_and_join();
                if let Some(host) = web_host.as_mut() {
                    host.stop();
                }
                app_handle.state::<PiHost>().shutdown();
            }
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
    fn stop_request_cancels_a_start_before_child_installation() {
        let host = PiHost::default();
        let generation = host.reserve_start().unwrap();
        assert!(!host.is_generation_running(generation));
        {
            let mut inner = host.inner.lock().unwrap();
            inner.status.state = RuntimeState::Running;
        }
        assert!(host.is_generation_running(generation));
        {
            let mut inner = host.inner.lock().unwrap();
            inner.status.state = RuntimeState::Starting;
            assert!(mark_start_cancelled(&mut inner));
            assert_eq!(inner.cancelled_start_generation, Some(generation));
            assert_eq!(inner.status.state, RuntimeState::Stopping);
        }
        assert!(!host.start_is_current(generation).unwrap());
    }
    #[test]
    fn shutdown_keeps_a_start_cancellation_tombstone_until_the_next_generation() {
        let host = PiHost::default();
        let cancelled_generation = host.reserve_start().unwrap();
        host.shutdown();

        assert_eq!(host.status(), RuntimeStatus::default());
        assert_eq!(
            host.inner.lock().unwrap().cancelled_start_generation,
            Some(cancelled_generation)
        );
        assert!(!host.start_is_current(cancelled_generation).unwrap());

        let next_generation = host.reserve_start().unwrap();
        assert_ne!(next_generation, cancelled_generation);
        assert_eq!(host.inner.lock().unwrap().cancelled_start_generation, None);
    }
    #[test]
    fn stale_runtime_threads_cannot_resolve_or_fail_a_new_generation() {
        let host = PiHost::default();
        let stale_generation = host.reserve_start().unwrap();
        {
            let mut inner = host.inner.lock().unwrap();
            inner.status = RuntimeStatus::default();
        }
        let current_generation = host.reserve_start().unwrap();
        assert_ne!(stale_generation, current_generation);

        let (reply, response) = mpsc::channel();
        host.inner
            .lock()
            .unwrap()
            .pending
            .insert("current-request".into(), reply);

        host.resolve(
            stale_generation,
            "current-request",
            serde_json::json!({"id":"current-request","ok":false}),
        );
        assert!(!host.fail_all(stale_generation, "stale runtime failed"));
        assert!(matches!(
            response.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));

        host.resolve(
            current_generation,
            "current-request",
            serde_json::json!({"id":"current-request","ok":true}),
        );
        assert_eq!(
            response
                .recv_timeout(Duration::from_secs(1))
                .unwrap()
                .unwrap()["ok"],
            true
        );
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
            None,
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
            None,
            SettingsInput {
                capability_base_url: "https://qveris.ai/api/v1".into(),
                model_gateway_base_url: "https://other.example.com/v1".into(),
                model_id: "model-a".into(),
            },
        )
        .is_err());
    }

    #[test]
    fn settings_input_accepts_only_the_matching_staged_catalog() {
        let current = IntegrationSettings {
            model_id: "model-a".into(),
            models: vec![serde_json::json!({"id":"model-a"})],
            ..IntegrationSettings::default()
        };
        let staged = StagedModelCatalog {
            model_gateway_base_url: "https://models.example.com/v1".into(),
            models: vec![serde_json::json!({"id":"model-b"})],
        };
        let input = || SettingsInput {
            capability_base_url: "https://qveris.ai/api/v1".into(),
            model_gateway_base_url: "https://models.example.com/v1".into(),
            model_id: "model-b".into(),
        };

        let prepared = settings_from_input(&current, Some(&staged), input()).unwrap();
        assert_eq!(
            prepared.model_gateway_base_url,
            "https://models.example.com/v1"
        );
        assert_eq!(prepared.models, staged.models);
        assert_eq!(prepared.model_id, "model-b");

        assert!(settings_from_input(&current, None, input()).is_err());
        let wrong_staged = StagedModelCatalog {
            model_gateway_base_url: "https://other.example.com/v1".into(),
            models: vec![serde_json::json!({"id":"model-b"})],
        };
        assert!(settings_from_input(&current, Some(&wrong_staged), input()).is_err());

        let refreshed = StagedModelCatalog {
            model_gateway_base_url: current.model_gateway_base_url.clone(),
            models: vec![serde_json::json!({"id":"model-c"})],
        };
        let refreshed_settings = settings_from_input(
            &current,
            Some(&refreshed),
            SettingsInput {
                capability_base_url: current.capability_base_url.clone(),
                model_gateway_base_url: current.model_gateway_base_url.clone(),
                model_id: "model-c".into(),
            },
        )
        .unwrap();
        assert_eq!(refreshed_settings.models, refreshed.models);
    }

    #[test]
    fn staged_catalog_is_cleared_only_when_the_applied_candidate_matches() {
        let host = PiHost::default();
        let staged = StagedModelCatalog {
            model_gateway_base_url: "https://models.example.com/v1".into(),
            models: vec![serde_json::json!({"id":"model-a"})],
        };
        let newer = StagedModelCatalog {
            model_gateway_base_url: "https://newer.example.com/v1".into(),
            models: vec![serde_json::json!({"id":"model-b"})],
        };
        host.stage_model_catalog(newer.clone()).unwrap();

        host.discard_staged_model_catalog(Some(&staged));
        assert_eq!(host.staged_model_catalog().unwrap(), Some(newer.clone()));

        host.discard_staged_model_catalog(Some(&newer));
        assert_eq!(host.staged_model_catalog().unwrap(), None);
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
