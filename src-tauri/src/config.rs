use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{AppHandle, Manager};
use url::{Host, Url};
use uuid::Uuid;

#[cfg(unix)]
use std::{
    fs::File,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
};

pub const DEFAULT_CAPABILITY_URL: &str = "https://qveris.ai/api/v1";
pub const DEFAULT_MODEL_GATEWAY_URL: &str = "https://aigateway.qveris.ai/v1";
pub const DEFAULT_DATA_CHANNEL: &str = "qveris-cap";
pub const DEFAULT_DATA_PROVIDER: &str = "qveris_finance";
pub const MAX_MODEL_CATALOG_ITEMS: usize = 500;
pub const MAX_MODEL_ID_BYTES: usize = 256;
const MAX_DATA_SELECTOR_BYTES: usize = 128;
const MAX_SETTINGS_BYTES: u64 = 2 * 1024 * 1024;
static CONFIG_IO_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct IntegrationSettings {
    pub capability_base_url: String,
    pub model_gateway_base_url: String,
    pub model_id: String,
    pub models: Vec<Value>,
    pub data_channel: String,
    pub data_provider: String,
}

impl Default for IntegrationSettings {
    fn default() -> Self {
        Self {
            capability_base_url: DEFAULT_CAPABILITY_URL.into(),
            model_gateway_base_url: DEFAULT_MODEL_GATEWAY_URL.into(),
            model_id: String::new(),
            models: Vec::new(),
            data_channel: DEFAULT_DATA_CHANNEL.into(),
            data_provider: DEFAULT_DATA_PROVIDER.into(),
        }
    }
}

pub fn load(app: &AppHandle) -> Result<IntegrationSettings, String> {
    let _guard = CONFIG_IO_LOCK
        .lock()
        .map_err(|_| "configuration I/O lock poisoned")?;
    let path = settings_path(app)?;
    recover_backup(&path, "integration settings")?;
    if !path.is_file() {
        let mut settings = IntegrationSettings::default();
        if let Ok(value) = std::env::var("QVERIS_BASE_URL") {
            settings.capability_base_url = normalize_base_url(&value);
        }
        if let Ok(value) = std::env::var("QVERIS_MODEL_GATEWAY_BASE_URL") {
            settings.model_gateway_base_url = normalize_base_url(&value);
        }
        validate(&settings)?;
        return Ok(settings);
    }
    let size = fs::metadata(&path)
        .map_err(|error| format!("cannot inspect integration settings: {error}"))?
        .len();
    if size > MAX_SETTINGS_BYTES {
        return Err("integration settings exceed size limit".into());
    }
    let bytes =
        fs::read(path).map_err(|error| format!("cannot read integration settings: {error}"))?;
    let settings: IntegrationSettings = serde_json::from_slice(&bytes)
        .map_err(|_| "integration settings are invalid".to_string())?;
    validate(&settings)?;
    Ok(settings)
}

pub fn save(app: &AppHandle, settings: &IntegrationSettings) -> Result<(), String> {
    validate(settings)?;
    let bytes = serde_json::to_vec_pretty(settings)
        .map_err(|error| format!("cannot encode integration settings: {error}"))?;
    if bytes.len() as u64 > MAX_SETTINGS_BYTES {
        return Err("integration settings exceed size limit".into());
    }
    let _guard = CONFIG_IO_LOCK
        .lock()
        .map_err(|_| "configuration I/O lock poisoned")?;
    atomic_write(&settings_path(app)?, &bytes, "integration settings")
}

