use serde::{Deserialize, Serialize};
use std::{fs, io::Write, path::PathBuf, sync::Mutex};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

const FILE_NAME: &str = "user-state.json";
const MAX_BYTES: u64 = 4 * 1024 * 1024;
const MAX_WATCHLIST: usize = 200;
const MAX_RULES: usize = 200;
const MAX_NOTIFICATIONS: usize = 500;
const MAX_PORTFOLIO_POSITIONS: usize = 200;
static STATE_IO_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchItem {
    pub symbol: String,
    pub name: String,
    pub market: String,
    pub category: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorRule {
    pub id: String,
    pub symbol: String,
    pub strategy_id: String,
    pub threshold: f64,
    pub interval_seconds: u64,
    pub enabled: bool,
    pub last_checked_at: Option<String>,
    pub last_triggered_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Notification {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub body: String,
    pub severity: String,
    pub created_at: String,
    pub read: bool,
    pub source: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortfolioPosition {
    pub id: String,
    pub symbol: String,
    pub name: String,
    pub market: String,
    pub quantity: f64,
    pub average_cost: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserState {
    pub watchlist: Vec<WatchItem>,
    pub monitor_rules: Vec<MonitorRule>,
    pub notifications: Vec<Notification>,
    #[serde(default)]
    pub portfolio_positions: Vec<PortfolioPosition>,
}

impl Default for UserState {
    fn default() -> Self {
        Self {
            watchlist: vec![
                WatchItem {
                    symbol: "600519".into(),
                    name: "贵州茅台".into(),
                    market: "沪深".into(),
                    category: "白酒".into(),
                },
                WatchItem {
                    symbol: "300750".into(),
                    name: "宁德时代".into(),
                    market: "深市".into(),
                    category: "新能源".into(),
                },
            ],
            monitor_rules: vec![
                MonitorRule {
                    id: "r1".into(),
                    symbol: "600519".into(),
                    strategy_id: "price_change".into(),
                    threshold: 3.0,
                    interval_seconds: 300,
                    enabled: true,
                    last_checked_at: None,
                    last_triggered_at: None,
                },
                MonitorRule {
                    id: "r2".into(),
                    symbol: "300750".into(),
                    strategy_id: "news_risk".into(),
                    threshold: 1.0,
                    interval_seconds: 600,
                    enabled: true,
                    last_checked_at: None,
                    last_triggered_at: None,
                },
            ],
            notifications: Vec::new(),
            portfolio_positions: Vec::new(),
        }
    }
}

fn path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|error| format!("cannot resolve app config directory: {error}"))?
        .join(FILE_NAME))
}

fn validate_text(value: &str, label: &str, max: usize) -> Result<(), String> {
    if value.trim().is_empty()
        || value != value.trim()
        || value.chars().any(char::is_control)
        || value.chars().count() > max
    {
        return Err(format!("{label} is invalid"));
    }
    Ok(())
}

pub fn validate(state: &UserState) -> Result<(), String> {
    if state.watchlist.len() > MAX_WATCHLIST
        || state.monitor_rules.len() > MAX_RULES
        || state.notifications.len() > MAX_NOTIFICATIONS
        || state.portfolio_positions.len() > MAX_PORTFOLIO_POSITIONS
    {
        return Err("user state exceeds size limit".into());
    }
    for item in &state.watchlist {
        validate_text(&item.symbol, "watchlist symbol", 64)?;
        validate_text(&item.name, "watchlist name", 128)?;
        validate_text(&item.market, "watchlist market", 64)?;
        validate_text(&item.category, "watchlist category", 64)?;
    }
    for rule in &state.monitor_rules {
        validate_text(&rule.id, "monitor rule id", 64)?;
        validate_text(&rule.symbol, "monitor rule symbol", 64)?;
        validate_text(&rule.strategy_id, "monitor strategy", 64)?;
        if !rule.threshold.is_finite()
            || rule.threshold < 0.0
            || rule.threshold > 1_000_000.0
            || !(15..=86_400).contains(&rule.interval_seconds)
        {
            return Err("monitor rule value is invalid".into());
        }
    }
    for notification in &state.notifications {
        validate_text(&notification.id, "notification id", 64)?;
        validate_text(&notification.kind, "notification kind", 32)?;
        validate_text(&notification.title, "notification title", 256)?;
        validate_text(&notification.body, "notification body", 4096)?;
        validate_text(&notification.severity, "notification severity", 32)?;
        validate_text(&notification.created_at, "notification timestamp", 64)?;
    }
    for position in &state.portfolio_positions {
        validate_text(&position.id, "portfolio position id", 64)?;
        validate_text(&position.symbol, "portfolio position symbol", 64)?;
        validate_text(&position.name, "portfolio position name", 128)?;
        validate_text(&position.market, "portfolio position market", 64)?;
        if !position.quantity.is_finite()
            || position.quantity <= 0.0
            || position.quantity > 1_000_000_000.0
            || !position.average_cost.is_finite()
            || position.average_cost <= 0.0
            || position.average_cost > 1_000_000_000.0
        {
            return Err("portfolio position value is invalid".into());
        }
    }
    Ok(())
}

pub fn load(app: &AppHandle) -> Result<UserState, String> {
    let _guard = STATE_IO_LOCK
        .lock()
        .map_err(|_| "user state I/O lock poisoned")?;
    let file = path(app)?;
    if !file.is_file() {
        return Ok(UserState::default());
    }
    let size = fs::metadata(&file)
        .map_err(|error| format!("cannot inspect user state: {error}"))?
        .len();
    if size > MAX_BYTES {
        return Err("user state exceeds size limit".into());
    }
    let bytes = fs::read(&file).map_err(|error| format!("cannot read user state: {error}"))?;
    let state = serde_json::from_slice::<UserState>(&bytes)
        .map_err(|_| "user state is invalid".to_string())?;
    validate(&state)?;
    Ok(state)
}

pub fn save(app: &AppHandle, state: &UserState) -> Result<UserState, String> {
    validate(state)?;
    let bytes = serde_json::to_vec_pretty(state)
        .map_err(|error| format!("cannot encode user state: {error}"))?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("user state exceeds size limit".into());
    }
    let _guard = STATE_IO_LOCK
        .lock()
        .map_err(|_| "user state I/O lock poisoned")?;
    let file = path(app)?;
    let parent = file.parent().ok_or("user state directory is unavailable")?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("cannot create user state directory: {error}"))?;
    let temp = parent.join(format!(".{FILE_NAME}.{}.tmp", Uuid::new_v4()));
    {
        let mut handle = fs::File::create(&temp)
            .map_err(|error| format!("cannot create user state temp file: {error}"))?;
        handle
            .write_all(&bytes)
            .map_err(|error| format!("cannot write user state: {error}"))?;
        handle
            .sync_all()
            .map_err(|error| format!("cannot sync user state: {error}"))?;
    }
    fs::rename(&temp, &file).map_err(|error| {
        let _ = fs::remove_file(&temp);
        format!("cannot replace user state: {error}")
    })?;
    Ok(state.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_valid() {
        assert!(validate(&UserState::default()).is_ok());
    }

    #[test]
    fn invalid_threshold_is_rejected() {
        let mut state = UserState::default();
        state.monitor_rules[0].threshold = f64::NAN;
        assert!(validate(&state).is_err());
    }
}
