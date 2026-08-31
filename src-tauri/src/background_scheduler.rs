use crate::{
    config,
    credentials::CredentialStore,
    market_calendar,
    user_state::{
        self, Notification, PortfolioReview, ReviewPosition, ReviewRiskSignal, UserState,
    },
};
use chrono::{DateTime, Timelike, Utc};
use chrono_tz::Asia::Shanghai;
use reqwest::blocking::Client;
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};
use tauri::{AppHandle, Emitter};
#[cfg(any(target_os = "windows", target_os = "macos"))]
use tauri_plugin_notification::NotificationExt;
use uuid::Uuid;

const QUOTE_TOOL_ID: &str = "qveris_finance.mkt_l1_rt";
const DISCLAIMER: &str = "本复盘仅整理已返回的真实数据，不构成投资建议或交易指令。";
const COMPLETED_EVENT: &str = "foliomind://background-review-completed";

#[derive(Clone, Debug, PartialEq, Eq)]
enum DueState {
    Disabled,
    NoPositions,
    NotDue,
    Completed,
    RetryWait,
    CalendarNeeded,
    MarketClosed,
    Due,
}

#[derive(Clone, Debug)]
struct Quote {
    symbol: String,
    price: f64,
    as_of: String,
    source: String,
}

#[derive(Default)]
pub struct BackgroundScheduler {
    stop: Arc<AtomicBool>,
    worker: Mutex<Option<thread::JoinHandle<()>>>,
    running: Arc<AtomicBool>,
}

fn day_and_minute(now: DateTime<Utc>) -> (String, u32) {
    let local = now.with_timezone(&Shanghai);
    (
        local.format("%Y-%m-%d").to_string(),
        local.hour() * 60 + local.minute(),
    )
}

fn due_state(state: &UserState, now: DateTime<Utc>) -> DueState {
    let schedule = &state.briefing_schedule;
    let (day, minute) = day_and_minute(now);
    let key = format!("close:{day}");
    if !schedule.enabled {
        return DueState::Disabled;
    }
    if state.portfolio_positions.is_empty() {
        return DueState::NoPositions;
    }
    let mut parts = schedule
        .close_time
        .split(':')
        .filter_map(|part| part.parse::<u32>().ok());
    let close_minute = match (parts.next(), parts.next()) {
        (Some(hour), Some(minute)) => hour * 60 + minute,
        _ => return DueState::NotDue,
    };
    if minute < close_minute {
        return DueState::NotDue;
    }
    if schedule.last_success_key == key
        || state
            .portfolio_reviews
            .iter()
            .any(|review| review.kind == "close" && review.trading_date == day)
    {
        return DueState::Completed;
    }
    if schedule.calendar_date == day && schedule.calendar_status == "closed" {
        return DueState::MarketClosed;
    }
    if let Ok(last) = DateTime::parse_from_rfc3339(&schedule.last_attempt_at) {
        if now
            .signed_duration_since(last.with_timezone(&Utc))
            .num_minutes()
            < schedule.retry_minutes as i64
        {
            return DueState::RetryWait;
        }
    }
    if schedule.calendar_date != day
        || !matches!(schedule.calendar_status.as_str(), "trading" | "closed")
    {
        return DueState::CalendarNeeded;
    }
    DueState::Due
}

fn capability_data(value: &Value) -> Option<&Value> {
    value
        .pointer("/result/data")
        .or_else(|| value.get("data"))
        .or_else(|| value.get("result"))
}

fn numeric_value(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_i64().map(|item| item as f64))
        .or_else(|| value.as_u64().map(|item| item as f64))
        .or_else(|| value.as_str().and_then(|item| item.parse::<f64>().ok()))
}