pub fn write_pi_config(
    app: &AppHandle,
    settings: &IntegrationSettings,
    local_base_url: &str,
    shell_path: Option<&Path>,
) -> Result<PathBuf, String> {
    validate_model_selection(settings)?;
    let _guard = CONFIG_IO_LOCK
        .lock()
        .map_err(|_| "configuration I/O lock poisoned")?;
    let agent_dir = pi_agent_dir(app)?;
    fs::create_dir_all(&agent_dir)
        .map_err(|error| format!("cannot create Pi config directory: {error}"))?;
    let document = json!({
        "providers": {
            "qveris": {
                "baseUrl": local_base_url.trim_end_matches('/'),
                "api": "openai-completions",
                "apiKey": "FOLIOMIND_MODEL_TOKEN",
                "authHeader": true,
                "models": settings.models,
            }
        }
    });
    let path = agent_dir.join("models.json");
    let bytes = serde_json::to_vec_pretty(&document)
        .map_err(|error| format!("cannot encode Pi model config: {error}"))?;
    atomic_write(&path, &bytes, "Pi model config")?;
    let settings_path = agent_dir.join("settings.json");
    recover_backup(&settings_path, "Pi settings")?;
    let mut pi_settings = if settings_path.is_file() {
        serde_json::from_slice::<Value>(
            &fs::read(&settings_path)
                .map_err(|error| format!("cannot read Pi settings: {error}"))?,
        )
        .map_err(|_| "Pi settings are invalid".to_string())?
    } else {
        json!({})
    };
    if let Some(shell_path) = shell_path {
        pi_settings
            .as_object_mut()
            .ok_or("Pi settings must be an object")?
            .insert(
                "shellPath".into(),
                Value::String(shell_path.to_string_lossy().into_owned()),
            );
    }
    let bytes = serde_json::to_vec_pretty(&pi_settings)
        .map_err(|error| format!("cannot encode Pi settings: {error}"))?;
    atomic_write(&settings_path, &bytes, "Pi settings")?;
    Ok(agent_dir)
}

pub fn pi_agent_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|error| format!("cannot resolve app config directory: {error}"))?
        .join("pi-agent"))
}

pub fn validate(settings: &IntegrationSettings) -> Result<(), String> {
    validate_url(&settings.capability_base_url, "QVeris capability URL")?;
    validate_url(&settings.model_gateway_base_url, "QVeris model gateway URL")?;
    if settings.model_id.len() > MAX_MODEL_ID_BYTES
        || settings.model_id != settings.model_id.trim()
        || settings.model_id.chars().any(char::is_control)
    {
        return Err("model ID is invalid".into());
    }
    if settings.models.len() > MAX_MODEL_CATALOG_ITEMS {
        return Err("model catalog is too large".into());
    }
    validate_data_selector(&settings.data_channel, "data channel")?;
    validate_data_selector(&settings.data_provider, "data provider")?;
    let mut model_ids = HashSet::with_capacity(settings.models.len());
    for model in &settings.models {
        let id = model
            .get("id")
            .and_then(Value::as_str)
            .ok_or("model catalog contains an invalid model")?;
        if id.is_empty()
            || id != id.trim()
            || id.len() > MAX_MODEL_ID_BYTES
            || id.chars().any(char::is_control)
        {
            return Err("model catalog contains an invalid model ID".into());
        }
        if !model_ids.insert(id) {
            return Err("model catalog contains duplicate model IDs".into());
        }
    }
    Ok(())
}

fn validate_data_selector(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || value != value.trim()
        || value.len() > MAX_DATA_SELECTOR_BYTES
        || value.chars().any(char::is_control)
        || !value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | ':')
        })
    {
        return Err(format!("{label} is invalid"));
    }
    Ok(())
}

