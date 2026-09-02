use chrono::DateTime;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

const FILE_NAME: &str = "user-state.json";
const STATE_LOCK_FILE_NAME: &str = ".user-state.json.lock";
const STATE_LOCK_TIMEOUT: Duration = Duration::from_secs(5);
const STATE_LOCK_STALE_AFTER: Duration = Duration::from_secs(30);
const STATE_LOCK_RETRY: Duration = Duration::from_millis(25);
const MAX_BYTES: u64 = 4 * 1024 * 1024;
const MAX_WATCHLIST: usize = 200;
const MAX_RULES: usize = 200;
const MAX_NOTIFICATIONS: usize = 500;
const MAX_PORTFOLIO_POSITIONS: usize = 200;
const MAX_MONITOR_HISTORY: usize = 500;
const MAX_PORTFOLIO_REVIEWS: usize = 90;
const MAX_INSTALLED_SKILLS: usize = 100;
static STATE_IO_LOCK: Mutex<()> = Mutex::new(());

struct StateFileLock {
    path: PathBuf,
    token: String,
}

impl Drop for StateFileLock {
    fn drop(&mut self) {
        if fs::read_to_string(&self.path)
            .map(|contents| contents == self.token)
            .unwrap_or(false)
        {
            let _ = fs::remove_file(&self.path);
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchItem {
    pub symbol: String,
    pub name: String,
    pub market: String,
    pub category: String,
    pub group: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WatchItemDocument {
    symbol: String,
    name: String,
    market: String,
    category: String,
    #[serde(default)]
    group: Option<String>,
}

fn watchlist_group_for_market(market: &str) -> &'static str {
    let value = market.to_uppercase();
    if value.contains("NASDAQ")
        || value.contains("NYSE")
        || value.contains("AMEX")
        || value.contains("美股")
        || value == "US"
    {
        return "美股";
    }
    if value.contains("HKEX") || value.contains("港股") || value.contains("香港") || value == "HK"
    {
        return "港股";
    }
    if value.contains('沪')
        || value.contains('深')
        || value.contains("A股")
        || value.contains("SH")
        || value.contains("SS")
        || value.contains("SZ")
        || value.contains("BJ")
    {
        return "A股";
    }
    "自选"
}

impl<'de> Deserialize<'de> for WatchItem {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let document = WatchItemDocument::deserialize(deserializer)?;
        let group = document
            .group
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| watchlist_group_for_market(&document.market).into());
        Ok(Self {
            symbol: document.symbol,
            name: document.name,
            market: document.market,
            category: document.category,
            group,
        })
    }
}

fn default_logic() -> String {
    "AND".into()
}

fn default_scope() -> String {
    "symbol".into()
}

fn default_trigger_mode() -> String {
    "edge".into()
}

fn default_installed_skill_ids() -> Vec<String> {
    vec!["fundamental".into(), "monitor".into()]
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorRule {
    pub id: String,
    #[serde(default = "default_scope")]
    pub scope: String,
    pub symbol: String,
    pub strategy_id: String,
    pub threshold: f64,
    pub interval_seconds: u64,
    pub enabled: bool,
    pub last_checked_at: Option<String>,
    pub last_triggered_at: Option<String>,
    #[serde(default)]
    pub conditions: Vec<serde_json::Value>,
    #[serde(default = "default_logic")]
    pub logic: String,
    #[serde(default)]
    pub last_signal_triggered: Option<bool>,
    #[serde(default)]
    pub last_signal_by_symbol: HashMap<String, bool>,
    #[serde(default = "default_trigger_mode")]
    pub trigger_mode: String,
    #[serde(default)]
    pub expires_at: Option<String>,
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
    #[serde(default)]
    pub symbol: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub rule_id: String,
    #[serde(default)]
    pub event_key: String,
    #[serde(default)]
    pub reminder_phase: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanAction {
    pub id: String,
    #[serde(rename = "type")]
    pub action_type: String,
    pub at: String,
    pub note: String,
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
    #[serde(default)]
    pub take_profit_price: Option<f64>,
    #[serde(default)]
    pub stop_loss_price: Option<f64>,
    #[serde(default)]
    pub take_profit_triggered: bool,
    #[serde(default)]
    pub stop_loss_triggered: bool,
    #[serde(default)]
    pub plan_thesis: String,
    #[serde(default)]
    pub plan_horizon: Option<String>,
    #[serde(default)]
    pub plan_status: Option<String>,
    #[serde(default)]
    pub plan_created_at: Option<String>,
    #[serde(default)]
    pub plan_updated_at: Option<String>,
    #[serde(default)]
    pub plan_actions: Vec<PlanAction>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    #[serde(default)]
    pub operation: String,
    #[serde(default)]
    pub outcome: String,
    #[serde(default)]
    pub tool_id: String,
    #[serde(default)]
    pub capability: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorHistoryEntry {
    pub id: String,
    pub rule_id: String,
    pub symbol: String,
    pub checked_at: String,
    pub outcome: String,
    #[serde(default)]
    pub triggered: Option<bool>,
    pub title: String,
    pub summary: String,
    pub severity: String,
    pub source: String,
    pub as_of: String,
    #[serde(default)]
    pub condition_results: Vec<Option<bool>>,
    #[serde(default)]
    pub audits: Vec<AuditEntry>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPosition {
    pub symbol: String,
    pub name: String,
    pub current_price: f64,
    pub pnl: Option<f64>,
    pub pnl_percent: Option<f64>,
    pub weight: Option<f64>,
    pub as_of: String,
    pub source: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRiskSignal {
    pub level: String,
    pub title: String,
    pub detail: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewEvent {
    pub symbol: String,
    pub name: String,
    pub date: String,
    #[serde(rename = "type")]
    pub event_type: String,
    pub title: String,
    pub source: String,
    pub url: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortfolioReview {
    pub id: String,
    pub kind: String,
    pub trading_date: String,
    pub created_at: String,
    pub as_of: String,
    pub priced_count: u64,
    pub total_count: u64,
    pub total_cost: Option<f64>,
    pub total_market_value: Option<f64>,
    pub total_pnl: Option<f64>,
    pub total_pnl_percent: Option<f64>,
    pub top_gainer: Option<ReviewPosition>,
    pub top_loser: Option<ReviewPosition>,
    #[serde(default)]
    pub positions: Vec<ReviewPosition>,
    #[serde(default)]
    pub risk_signals: Vec<ReviewRiskSignal>,
    #[serde(default)]
    pub upcoming_events: Vec<ReviewEvent>,
    #[serde(default)]
    pub sources: Vec<String>,
    pub disclaimer: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BriefingSchedule {
    pub enabled: bool,
    pub close_time: String,
    pub time_zone: String,
    pub retry_minutes: u64,
    pub last_attempt_at: String,
    pub last_success_key: String,
    pub last_result: String,
    pub last_error: String,
    #[serde(default)]
    pub calendar_date: String,
    #[serde(default = "default_calendar_status")]
    pub calendar_status: String,
    #[serde(default)]
    pub calendar_checked_at: String,
    #[serde(default)]
    pub calendar_source: String,
    #[serde(default)]
    pub calendar_tool_id: String,
}

fn default_calendar_status() -> String {
    "unknown".into()
}

impl Default for BriefingSchedule {
    fn default() -> Self {
        Self {
            enabled: false,
            close_time: "15:35".into(),
            time_zone: "Asia/Shanghai".into(),
            retry_minutes: 15,
            last_attempt_at: String::new(),
            last_success_key: String::new(),
            last_result: "idle".into(),
            last_error: String::new(),
            calendar_date: String::new(),
            calendar_status: default_calendar_status(),
            calendar_checked_at: String::new(),
            calendar_source: String::new(),
            calendar_tool_id: String::new(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserState {
    #[serde(default)]
    pub revision: u64,
    pub watchlist: Vec<WatchItem>,
    pub monitor_rules: Vec<MonitorRule>,
    pub notifications: Vec<Notification>,
    #[serde(default)]
    pub portfolio_positions: Vec<PortfolioPosition>,
    #[serde(default)]
    pub monitor_history: Vec<MonitorHistoryEntry>,
    #[serde(default)]
    pub portfolio_reviews: Vec<PortfolioReview>,
    #[serde(default)]
    pub briefing_schedule: BriefingSchedule,
    #[serde(default = "default_installed_skill_ids")]
    pub installed_skill_ids: Vec<String>,
}

impl Default for UserState {
    fn default() -> Self {
        Self {
            revision: 0,
            watchlist: vec![
                WatchItem {
                    symbol: "600519".into(),
                    name: "贵州茅台".into(),
                    market: "沪深".into(),
                    category: "白酒".into(),
                    group: "A股".into(),
                },
                WatchItem {
                    symbol: "300750".into(),
                    name: "宁德时代".into(),
                    market: "深市".into(),
                    category: "新能源".into(),
                    group: "A股".into(),
                },
            ],
            // Alerts are user-created actions. Starting with none prevents a
            // first-run credential save from silently triggering billable
            // background checks.
            monitor_rules: Vec::new(),
            notifications: Vec::new(),
            portfolio_positions: Vec::new(),
            monitor_history: Vec::new(),
            portfolio_reviews: Vec::new(),
            briefing_schedule: BriefingSchedule::default(),
            installed_skill_ids: default_installed_skill_ids(),
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

fn state_lock_path(file: &Path) -> PathBuf {
    file.parent()
        .unwrap_or_else(|| std::path::Path::new("."))
        .join(STATE_LOCK_FILE_NAME)
}

fn acquire_state_file_lock(file: &Path) -> Result<StateFileLock, String> {
    let parent = file.parent().ok_or("user state directory is unavailable")?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("cannot create user state directory: {error}"))?;
    let lock_path = state_lock_path(file);
    let token = format!("{}:{}", std::process::id(), Uuid::new_v4());
    let started_at = Instant::now();
    loop {
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&lock_path)
        {
            Ok(mut handle) => {
                if let Err(error) = handle
                    .write_all(token.as_bytes())
                    .and_then(|_| handle.sync_all())
                {
                    let _ = fs::remove_file(&lock_path);
                    return Err(format!("cannot initialize user state lock: {error}"));
                }
                return Ok(StateFileLock {
                    path: lock_path,
                    token,
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let stale = fs::metadata(&lock_path)
                    .and_then(|metadata| metadata.modified())
                    .map(|modified| {
                        modified
                            .elapsed()
                            .map(|age| age >= STATE_LOCK_STALE_AFTER)
                            .unwrap_or(false)
                    })
                    .unwrap_or(false);
                if stale {
                    let _ = fs::remove_file(&lock_path);
                    continue;
                }
                if started_at.elapsed() >= STATE_LOCK_TIMEOUT {
                    return Err(
                        "USER_STATE_BUSY: 用户状态正在被其它 FolioMind 进程保存，请稍后重试".into(),
                    );
                }
                thread::sleep(STATE_LOCK_RETRY);
            }
            Err(error) => return Err(format!("cannot create user state lock: {error}")),
        }
    }
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

fn validate_optional_text(value: &Option<String>, label: &str, max: usize) -> Result<(), String> {
    if let Some(value) = value {
        validate_text_allow_empty(value, label, max)?;
    }
    Ok(())
}

fn validate_text_allow_empty(value: &str, label: &str, max: usize) -> Result<(), String> {
    if value.is_empty() {
        return Ok(());
    }
    validate_text(value, label, max)
}

fn validate_optional_price(value: Option<f64>, label: &str) -> Result<(), String> {
    if let Some(value) = value {
        if !value.is_finite() || value <= 0.0 || value > 1_000_000_000.0 {
            return Err(format!("{label} is invalid"));
        }
    }
    Ok(())
}

pub fn validate(state: &UserState) -> Result<(), String> {
    if state.watchlist.len() > MAX_WATCHLIST
        || state.monitor_rules.len() > MAX_RULES
        || state.notifications.len() > MAX_NOTIFICATIONS
        || state.portfolio_positions.len() > MAX_PORTFOLIO_POSITIONS
        || state.monitor_history.len() > MAX_MONITOR_HISTORY
        || state.portfolio_reviews.len() > MAX_PORTFOLIO_REVIEWS
        || state.installed_skill_ids.len() > MAX_INSTALLED_SKILLS
    {
        return Err("user state exceeds size limit".into());
    }
    let mut installed_skill_ids = HashSet::new();
    for skill_id in &state.installed_skill_ids {
        validate_text(skill_id, "installed skill id", 64)?;
        if !installed_skill_ids.insert(skill_id) {
            return Err("installed skill ids contain duplicates".into());
        }
        if !skill_id.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
        }) {
            return Err("installed skill id is invalid".into());
        }
    }
    for item in &state.watchlist {
        validate_text(&item.symbol, "watchlist symbol", 64)?;
        validate_text(&item.name, "watchlist name", 128)?;
        validate_text(&item.market, "watchlist market", 64)?;
        validate_text(&item.category, "watchlist category", 64)?;
        validate_text(&item.group, "watchlist group", 64)?;
    }
    for rule in &state.monitor_rules {
        validate_text(&rule.id, "monitor rule id", 64)?;
        validate_text(&rule.symbol, "monitor rule symbol", 64)?;
        validate_text(&rule.strategy_id, "monitor strategy", 64)?;
        if !matches!(rule.scope.as_str(), "symbol" | "watchlist")
            || (rule.scope == "watchlist" && rule.symbol != "*")
            || (rule.scope == "symbol" && rule.symbol == "*")
        {
            return Err("monitor rule scope is invalid".into());
        }
        if rule.last_signal_by_symbol.len() > MAX_WATCHLIST {
            return Err("monitor rule signal map exceeds size limit".into());
        }
        for symbol in rule.last_signal_by_symbol.keys() {
            validate_text(symbol, "monitor rule signal symbol", 64)?;
        }
        if rule.conditions.len() > 6 || !matches!(rule.logic.as_str(), "AND" | "OR") {
            return Err("monitor rule conditions are invalid".into());
        }
        if !matches!(rule.trigger_mode.as_str(), "edge" | "once") {
            return Err("monitor rule trigger mode is invalid".into());
        }
        if let Some(expires_at) = &rule.expires_at {
            validate_text(expires_at, "monitor rule expiry", 64)?;
            if DateTime::parse_from_rfc3339(expires_at).is_err() {
                return Err("monitor rule expiry is invalid".into());
            }
        }
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
        if !notification.symbol.is_empty() {
            validate_text(&notification.symbol, "notification symbol", 64)?;
        }
        if !notification.name.is_empty() {
            validate_text(&notification.name, "notification name", 128)?;
        }
        if !notification.rule_id.is_empty() {
            validate_text(&notification.rule_id, "notification rule id", 128)?;
        }
        if !notification.event_key.is_empty() {
            validate_text(&notification.event_key, "notification event key", 512)?;
        }
        if !notification.reminder_phase.is_empty() {
            validate_text(
                &notification.reminder_phase,
                "notification reminder phase",
                32,
            )?;
        }
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
        validate_optional_price(position.take_profit_price, "take profit price")?;
        validate_optional_price(position.stop_loss_price, "stop loss price")?;
        validate_text_allow_empty(&position.plan_thesis, "portfolio plan thesis", 2_000)?;
        if let Some(horizon) = &position.plan_horizon {
            if !matches!(horizon.as_str(), "short" | "swing" | "medium" | "long") {
                return Err("portfolio plan horizon is invalid".into());
            }
        }
        if let Some(status) = &position.plan_status {
            if !matches!(status.as_str(), "none" | "active" | "executed" | "archived") {
                return Err("portfolio plan status is invalid".into());
            }
        }
        validate_optional_text(&position.plan_created_at, "portfolio plan created at", 64)?;
        validate_optional_text(&position.plan_updated_at, "portfolio plan updated at", 64)?;
        if position.plan_actions.len() > 20 {
            return Err("portfolio plan actions exceed size limit".into());
        }
        for action in &position.plan_actions {
            validate_text(&action.id, "portfolio plan action id", 128)?;
            validate_text(&action.action_type, "portfolio plan action type", 32)?;
            validate_text(&action.at, "portfolio plan action timestamp", 64)?;
            validate_text(&action.note, "portfolio plan action note", 512)?;
        }
    }
    if state.monitor_history.len() > MAX_MONITOR_HISTORY {
        return Err("monitor history exceeds size limit".into());
    }
    for entry in &state.monitor_history {
        validate_text(&entry.id, "monitor history id", 128)?;
        validate_text(&entry.rule_id, "monitor history rule id", 128)?;
        validate_text(&entry.symbol, "monitor history symbol", 64)?;
        validate_text(&entry.checked_at, "monitor history timestamp", 64)?;
        validate_text(&entry.outcome, "monitor history outcome", 32)?;
        validate_text(&entry.title, "monitor history title", 256)?;
        validate_text(&entry.summary, "monitor history summary", 4096)?;
        validate_text(&entry.severity, "monitor history severity", 32)?;
        validate_text(&entry.source, "monitor history source", 64)?;
        validate_text_allow_empty(&entry.as_of, "monitor history as of", 128)?;
        if entry.condition_results.len() > 6 || entry.audits.len() > 12 {
            return Err("monitor history details exceed size limit".into());
        }
        for audit in &entry.audits {
            validate_text_allow_empty(&audit.operation, "monitor history audit operation", 64)?;
            validate_text_allow_empty(&audit.outcome, "monitor history audit outcome", 64)?;
            validate_text_allow_empty(&audit.tool_id, "monitor history audit tool", 160)?;
            validate_text_allow_empty(&audit.capability, "monitor history audit capability", 128)?;
        }
    }
    for review in &state.portfolio_reviews {
        validate_text(&review.id, "portfolio review id", 128)?;
        if review.kind != "close"
            || review.priced_count == 0
            || review.total_count < review.priced_count
        {
            return Err("portfolio review header is invalid".into());
        }
        validate_text(&review.trading_date, "portfolio review date", 32)?;
        validate_text(&review.created_at, "portfolio review created at", 64)?;
        validate_text_allow_empty(&review.as_of, "portfolio review as of", 128)?;
        validate_text(&review.disclaimer, "portfolio review disclaimer", 512)?;
        if review.positions.len() > MAX_PORTFOLIO_POSITIONS
            || review.risk_signals.len() > 8
            || review.upcoming_events.len() > 12
            || review.sources.len() > 12
        {
            return Err("portfolio review details exceed size limit".into());
        }
        let validate_number = |value: Option<f64>| value.is_none_or(f64::is_finite);
        if !validate_number(review.total_cost)
            || !validate_number(review.total_market_value)
            || !validate_number(review.total_pnl)
            || !validate_number(review.total_pnl_percent)
        {
            return Err("portfolio review totals are invalid".into());
        }
        let validate_position = |position: &ReviewPosition| -> Result<(), String> {
            validate_text(&position.symbol, "portfolio review symbol", 64)?;
            validate_text(&position.name, "portfolio review name", 128)?;
            validate_text_allow_empty(&position.as_of, "portfolio review quote time", 128)?;
            validate_text(&position.source, "portfolio review quote source", 128)?;
            if !position.current_price.is_finite()
                || !validate_number(position.pnl)
                || !validate_number(position.pnl_percent)
                || !validate_number(position.weight)
            {
                return Err("portfolio review position value is invalid".into());
            }
            Ok(())
        };
        for position in &review.positions {
            validate_position(position)?;
        }
        if let Some(position) = &review.top_gainer {
            validate_position(position)?;
        }
        if let Some(position) = &review.top_loser {
            validate_position(position)?;
        }
        for signal in &review.risk_signals {
            if !matches!(signal.level.as_str(), "info" | "warning" | "critical") {
                return Err("portfolio review risk level is invalid".into());
            }
            validate_text(&signal.title, "portfolio review risk title", 256)?;
            validate_text(&signal.detail, "portfolio review risk detail", 1024)?;
        }
        for event in &review.upcoming_events {
            validate_text(&event.symbol, "portfolio review event symbol", 64)?;
            validate_text(&event.name, "portfolio review event name", 128)?;
            validate_text(&event.date, "portfolio review event date", 64)?;
            validate_text(&event.event_type, "portfolio review event type", 64)?;
            validate_text(&event.title, "portfolio review event title", 256)?;
            validate_text(&event.source, "portfolio review event source", 128)?;
            validate_text_allow_empty(&event.url, "portfolio review event url", 1024)?;
        }
        for source in &review.sources {
            validate_text(source, "portfolio review source", 128)?;
        }
    }
    let schedule = &state.briefing_schedule;
    if schedule.time_zone != "Asia/Shanghai"
        || schedule.close_time.len() != 5
        || schedule.close_time.as_bytes().get(2) != Some(&b':')
        || !(5..=60).contains(&schedule.retry_minutes)
        || !matches!(
            schedule.last_result.as_str(),
            "idle" | "success" | "waiting-data" | "waiting-calendar" | "market-closed" | "error"
        )
        || !matches!(
            schedule.calendar_status.as_str(),
            "unknown" | "trading" | "closed" | "error"
        )
    {
        return Err("briefing schedule is invalid".into());
    }
    let time_bytes = schedule.close_time.as_bytes();
    let valid_time = time_bytes
        .iter()
        .enumerate()
        .all(|(index, byte)| index == 2 || byte.is_ascii_digit())
        && ((time_bytes[0] - b'0') * 10 + time_bytes[1] - b'0') < 24
        && ((time_bytes[3] - b'0') * 10 + time_bytes[4] - b'0') < 60;
    if !valid_time {
        return Err("briefing schedule time is invalid".into());
    }
    validate_text_allow_empty(&schedule.last_attempt_at, "briefing last attempt", 64)?;
    validate_text_allow_empty(&schedule.last_success_key, "briefing success key", 128)?;
    validate_text_allow_empty(&schedule.last_error, "briefing last error", 512)?;
    validate_text_allow_empty(&schedule.calendar_date, "briefing calendar date", 10)?;
    validate_text_allow_empty(
        &schedule.calendar_checked_at,
        "briefing calendar checked at",
        64,
    )?;
    validate_text_allow_empty(&schedule.calendar_source, "briefing calendar source", 128)?;
    validate_text_allow_empty(&schedule.calendar_tool_id, "briefing calendar tool id", 256)?;
    Ok(())
}

fn load_unlocked(app: &AppHandle) -> Result<UserState, String> {
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
    Ok(migrate_legacy_seed_rules(state))
}

fn legacy_seed_rule(
    rule: &MonitorRule,
    id: &str,
    symbol: &str,
    strategy_id: &str,
    threshold: f64,
    interval_seconds: u64,
) -> bool {
    let expected_condition = if id == "r1" {
        ("price_change", "abs_gte", 3.0)
    } else {
        ("core_event", "gte", 1.0)
    };
    let normalized_condition = rule.conditions.len() == 1
        && rule.conditions[0]
            .get("type")
            .and_then(serde_json::Value::as_str)
            == Some(expected_condition.0)
        && rule.conditions[0]
            .get("operator")
            .and_then(serde_json::Value::as_str)
            == Some(expected_condition.1)
        && rule.conditions[0]
            .get("value")
            .and_then(serde_json::Value::as_f64)
            .is_some_and(|value| (value - expected_condition.2).abs() < f64::EPSILON);
    rule.id == id
        && rule.scope == "symbol"
        && rule.symbol == symbol
        && rule.strategy_id == strategy_id
        && (rule.threshold - threshold).abs() < f64::EPSILON
        && rule.interval_seconds == interval_seconds
        && rule.enabled
        && rule.last_checked_at.is_none()
        && rule.last_triggered_at.is_none()
        && rule.last_signal_triggered.is_none()
        && rule.last_signal_by_symbol.is_empty()
        && rule.logic == "AND"
        && (rule.conditions.is_empty() || normalized_condition)
}

/// Remove only the untouched rules seeded by pre-onboarding releases. A user
/// edit, a prior check, a notification, or any additional rule keeps the
/// persisted configuration intact.
fn migrate_legacy_seed_rules(mut state: UserState) -> UserState {
    if state.notifications.is_empty()
        && state.monitor_history.is_empty()
        && state.monitor_rules.len() == 2
        && state
            .monitor_rules
            .iter()
            .any(|rule| legacy_seed_rule(rule, "r1", "600519", "price_change", 3.0, 300))
        && state
            .monitor_rules
            .iter()
            .any(|rule| legacy_seed_rule(rule, "r2", "300750", "news_risk", 1.0, 600))
    {
        state.monitor_rules.clear();
    }
    state
}

pub fn load(app: &AppHandle) -> Result<UserState, String> {
    let _guard = STATE_IO_LOCK
        .lock()
        .map_err(|_| "user state I/O lock poisoned")?;
    load_unlocked(app)
}

fn save_unlocked(app: &AppHandle, state: &UserState) -> Result<UserState, String> {
    validate(state)?;
    let bytes = serde_json::to_vec_pretty(state)
        .map_err(|error| format!("cannot encode user state: {error}"))?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("user state exceeds size limit".into());
    }
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

pub fn save_if_revision(
    app: &AppHandle,
    state: &UserState,
    expected_revision: u64,
) -> Result<UserState, String> {
    let _guard = STATE_IO_LOCK
        .lock()
        .map_err(|_| "user state I/O lock poisoned")?;
    let file = path(app)?;
    let _file_lock = acquire_state_file_lock(&file)?;
    let current = load_unlocked(app)?;
    let next = advance_revision(&current, state, expected_revision)?;
    save_unlocked(app, &next)
}

/// Apply a short, synchronous mutation while holding the state I/O lock.
/// Callers must finish all network and other slow work before entering this
/// closure. The latest state is reloaded inside the critical section so native
/// background writers cannot overwrite a newer WebView save.
pub fn mutate<F>(app: &AppHandle, operation: F) -> Result<UserState, String>
where
    F: FnOnce(&mut UserState) -> Result<(), String>,
{
    let _guard = STATE_IO_LOCK
        .lock()
        .map_err(|_| "user state I/O lock poisoned")?;
    let file = path(app)?;
    let _file_lock = acquire_state_file_lock(&file)?;
    let mut state = load_unlocked(app)?;
    operation(&mut state)?;
    state.revision = state
        .revision
        .checked_add(1)
        .ok_or("user state revision exhausted")?;
    save_unlocked(app, &state)
}

fn advance_revision(
    current: &UserState,
    state: &UserState,
    expected_revision: u64,
) -> Result<UserState, String> {
    if current.revision != expected_revision || state.revision != expected_revision {
        return Err(format!(
            "USER_STATE_CONFLICT: expected revision {expected_revision}, current revision {}",
            current.revision
        ));
    }
    let mut next = state.clone();
    next.revision = current
        .revision
        .checked_add(1)
        .ok_or("user state revision exhausted")?;
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_valid() {
        assert!(validate(&UserState::default()).is_ok());
        assert_eq!(UserState::default().revision, 0);
        assert!(UserState::default().monitor_rules.is_empty());
        assert_eq!(
            UserState::default().installed_skill_ids,
            vec!["fundamental".to_string(), "monitor".to_string()]
        );
    }

    #[test]
    fn legacy_seed_rules_are_removed_only_when_untouched() {
        let seed =
            |id: &str, symbol: &str, strategy_id: &str, threshold: f64, interval_seconds: u64| {
                MonitorRule {
                    id: id.into(),
                    scope: "symbol".into(),
                    symbol: symbol.into(),
                    strategy_id: strategy_id.into(),
                    threshold,
                    interval_seconds,
                    enabled: true,
                    last_checked_at: None,
                    last_triggered_at: None,
                    conditions: Vec::new(),
                    logic: default_logic(),
                    last_signal_triggered: None,
                    last_signal_by_symbol: HashMap::new(),
                    trigger_mode: default_trigger_mode(),
                    expires_at: None,
                }
            };
        let migrated = UserState {
            monitor_rules: vec![
                seed("r1", "600519", "price_change", 3.0, 300),
                seed("r2", "300750", "news_risk", 1.0, 600),
            ],
            ..UserState::default()
        };
        assert!(migrate_legacy_seed_rules(migrated).monitor_rules.is_empty());

        let edited = UserState {
            monitor_rules: vec![
                seed("r1", "600519", "price_change", 4.0, 300),
                seed("r2", "300750", "news_risk", 1.0, 600),
            ],
            ..UserState::default()
        };
        assert_eq!(migrate_legacy_seed_rules(edited).monitor_rules.len(), 2);

        let mut active = UserState {
            monitor_rules: vec![
                seed("r1", "600519", "price_change", 3.0, 300),
                seed("r2", "300750", "news_risk", 1.0, 600),
            ],
            ..UserState::default()
        };
        active.notifications.push(Notification {
            id: "n1".into(),
            kind: "monitor".into(),
            title: "已有提醒".into(),
            body: String::new(),
            severity: "info".into(),
            created_at: String::new(),
            read: false,
            source: None,
            symbol: String::new(),
            name: String::new(),
            rule_id: String::new(),
            event_key: String::new(),
            reminder_phase: String::new(),
        });
        assert_eq!(migrate_legacy_seed_rules(active).monitor_rules.len(), 2);
    }

    #[test]
    fn revision_compare_and_swap_rejects_stale_writers() {
        let current = UserState {
            revision: 7,
            ..UserState::default()
        };
        let mut submitted = current.clone();
        submitted.watchlist[0].name = "本地修改".into();
        let saved = advance_revision(&current, &submitted, 7).unwrap();
        assert_eq!(saved.revision, 8);
        assert_eq!(saved.watchlist[0].name, "本地修改");
        assert!(advance_revision(&saved, &submitted, 7)
            .unwrap_err()
            .starts_with("USER_STATE_CONFLICT:"));
    }

    #[test]
    fn invalid_threshold_is_rejected() {
        let mut state = UserState::default();
        state.monitor_rules.push(MonitorRule {
            id: "test-rule".into(),
            scope: "symbol".into(),
            symbol: "600519".into(),
            strategy_id: "price_change".into(),
            threshold: 3.0,
            interval_seconds: 300,
            enabled: true,
            last_checked_at: None,
            last_triggered_at: None,
            conditions: Vec::new(),
            logic: default_logic(),
            last_signal_triggered: None,
            last_signal_by_symbol: HashMap::new(),
            trigger_mode: default_trigger_mode(),
            expires_at: None,
        });
        state.monitor_rules[0].threshold = f64::NAN;
        assert!(validate(&state).is_err());
    }

    #[test]
    fn invalid_monitor_scope_is_rejected() {
        let mut state = UserState::default();
        state.monitor_rules.push(MonitorRule {
            id: "test-rule".into(),
            scope: "watchlist".into(),
            symbol: "600519".into(),
            strategy_id: "price_change".into(),
            threshold: 3.0,
            interval_seconds: 300,
            enabled: true,
            last_checked_at: None,
            last_triggered_at: None,
            conditions: Vec::new(),
            logic: default_logic(),
            last_signal_triggered: None,
            last_signal_by_symbol: HashMap::new(),
            trigger_mode: default_trigger_mode(),
            expires_at: None,
        });
        assert!(validate(&state).is_err());
    }

    #[test]
    fn invalid_briefing_schedule_is_rejected() {
        let mut state = UserState::default();
        state.briefing_schedule.enabled = true;
        state.briefing_schedule.close_time = "25:00".into();
        assert!(validate(&state).is_err());
        state.briefing_schedule.close_time = "15:35".into();
        state.briefing_schedule.last_result = "invented".into();
        assert!(validate(&state).is_err());
    }

    #[test]
    fn rich_state_round_trips_without_dropping_new_fields() {
        let value = serde_json::json!({
            "watchlist": [{"symbol": "600519", "name": "贵州茅台", "market": "沪深", "category": "白酒", "group": "核心持仓"}],
            "monitorRules": [{
                "id": "r1", "scope": "watchlist", "symbol": "*", "strategyId": "price_change", "threshold": 3.0,
                "intervalSeconds": 300, "enabled": true, "lastCheckedAt": null, "lastTriggeredAt": null,
                "conditions": [{"type": "price_change", "operator": "abs_gte", "value": 3}], "logic": "OR",
                "lastSignalBySymbol": {"600519": true, "300750": false},
                "lastSignalTriggered": true, "triggerMode": "once", "expiresAt": "2026-09-10T23:59:59Z"
            }],
            "notifications": [{
                "id": "n1", "kind": "event-reminder", "symbol": "600519", "name": "贵州茅台", "ruleId": "",
                "eventKey": "600519|2026-09-01|分红|登记日", "reminderPhase": "upcoming", "title": "事件提醒",
                "body": "还有 7 天", "severity": "info", "createdAt": "2026-08-25T00:00:00Z", "read": false, "source": "data-service"
            }],
            "portfolioPositions": [{
                "id": "p1", "symbol": "600519", "name": "贵州茅台", "market": "沪深", "quantity": 10,
                "averageCost": 1200, "takeProfitPrice": 1400, "stopLossPrice": 1100,
                "takeProfitTriggered": false, "stopLossTriggered": true, "planThesis": "验证消费复苏",
                "planHorizon": "medium", "planStatus": "active", "planCreatedAt": "2026-08-01T00:00:00Z",
                "planUpdatedAt": "2026-08-20T00:00:00Z", "planActions": [{"id": "a1", "type": "adjusted", "at": "2026-08-20T00:00:00Z", "note": "调整止损"}]
            }],
            "monitorHistory": [{
                "id": "h1", "ruleId": "r1", "symbol": "600519", "checkedAt": "2026-08-29T10:00:00Z",
                "outcome": "unknown", "triggered": null, "title": "待核实", "summary": "字段不足", "severity": "info",
                "source": "data-service", "asOf": "2026-08-29", "conditionResults": [null],
                "audits": [{"operation": "cap-call", "outcome": "success", "toolId": "qveris_finance.mkt_l1_rt", "capability": "MKT.L1.RT"}]
            }],
            "portfolioReviews": [{
                "id": "review-1", "kind": "close", "tradingDate": "2026-08-30", "createdAt": "2026-08-30T10:00:00Z",
                "asOf": "2026-08-30T08:00:00Z", "pricedCount": 1, "totalCount": 1, "totalCost": 12000,
                "totalMarketValue": 13000, "totalPnl": 1000, "totalPnlPercent": 8.33,
                "topGainer": {"symbol": "600519", "name": "贵州茅台", "currentPrice": 1300, "pnl": 1000, "pnlPercent": 8.33, "weight": 100, "asOf": "2026-08-30T08:00:00Z", "source": "provider"},
                "topLoser": {"symbol": "600519", "name": "贵州茅台", "currentPrice": 1300, "pnl": 1000, "pnlPercent": 8.33, "weight": 100, "asOf": "2026-08-30T08:00:00Z", "source": "provider"},
                "positions": [{"symbol": "600519", "name": "贵州茅台", "currentPrice": 1300, "pnl": 1000, "pnlPercent": 8.33, "weight": 100, "asOf": "2026-08-30T08:00:00Z", "source": "provider"}],
                "riskSignals": [], "upcomingEvents": [], "sources": ["provider"], "disclaimer": "不构成投资建议"
            }],
            "installedSkillIds": ["fundamental", "news"]
        });
        let mut state: UserState =
            serde_json::from_value(value).expect("rich state should deserialize");
        assert!(validate(&state).is_ok());
        assert_eq!(state.watchlist[0].group, "核心持仓");
        assert_eq!(state.monitor_rules[0].conditions.len(), 1);
        assert_eq!(state.monitor_rules[0].logic, "OR");
        assert_eq!(state.monitor_rules[0].scope, "watchlist");
        assert_eq!(state.monitor_rules[0].trigger_mode, "once");
        assert_eq!(state.monitor_rules[0].expires_at.as_deref(), Some("2026-09-10T23:59:59Z"));
        assert_eq!(
            state.monitor_rules[0].last_signal_by_symbol.get("600519"),
            Some(&true)
        );
        assert_eq!(
            state.notifications[0].event_key,
            "600519|2026-09-01|分红|登记日"
        );
        assert_eq!(state.portfolio_positions[0].take_profit_price, Some(1400.0));
        assert_eq!(
            state.portfolio_positions[0].plan_actions[0].action_type,
            "adjusted"
        );
        assert_eq!(
            state.monitor_history[0].audits[0].tool_id,
            "qveris_finance.mkt_l1_rt"
        );
        assert_eq!(
            state.portfolio_reviews[0].positions[0].current_price,
            1300.0
        );
        assert_eq!(state.installed_skill_ids, vec!["fundamental", "news"]);
        let encoded = serde_json::to_value(&state).expect("rich state should serialize");
        state = serde_json::from_value(encoded).expect("rich state should round trip");
        assert_eq!(state.monitor_history.len(), 1);
        assert_eq!(state.portfolio_reviews.len(), 1);
    }

    #[test]
    fn legacy_state_gets_safe_defaults_for_new_fields() {
        let legacy = serde_json::json!({
            "watchlist": [{"symbol": "600519", "name": "贵州茅台", "market": "沪深", "category": "白酒"}],
            "monitorRules": [{"id": "r1", "symbol": "600519", "strategyId": "price_change", "threshold": 3.0,
                "intervalSeconds": 300, "enabled": true, "lastCheckedAt": null, "lastTriggeredAt": null}],
            "notifications": [], "portfolioPositions": []
        });
        let state: UserState =
            serde_json::from_value(legacy).expect("legacy state should deserialize");
        assert!(validate(&state).is_ok());
        assert_eq!(state.watchlist[0].group, "A股");
        assert!(state.monitor_rules[0].conditions.is_empty());
        assert_eq!(state.monitor_rules[0].logic, "AND");
        assert_eq!(state.monitor_rules[0].scope, "symbol");
        assert!(state.monitor_rules[0].last_signal_by_symbol.is_empty());
        assert_eq!(state.monitor_rules[0].trigger_mode, "edge");
        assert!(state.monitor_rules[0].expires_at.is_none());
        assert!(state.monitor_history.is_empty());
        assert!(state.portfolio_reviews.is_empty());
        assert_eq!(
            state.installed_skill_ids,
            vec!["fundamental".to_string(), "monitor".to_string()]
        );
    }

    #[test]
    fn invalid_installed_skill_id_is_rejected() {
        let state = UserState {
            installed_skill_ids: vec!["../escape".into()],
            ..UserState::default()
        };
        assert!(validate(&state).is_err());
    }

    #[test]
    fn invalid_monitor_lifecycle_values_are_rejected() {
        let mut state = UserState::default();
        state.monitor_rules.push(MonitorRule {
            id: "test-rule".into(),
            scope: "symbol".into(),
            symbol: "600519".into(),
            strategy_id: "price_change".into(),
            threshold: 3.0,
            interval_seconds: 300,
            enabled: true,
            last_checked_at: None,
            last_triggered_at: None,
            conditions: Vec::new(),
            logic: default_logic(),
            last_signal_triggered: None,
            last_signal_by_symbol: HashMap::new(),
            trigger_mode: "repeat".into(),
            expires_at: Some("not-a-timestamp".into()),
        });
        assert!(validate(&state).is_err());
        state.monitor_rules[0].trigger_mode = "once".into();
        assert!(validate(&state).is_err());
        state.monitor_rules[0].expires_at = Some("2026-09-10T23:59:59Z".into());
        assert!(validate(&state).is_ok());
    }
}