fn parse_quote(value: &Value, symbol: &str) -> Result<Quote, String> {
    if value.get("success").and_then(Value::as_bool) == Some(false) {
        return Err("行情渠道暂未返回可用结果".into());
    }
    let data = capability_data(value).ok_or("行情返回结构无法识别")?;
    let row = data
        .as_array()
        .and_then(|rows| rows.first())
        .unwrap_or(data);
    let price = row
        .get("price")
        .or_else(|| row.get("last"))
        .or_else(|| row.get("close"))
        .and_then(numeric_value)
        .ok_or("行情未返回有效现价")?;
    if !price.is_finite() || price <= 0.0 {
        return Err("行情未返回有效现价".into());
    }
    let as_of = row
        .get("timestamp")
        .or_else(|| row.get("as_of"))
        .or_else(|| row.get("time"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let source = value
        .pointer("/result/_meta/source_provider")
        .or_else(|| value.pointer("/_meta/source_provider"))
        .or_else(|| value.pointer("/result/_meta/source_tool_id"))
        .and_then(Value::as_str)
        .unwrap_or("qveris_finance")
        .to_owned();
    Ok(Quote {
        symbol: symbol.to_owned(),
        price,
        as_of,
        source,
    })
}

fn fetch_quote(
    client: &Client,
    api_key: &str,
    base_url: &str,
    symbol: &str,
) -> Result<Quote, String> {
    let response = client
        .post(format!(
            "{}/tools/execute?tool_id={QUOTE_TOOL_ID}",
            base_url.trim_end_matches('/')
        ))
        .bearer_auth(api_key)
        .json(&json!({
            "session_id": format!("foliomind_background_{}", Uuid::new_v4()),
            "parameters": { "symbol": symbol },
            "max_response_size": 20_480,
            "respond_with": "full"
        }))
        .send()
        .map_err(|_| "行情连接失败")?;
    let status = response.status();
    if !status.is_success() {
        return Err(if matches!(status.as_u16(), 401 | 403) {
            "行情凭据无效或无权限".into()
        } else {
            format!("行情暂不可用（HTTP {}）", status.as_u16())
        });
    }
    parse_quote(
        &response
            .json::<Value>()
            .map_err(|_| "行情返回内容无法解析")?,
        symbol,
    )
}

fn quote_is_fresh(quote: &Quote, trading_date: &str) -> bool {
    quote.as_of.get(0..10) == Some(trading_date)
}

fn build_review(
    state: &UserState,
    quotes: &[Quote],
    created_at: &str,
    trading_date: &str,
) -> Result<PortfolioReview, String> {
    let mut positions = Vec::new();
    let mut total_cost = 0.0;
    let mut total_market_value = 0.0;
    let mut total_pnl = 0.0;
    for position in &state.portfolio_positions {
        total_cost += position.quantity * position.average_cost;
        let Some(quote) = quotes.iter().find(|quote| quote.symbol == position.symbol) else {
            continue;
        };
        let cost = position.quantity * position.average_cost;
        let market_value = position.quantity * quote.price;
        total_market_value += market_value;
        let pnl = market_value - cost;
        total_pnl += pnl;
        positions.push(ReviewPosition {
            symbol: position.symbol.clone(),
            name: position.name.clone(),
            current_price: quote.price,
            pnl: Some(pnl),
            pnl_percent: (cost > 0.0).then_some(pnl / cost * 100.0),
            weight: None,
            as_of: quote.as_of.clone(),
            source: quote.source.clone(),
        });
    }
    if positions.is_empty() {
        return Err("尚未取得当日真实持仓行情，将按重试间隔再次尝试".into());
    }
    for position in &mut positions {
        let market_value = state
            .portfolio_positions
            .iter()
            .find(|item| item.symbol == position.symbol)
            .map(|item| item.quantity * position.current_price)
            .unwrap_or(0.0);
        position.weight =
            (total_market_value > 0.0).then_some(market_value / total_market_value * 100.0);
    }
    let mut ranked = positions.clone();
    ranked.sort_by(|left, right| {
        right
            .pnl_percent
            .partial_cmp(&left.pnl_percent)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let top_gainer = ranked.first().cloned();
    let top_loser = ranked.last().cloned();
    let mut risk_signals = Vec::new();
    if let Some(top) = positions.iter().max_by(|left, right| {
        left.weight
            .partial_cmp(&right.weight)
            .unwrap_or(std::cmp::Ordering::Equal)
    }) {
        if top.weight.unwrap_or(0.0) >= 50.0 {
            risk_signals.push(ReviewRiskSignal {
                level: "critical".into(),
                title: "单一标的集中度较高".into(),
                detail: format!(
                    "{} 占已计价组合 {:.1}%，建议确认是否符合你的风险上限。",
                    top.name,
                    top.weight.unwrap_or(0.0)
                ),
            });
        } else if top.weight.unwrap_or(0.0) >= 30.0 {
            risk_signals.push(ReviewRiskSignal {
                level: "warning".into(),
                title: "存在集中度暴露".into(),
                detail: format!(
                    "{} 占已计价组合 {:.1}%，可以考虑设置单标的上限。",
                    top.name,
                    top.weight.unwrap_or(0.0)
                ),
            });
        }
    }
    let missing = state
        .portfolio_positions
        .len()
        .saturating_sub(positions.len());
    if missing > 0 {
        risk_signals.push(ReviewRiskSignal {
            level: "info".into(),
            title: "部分持仓缺少现价".into(),
            detail: format!("{missing} 个持仓暂未返回当日真实行情，未纳入市值和盈亏。"),
        });
    }
    if positions.len() >= 2 {
        risk_signals.push(ReviewRiskSignal {
            level: "info".into(),
            title: "波动率与相关性尚未计算".into(),
            detail: "当前后台任务没有请求历史序列；补齐历史数据后才会计算波动率和相关性。".into(),
        });
    }
    let mut sources = positions
        .iter()
        .map(|position| position.source.clone())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    sources.sort();
    sources.truncate(12);
    let as_of = positions
        .iter()
        .map(|position| position.as_of.as_str())
        .max()
        .unwrap_or_default()
        .to_owned();
    Ok(PortfolioReview {
        id: format!("portfolio-review-{}", Uuid::new_v4()),
        kind: "close".into(),
        trading_date: trading_date.into(),
        created_at: created_at.into(),
        as_of,
        priced_count: positions.len() as u64,
        total_count: state.portfolio_positions.len() as u64,
        total_cost: Some(total_cost),
        total_market_value: Some(total_market_value),
        total_pnl: Some(total_pnl),
        total_pnl_percent: (total_cost > 0.0).then_some(total_pnl / total_cost * 100.0),
        top_gainer,
        top_loser,
        positions,
        risk_signals,
        upcoming_events: Vec::new(),
        sources,
        disclaimer: DISCLAIMER.into(),
    })
}

fn set_schedule_error(app: &AppHandle, now: &str, result: &str, message: &str) {
    let _ = user_state::mutate(app, |state| {
        state.briefing_schedule.last_attempt_at = now.into();
        state.briefing_schedule.last_result = result.into();
        state.briefing_schedule.last_error = message.chars().take(512).collect();
        Ok(())
    });
}

pub fn reconcile(
    app: &AppHandle,
    credentials: &Arc<dyn CredentialStore>,
) -> Result<String, String> {
    let now = Utc::now();
    let created_at = now.to_rfc3339();
    let (trading_date, _) = day_and_minute(now);
    let initial = user_state::load(app)?;
    let mut status = due_state(&initial, now);
    if !matches!(status, DueState::CalendarNeeded | DueState::Due) {
        return Ok(format!("{status:?}").to_lowercase());
    }
    let claim = user_state::mutate(app, |state| {
        status = due_state(state, now);
        if !matches!(status, DueState::CalendarNeeded | DueState::Due) {
            return Err("BACKGROUND_NOT_DUE".into());
        }
        state.briefing_schedule.last_attempt_at = created_at.clone();
        state.briefing_schedule.last_result = if status == DueState::CalendarNeeded {
            "waiting-calendar"
        } else {
            "waiting-data"
        }
        .into();
        state.briefing_schedule.last_error = if status == DueState::CalendarNeeded {
            "正在核对真实交易日历"
        } else {
            "正在刷新持仓真实行情"
        }
        .into();
        Ok(())
    });
    if let Err(error) = claim {
        if error != "BACKGROUND_NOT_DUE" {
            return Err(error);
        }
    }
    if !matches!(status, DueState::CalendarNeeded | DueState::Due) {
        return Ok(format!("{status:?}").to_lowercase());
    }
    let api_key = match credentials.read_qveris_key()? {
        Some(value) => value,
        None => {
            let message = "请先配置数据服务 API Key";
            set_schedule_error(app, &created_at, "waiting-data", message);
            return Err(message.into());
        }
    };
    let settings = config::load(app)?;
    if status == DueState::CalendarNeeded {
        match market_calendar::fetch_trading_calendar(
            &api_key,
            &settings.capability_base_url,
            &trading_date,
            None,
        ) {
            Ok(calendar) => {
                user_state::mutate(app, |state| {
                    state.briefing_schedule.calendar_date = trading_date.clone();
                    state.briefing_schedule.calendar_status = if calendar.is_trading_day {
                        "trading"
                    } else {
                        "closed"
                    }
                    .into();
                    state.briefing_schedule.calendar_checked_at = created_at.clone();
                    state.briefing_schedule.calendar_source = calendar.source.clone();
                    state.briefing_schedule.calendar_tool_id = calendar.tool_id.clone();
                    state.briefing_schedule.last_result = if calendar.is_trading_day {
                        "waiting-data"
                    } else {
                        "market-closed"
                    }
                    .into();
                    state.briefing_schedule.last_error.clear();
                    Ok(())
                })?;
                if !calendar.is_trading_day {
                    return Ok("market-closed".into());
                }
            }
            Err(error) => {
                set_schedule_error(app, &created_at, "waiting-calendar", &error);
                return Err(error);
            }
        }
    }
    let snapshot = user_state::load(app)?;
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| "无法初始化行情客户端")?;
    let quotes = Arc::new(Mutex::new(Vec::new()));
    for chunk in snapshot.portfolio_positions.chunks(4) {
        thread::scope(|scope| {
            for position in chunk {
                let client = &client;
                let api_key = &api_key;
                let base_url = &settings.capability_base_url;
                let quotes = quotes.clone();
                let target_date = trading_date.as_str();
                scope.spawn(move || {
                    if let Ok(quote) = fetch_quote(client, api_key, base_url, &position.symbol) {
                        if quote_is_fresh(&quote, target_date) {
                            if let Ok(mut values) = quotes.lock() {
                                values.push(quote);
                            }
                        }
                    }
                });
            }
        });
    }
    let quotes = quotes.lock().map_err(|_| "行情结果锁不可用")?.clone();
    let review = match build_review(&snapshot, &quotes, &created_at, &trading_date) {
        Ok(review) => review,
        Err(error) => {
            set_schedule_error(app, &created_at, "waiting-data", &error);
            return Err(error);
        }
    };
    let key = format!("close:{trading_date}");
    let notification = Notification {
        id: format!("notification-{}", Uuid::new_v4()),
        kind: "briefing".into(),
        symbol: String::new(),
        name: String::new(),
        rule_id: String::new(),
        event_key: key.clone(),
        reminder_phase: "completed".into(),
        title: format!("{trading_date} 组合复盘已生成"),
        body: format!(
            "已使用 {}/{} 个持仓的当日真实行情生成复盘。",
            review.priced_count, review.total_count
        ),
        severity: "info".into(),
        created_at: created_at.clone(),
        read: false,
        source: Some("data-service".into()),
    };
    let snapshot_revision = snapshot.revision;
    let snapshot_positions = snapshot
        .portfolio_positions
        .iter()
        .map(|position| {
            (
                &position.id,
                &position.symbol,
                position.quantity,
                position.average_cost,
            )
        })
        .collect::<Vec<_>>();
    let mut inserted = false;
    let saved = user_state::mutate(app, |state| {
        if state
            .portfolio_reviews
            .iter()
            .any(|item| item.kind == "close" && item.trading_date == trading_date)
        {
            state.briefing_schedule.last_success_key = key.clone();
            state.briefing_schedule.last_result = "success".into();
            state.briefing_schedule.last_error.clear();
            return Ok(());
        }
        let current_positions = state
            .portfolio_positions
            .iter()
            .map(|position| {
                (
                    &position.id,
                    &position.symbol,
                    position.quantity,
                    position.average_cost,
                )
            })
            .collect::<Vec<_>>();
        if state.revision != snapshot_revision || current_positions != snapshot_positions {
            return Err("持仓在后台刷新期间发生变化，请稍后重试".into());
        }
        state.portfolio_reviews.insert(0, review.clone());
        state.portfolio_reviews.truncate(90);
        state.notifications.insert(0, notification.clone());
        state.notifications.truncate(500);
        state.briefing_schedule.last_success_key = key.clone();
        state.briefing_schedule.last_result = "success".into();
        state.briefing_schedule.last_error.clear();
        inserted = true;
        Ok(())
    })?;
    if !inserted {
        return Ok("completed".into());
    }
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    {
        let _ = app
            .notification()
            .builder()
            .title(&notification.title)
            .body(&notification.body)
            .show();
    }
    let _ = app.emit(COMPLETED_EVENT, &notification);
    debug_assert!(saved
        .portfolio_reviews
        .first()
        .is_some_and(|item| item.id == review.id));
    Ok("success".into())
}

impl BackgroundScheduler {
    pub fn start(&self, app: AppHandle, credentials: Arc<dyn CredentialStore>) {
        let mut worker = self
            .worker
            .lock()
            .expect("background scheduler lock poisoned");
        if worker.is_some() {
            return;
        }
        self.stop.store(false, Ordering::Release);
        let stop = self.stop.clone();
        let running = self.running.clone();
        *worker = Some(thread::spawn(move || {
            let mut elapsed = 59_u8;
            while !stop.load(Ordering::Acquire) {
                thread::sleep(Duration::from_secs(1));
                elapsed = elapsed.saturating_add(1);
                if elapsed < 60 {
                    continue;
                }
                elapsed = 0;
                if running
                    .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                    .is_ok()
                {
                    let task_app = app.clone();
                    let task_credentials = credentials.clone();
                    let task_running = running.clone();
                    thread::spawn(move || {
                        let _ = reconcile(&task_app, &task_credentials);
                        task_running.store(false, Ordering::Release);
                    });
                }
            }
        }));
    }

    pub fn stop_and_join(&self) {
        self.stop.store(true, Ordering::Release);
        if let Ok(mut worker) = self.worker.lock() {
            if let Some(handle) = worker.take() {
                let _ = handle.join();
            }
        }
    }

    pub fn run_now(&self, app: AppHandle, credentials: Arc<dyn CredentialStore>) -> bool {
        if self
            .running
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return false;
        }
        let running = self.running.clone();
        thread::spawn(move || {
            let _ = reconcile(&app, &credentials);
            running.store(false, Ordering::Release);
        });
        true
    }
}

impl Drop for BackgroundScheduler {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn at(value: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(value)
            .unwrap()
            .with_timezone(&Utc)
    }

    #[test]
    fn native_due_gate_is_deterministic_and_idempotent() {
        let mut state = UserState::default();
        state.briefing_schedule.enabled = true;
        state
            .portfolio_positions
            .push(crate::user_state::PortfolioPosition {
                id: "p1".into(),
                symbol: "600519".into(),
                name: "贵州茅台".into(),
                market: "沪深".into(),
                quantity: 1.0,
                average_cost: 100.0,
                take_profit_price: None,
                stop_loss_price: None,
                take_profit_triggered: false,
                stop_loss_triggered: false,
                plan_thesis: String::new(),
                plan_horizon: None,
                plan_status: None,
                plan_created_at: None,
                plan_updated_at: None,
                plan_actions: Vec::new(),
            });
        let now = Shanghai
            .with_ymd_and_hms(2026, 8, 31, 15, 35, 0)
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(due_state(&state, now), DueState::CalendarNeeded);
        state.briefing_schedule.last_attempt_at = "2026-08-31T07:30:00Z".into();
        assert_eq!(due_state(&state, now), DueState::RetryWait);
        state.briefing_schedule.last_attempt_at.clear();
        state.briefing_schedule.calendar_date = "2026-08-31".into();
        state.briefing_schedule.calendar_status = "trading".into();
        assert_eq!(due_state(&state, now), DueState::Due);
        state.briefing_schedule.last_success_key = "close:2026-08-31".into();
        assert_eq!(due_state(&state, now), DueState::Completed);
    }

    #[test]
    fn quote_parser_requires_real_price_and_preserves_source_time() {
        let quote = parse_quote(&json!({"success":true,"result":{"data":{"price":123.4,"timestamp":"2026-08-31T15:00:00+08:00"},"_meta":{"source_provider":"provider-a"}}}), "600519").unwrap();
        assert_eq!(quote.price, 123.4);
        assert_eq!(quote.source, "provider-a");
        assert!(quote_is_fresh(&quote, "2026-08-31"));
        assert!(parse_quote(&json!({"success":true,"result":{"data":{}}}), "600519").is_err());
        assert_eq!(
            parse_quote(
                &json!({"success":true,"result":{"data":{"price":123,"timestamp":"2026-08-31T15:00:00+08:00"}}}),
                "600519"
            )
            .unwrap()
            .price,
            123.0
        );
        assert!(!quote_is_fresh(&quote, "2026-09-01"));
        assert_eq!(
            at("2026-08-31T07:35:00Z"),
            Shanghai
                .with_ymd_and_hms(2026, 8, 31, 15, 35, 0)
                .unwrap()
                .with_timezone(&Utc)
        );
    }
}
