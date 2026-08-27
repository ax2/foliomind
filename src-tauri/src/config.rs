use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};
use url::Url;

pub const DEFAULT_CAPABILITY_URL: &str = "https://qveris.ai/api/v1";
pub const DEFAULT_MODEL_GATEWAY_URL: &str = "https://aigateway.qveris.ai/v1";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct IntegrationSettings {
    pub capability_base_url: String,
    pub model_gateway_base_url: String,
    pub model_id: String,
    pub models: Vec<Value>,
}

impl Default for IntegrationSettings {
    fn default() -> Self {
        Self {
            capability_base_url: DEFAULT_CAPABILITY_URL.into(),
            model_gateway_base_url: DEFAULT_MODEL_GATEWAY_URL.into(),
            model_id: String::new(),
            models: Vec::new(),
        }
    }
}

pub fn load(app: &AppHandle) -> Result<IntegrationSettings, String> {
    let path = settings_path(app)?;
    if !path.is_file() {
        let mut settings = IntegrationSettings::default();
        if let Ok(value) = std::env::var("QVERIS_BASE_URL") {
            settings.capability_base_url = value;
        }
        if let Ok(value) = std::env::var("QVERIS_MODEL_GATEWAY_BASE_URL") {
            settings.model_gateway_base_url = value;
        }
        validate(&settings)?;
        return Ok(settings);
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
    let path = settings_path(app)?;
    ensure_parent(&path)?;
    let bytes = serde_json::to_vec_pretty(settings)
        .map_err(|error| format!("cannot encode integration settings: {error}"))?;
    fs::write(path, bytes).map_err(|error| format!("cannot save integration settings: {error}"))
}

pub fn write_pi_config(
    app: &AppHandle,
    settings: &IntegrationSettings,
    local_base_url: &str,
    shell_path: Option<&Path>,
) -> Result<PathBuf, String> {
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
    fs::write(&path, bytes).map_err(|error| format!("cannot write Pi model config: {error}"))?;
    let settings_path = agent_dir.join("settings.json");
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
    fs::write(settings_path, bytes)
        .map_err(|error| format!("cannot write Pi settings: {error}"))?;
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
    if settings.model_id.len() > 256 {
        return Err("model ID is too long".into());
    }
    if settings.models.len() > 500 {
        return Err("model catalog is too large".into());
    }
    Ok(())
}

fn validate_url(value: &str, label: &str) -> Result<(), String> {
    let url = Url::parse(value.trim()).map_err(|_| format!("{label} is invalid"))?;
    if !matches!(url.scheme(), "http" | "https") || url.username() != "" || url.password().is_some()
    {
        return Err(format!(
            "{label} must be an HTTP(S) URL without credentials"
        ));
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_point_to_distinct_qveris_services() {
        let value = IntegrationSettings::default();
        assert_eq!(value.capability_base_url, "https://qveris.ai/api/v1");
        assert_eq!(
            value.model_gateway_base_url,
            "https://aigateway.qveris.ai/v1"
        );
    }

    #[test]
    fn rejects_credentials_in_endpoint_urls() {
        let mut value = IntegrationSettings::default();
        value.model_gateway_base_url = "https://token@example.com/v1".into();
        assert!(validate(&value).is_err());
    }
}