pub fn reconcile_model_id(current: &str, models: &[Value]) -> String {
    let current = current.trim();
    if models
        .iter()
        .any(|model| model.get("id").and_then(Value::as_str) == Some(current))
    {
        return current.to_owned();
    }
    models
        .first()
        .and_then(|model| model.get("id"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

pub fn validate_model_selection(settings: &IntegrationSettings) -> Result<(), String> {
    if settings.model_id.is_empty() {
        return Ok(());
    }
    if settings
        .models
        .iter()
        .any(|model| model.get("id").and_then(Value::as_str) == Some(settings.model_id.as_str()))
    {
        return Ok(());
    }
    Err("selected model is not available; sync the QVeris model catalog".into())
}

fn validate_url(value: &str, label: &str) -> Result<(), String> {
    if value != value.trim() {
        return Err(format!("{label} must not contain surrounding whitespace"));
    }
    let url = Url::parse(value).map_err(|_| format!("{label} is invalid"))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.username() != ""
        || url.password().is_some()
        || url.host_str().is_none()
    {
        return Err(format!(
            "{label} must be an HTTP(S) URL without credentials"
        ));
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(format!("{label} must not contain a query or fragment"));
    }
    let loopback = match url.host() {
        Some(Host::Domain(host)) => host.eq_ignore_ascii_case("localhost"),
        Some(Host::Ipv4(address)) => address.is_loopback(),
        Some(Host::Ipv6(address)) => address.is_loopback(),
        None => false,
    };
    if url.scheme() != "https" && !loopback {
        return Err(format!("{label} must use HTTPS unless it is loopback"));
    }
    Ok(())
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|error| format!("cannot resolve app config directory: {error}"))?
        .join("integrations.json"))
}

fn ensure_parent(path: &Path) -> Result<(), String> {
    let parent = path.parent().ok_or("settings path has no parent")?;
    fs::create_dir_all(parent).map_err(|error| format!("cannot create settings directory: {error}"))
}

fn normalize_base_url(value: &str) -> String {
    value.trim().trim_end_matches('/').to_owned()
}

fn sibling_with_suffix(path: &Path, suffix: &str) -> Result<PathBuf, String> {
    let mut name = path
        .file_name()
        .ok_or("configuration path has no file name")?
        .to_os_string();
    name.push(suffix);
    Ok(path.with_file_name(name))
}

fn backup_path(path: &Path) -> Result<PathBuf, String> {
    sibling_with_suffix(path, ".backup")
}

fn recover_backup(path: &Path, label: &str) -> Result<(), String> {
    if path.is_file() {
        return Ok(());
    }
    let backup = backup_path(path)?;
    if backup.is_file() {
        fs::rename(&backup, path)
            .map_err(|error| format!("cannot recover {label} backup: {error}"))?;
    }
    Ok(())
}

fn atomic_write(path: &Path, bytes: &[u8], label: &str) -> Result<(), String> {
    ensure_parent(path)?;
    let temporary = sibling_with_suffix(path, &format!(".tmp-{}", Uuid::new_v4()))?;
    let backup = backup_path(path)?;
    let write_result = (|| -> Result<(), String> {
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options
            .open(&temporary)
            .map_err(|error| format!("cannot create temporary {label}: {error}"))?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("cannot write temporary {label}: {error}"))?;
        drop(file);
        #[cfg(unix)]
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("cannot protect temporary {label}: {error}"))?;

        if backup.exists() {
            fs::remove_file(&backup)
                .map_err(|error| format!("cannot remove stale {label} backup: {error}"))?;
        }
        let had_previous = path.is_file();
        if had_previous {
            fs::rename(path, &backup)
                .map_err(|error| format!("cannot back up previous {label}: {error}"))?;
        }
        if let Err(error) = fs::rename(&temporary, path) {
            let recovery = if had_previous {
                fs::rename(&backup, path).err()
            } else {
                None
            };
            return Err(match recovery {
                Some(recovery) => format!(
                    "cannot replace {label}: {error}; previous file recovery failed: {recovery}"
                ),
                None => format!("cannot replace {label}: {error}"),
            });
        }
        if had_previous {
            let _ = fs::remove_file(&backup);
        }
        if let Some(parent) = path.parent() {
            sync_directory(parent);
        }
        Ok(())
    })();
    if temporary.exists() {
        let _ = fs::remove_file(&temporary);
    }
    write_result
}

#[cfg(unix)]
fn sync_directory(path: &Path) {
    if let Ok(directory) = File::open(path) {
        let _ = directory.sync_all();
    }
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn defaults_point_to_distinct_qveris_services() {
        let value = IntegrationSettings::default();
        assert_eq!(value.capability_base_url, "https://qveris.ai/api/v1");
        assert_eq!(
            value.model_gateway_base_url,
            "https://aigateway.qveris.ai/v1"
        );
        assert_eq!(value.data_channel, DEFAULT_DATA_CHANNEL);
        assert_eq!(value.data_provider, DEFAULT_DATA_PROVIDER);
    }

    #[test]
    fn validates_data_channel_and_provider_selectors() {
        let mut value = IntegrationSettings::default();
        value.data_channel = "cap-compatible".into();
        value.data_provider = "custom_finance.v1".into();
        assert!(validate(&value).is_ok());
        value.data_provider = "provider with spaces".into();
        assert!(validate(&value).is_err());
        value.data_provider = "provider/with/slash".into();
        assert!(validate(&value).is_err());
    }

    #[test]
    fn rejects_credentials_in_endpoint_urls() {
        let value = IntegrationSettings {
            model_gateway_base_url: "https://token@example.com/v1".into(),
            ..IntegrationSettings::default()
        };
        assert!(validate(&value).is_err());
    }

    #[test]
    fn requires_https_for_remote_endpoints_but_allows_loopback_http() {
        assert!(validate_url("http://api.example.com/v1", "endpoint").is_err());
        assert!(validate_url("http://127.0.0.1:9002/v1", "endpoint").is_ok());
        assert!(validate_url("http://[::1]:9002/v1", "endpoint").is_ok());
        assert!(validate_url("https://api.example.com/v1", "endpoint").is_ok());
    }

    #[test]
    fn rejects_endpoint_query_and_fragment_components() {
        assert!(validate_url("https://api.example.com/v1?token=value", "endpoint").is_err());
        assert!(validate_url("https://api.example.com/v1#fragment", "endpoint").is_err());
        assert!(validate_url(" https://api.example.com/v1 ", "endpoint").is_err());
    }

    #[test]
    fn keeps_an_available_model_and_falls_back_when_it_disappears() {
        let models = vec![json!({"id":"model-a"}), json!({"id":"model-b"})];
        assert_eq!(reconcile_model_id("model-b", &models), "model-b");
        assert_eq!(reconcile_model_id("retired-model", &models), "model-a");
        assert_eq!(reconcile_model_id("model-a", &[]), "");
    }

    #[test]
    fn rejects_a_selected_model_outside_the_synced_catalog() {
        let available = IntegrationSettings {
            model_id: "model-a".into(),
            models: vec![json!({"id":"model-a"})],
            ..IntegrationSettings::default()
        };
        assert!(validate_model_selection(&available).is_ok());
        let stale = IntegrationSettings {
            model_id: "retired-model".into(),
            ..available
        };
        assert!(validate_model_selection(&stale).is_err());
    }

    #[test]
    fn rejects_malformed_and_duplicate_model_catalog_entries() {
        for models in [
            vec![json!({"name":"missing id"})],
            vec![json!({"id":" model-a"})],
            vec![json!({"id":"model\ncontrol"})],
            vec![json!({"id":"model-a"}), json!({"id":"model-a"})],
        ] {
            let settings = IntegrationSettings {
                models,
                ..IntegrationSettings::default()
            };
            assert!(validate(&settings).is_err());
        }
    }

    #[test]
    fn accepts_a_unique_bounded_model_catalog() {
        let settings = IntegrationSettings {
            model_id: "model-b".into(),
            models: vec![json!({"id":"model-a"}), json!({"id":"model-b"})],
            ..IntegrationSettings::default()
        };
        assert!(validate(&settings).is_ok());
        assert!(validate_model_selection(&settings).is_ok());
    }

    #[test]
    fn atomic_write_replaces_complete_files_without_leaving_a_backup() {
        let directory = std::env::temp_dir().join(format!("foliomind-config-{}", Uuid::new_v4()));
        let path = directory.join("integrations.json");
        atomic_write(&path, b"first", "test config").unwrap();
        atomic_write(&path, b"second", "test config").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"second");
        assert!(!backup_path(&path).unwrap().exists());
        fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn atomic_write_protects_private_configuration_files() {
        let directory =
            std::env::temp_dir().join(format!("foliomind-config-mode-{}", Uuid::new_v4()));
        let path = directory.join("integrations.json");
        atomic_write(&path, b"{}", "test config").unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn missing_primary_file_recovers_the_last_backup() {
        let directory = std::env::temp_dir().join(format!("foliomind-config-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("integrations.json");
        let backup = backup_path(&path).unwrap();
        fs::write(&backup, b"last-known-good").unwrap();
        recover_backup(&path, "test config").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"last-known-good");
        assert!(!backup.exists());
        fs::remove_dir_all(directory).unwrap();
    }
}
