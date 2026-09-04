use chrono::{Duration as ChronoDuration, Utc};
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::{thread, time::Duration};
use uuid::Uuid;

const MAX_RESPONSE_SIZE: u64 = 20_480;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityQueryInput {
    pub kind: String,
    pub symbol: Option<String>,
    pub range: Option<String>,
    #[serde(alias = "start_date")]
    pub start_date: Option<String>,
    #[serde(alias = "end_date")]
    pub end_date: Option<String>,
    #[serde(alias = "event_type")]
    pub event_type: Option<String>,
    pub query: Option<String>,
    pub category: Option<String>,
    pub market: Option<String>,
    pub interval: Option<String>,
    #[serde(alias = "commodity_name")]
    pub commodity_name: Option<String>,
    pub frequency: Option<String>,
    pub limit: Option<u32>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityQueryResult {
    pub data: Value,
    pub mode: String,
    pub cache_hit: bool,
    pub audits: Vec<Value>,
    pub tool_id: String,
    pub capability: String,
}

struct CapabilitySpec {
    tool_id: &'static str,
    capability: &'static str,
}

fn spec(kind: &str) -> Option<CapabilitySpec> {
    let (tool_id, capability) = match kind {
        "quote" => ("qveris_finance.mkt_l1_rt", "MKT.L1.RT"),
        "details" => ("qveris_finance.ref_company_profile", "REF.COMPANY_PROFILE"),
        "fundamentals" => (
            "qveris_finance.fundamentals_derived_ratios",
            "FUNDAMENTALS.DERIVED_RATIOS",
        ),
        "series" => ("qveris_finance.mkt_bars_eod", "MKT.BARS.EOD"),
        "core_event" => ("qveris_finance.event_calendar_corp", "EVENT.CALENDAR.CORP"),
        "capital_flow" => ("qveris_finance.flow_large_order", "FLOW.LARGE_ORDER"),
        "sentiment" => ("qveris_finance.news_fin_tagged", "NEWS.FIN.TAGGED"),
        "market_news" => ("qveris_finance.news_fin_realtime", "NEWS.FIN.REALTIME"),
        "index_levels" => ("qveris_finance.index_levels", "INDEX.LEVELS"),
        "commodity" => (
            "qveris_finance.macro_commodity_benchmark",
            "MACRO.COMMODITY.BENCHMARK",
        ),
        _ => return None,
    };
    Some(CapabilitySpec {
        tool_id,
        capability,
    })
}

fn parameters(input: &CapabilityQueryInput, kind: &str) -> Result<Value, String> {
    let symbol = input
        .symbol
        .as_deref()
        .unwrap_or_default()
        .trim()
        .to_uppercase();
    if symbol.is_empty() && !matches!(kind, "market_news" | "index_levels" | "commodity") {
        return Err("CAP 查询需要有效的证券代码".into());
    }
    let today = Utc::now().date_naive();
    if kind == "market_news" {
        let query = input.query.as_deref().unwrap_or_default().trim();
        if query.is_empty() {
            return Err("新闻查询需要关键词".into());
        }
        let start_date = input
            .start_date
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| {
                (today - ChronoDuration::days(3))
                    .format("%Y-%m-%d")
                    .to_string()
            });
        let end_date = input
            .end_date
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| today.format("%Y-%m-%d").to_string());
        return Ok(
            json!({"query": query, "category": input.category.as_deref().unwrap_or("market"), "start_date": start_date, "end_date": end_date, "limit": input.limit.unwrap_or(10).clamp(1, 20)}),
        );
    }
    if kind == "index_levels" {
        let query = input.query.as_deref().unwrap_or_default().trim();
        let symbol = input.symbol.as_deref().unwrap_or_default().trim();
        if query.is_empty() && symbol.is_empty() {
            return Err("指数查询需要 query 或 symbol".into());
        }
        let mut value = Map::new();
        if !query.is_empty() {
            value.insert("query".into(), Value::String(query.into()));
        }
        if !symbol.is_empty() {
            value.insert("symbol".into(), Value::String(symbol.to_uppercase()));
        }
        value.insert(
            "market".into(),
            Value::String(input.market.as_deref().unwrap_or("US").into()),
        );
        value.insert(
            "interval".into(),
            Value::String(input.interval.as_deref().unwrap_or("tick").into()),
        );
        return Ok(Value::Object(value));
    }
    if kind == "commodity" {
        let commodity = input.commodity_name.as_deref().unwrap_or_default().trim();
        let symbol = input.symbol.as_deref().unwrap_or_default().trim();
        if commodity.is_empty() && symbol.is_empty() {
            return Err("商品查询需要 commodity_name 或 symbol".into());
        }
        let mut value = Map::new();
        if !commodity.is_empty() {
            value.insert("commodity_name".into(), Value::String(commodity.into()));
        }
        if !symbol.is_empty() {
            value.insert("symbol".into(), Value::String(symbol.into()));
        }
        let start_date = input
            .start_date
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| {
                (today - ChronoDuration::days(3))
                    .format("%Y-%m-%d")
                    .to_string()
            });
        let end_date = input
            .end_date
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| today.format("%Y-%m-%d").to_string());
        value.insert("start_date".into(), Value::String(start_date));
        value.insert("end_date".into(), Value::String(end_date));
        value.insert(
            "frequency".into(),
            Value::String(input.frequency.as_deref().unwrap_or("daily").into()),
        );
        return Ok(Value::Object(value));
    }
    let days = if kind == "series" {
        match input.range.as_deref() {
            Some("分时") => 1,
            Some("5日") => 7,
            Some("日K") => 90,
            Some("周K") => 365,
            Some("月K") => 1_800,
            Some("季K") => 2_400,
            Some("年K") => 3_650,
            _ => 90,
        }
    } else {
        30
    };
    let start = today - ChronoDuration::days(days);
    let start_date = input
        .start_date
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| start.format("%Y-%m-%d").to_string());
    let end_date = input
        .end_date
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| today.format("%Y-%m-%d").to_string());
    if matches!(kind, "series" | "core_event" | "capital_flow" | "sentiment") {
        let mut value = json!({
            "symbol": symbol,
            "start_date": start_date,
            "end_date": end_date,
        });
        if kind == "core_event" {
            if let Some(event_type) = input
                .event_type
                .as_deref()
                .filter(|value| !value.trim().is_empty())
            {
                value["event_type"] = Value::String(event_type.trim().into());
            }
        }
        return Ok(value);
    }
    Ok(json!({ "symbol": symbol }))
}

fn payload(value: &Value) -> Value {
    value
        .pointer("/result/data")
        .or_else(|| value.get("data"))
        .or_else(|| value.get("result"))
        .cloned()
        .unwrap_or_else(|| value.clone())
}

fn numeric_value(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str().and_then(|item| item.parse::<f64>().ok()))
}

fn cost(value: &Value) -> Option<Value> {
    let object = value.as_object()?;
    let unit = || {
        object
            .get("currency")
            .or_else(|| object.get("unit"))
            .or_else(|| object.get("cost_unit"))
            .and_then(Value::as_str)
            .unwrap_or("credits")
    };
    for key in [
        "qveris_cost",
        "qverisCost",
        "cost",
        "charged_credits",
        "credits_used",
        "fee",
    ] {
        let Some(candidate) = object.get(key) else {
            continue;
        };
        if let Some(amount) = candidate
            .as_f64()
            .or_else(|| candidate.as_str().and_then(|item| item.parse::<f64>().ok()))
        {
            if amount.is_finite() && amount >= 0.0 {
                return Some(json!({
                    "amount": amount,
                    "unit": unit(),
                }));
            }
        }
        if let Some(candidate) = candidate.as_object() {
            let amount = candidate
                .get("amount")
                .or_else(|| candidate.get("value"))
                .or_else(|| candidate.get("credits"))
                .or_else(|| candidate.get("chargedCredits"))
                .and_then(numeric_value);
            if let Some(amount) = amount.filter(|item| item.is_finite() && *item >= 0.0) {
                let candidate_unit = candidate
                    .get("currency")
                    .or_else(|| candidate.get("unit"))
                    .or_else(|| candidate.get("cost_unit"))
                    .and_then(Value::as_str)
                    .unwrap_or_else(unit);
                return Some(json!({"amount": amount, "unit": candidate_unit}));
            }
        }
    }
    for key in ["usage", "billing", "meta", "metadata", "result", "data"] {
        if let Some(found) = object.get(key).and_then(cost) {
            return Some(found);
        }
    }
    None
}

fn audit(
    spec: &CapabilitySpec,
    params: &Value,
    status: u16,
    duration_ms: u128,
    body: Option<&Value>,
    reason: Option<&str>,
) -> Value {
    let mut value = json!({
        "operation": "cap-call",
        "outcome": if (200..300).contains(&status) { "success" } else { "error" },
        "toolId": spec.tool_id,
        "capability": spec.capability,
        "status": status,
        "durationMs": duration_ms,
        "params": params,
    });
    if let Some(reason) = reason {
        value["reason"] = Value::String(reason.to_owned());
        value["detail"] = Value::String(reason.to_owned());
    }
    if let Some(body) = body {
        value["response"] = json!({
            "success": body.get("success").and_then(Value::as_bool),
            "statusCode": body.pointer("/result/status_code").or_else(|| body.get("status_code")),
            "cost": cost(body),
        });
        if let Some(found) = cost(body) {
            value["cost"] = found;
        }
    }
    value
}

pub fn error_audit(input: &CapabilityQueryInput, reason: &str) -> Value {
    let Some(spec) = spec(input.kind.trim()) else {
        return json!({
            "operation": "cap-call",
            "outcome": "error",
            "status": 400,
            "reason": reason,
            "detail": reason,
        });
    };
    let params = parameters(input, input.kind.trim()).unwrap_or_else(|_| json!({}));
    audit(&spec, &params, 502, 0, None, Some(reason))
}

fn execute(
    client: &Client,
    api_key: &str,
    base_url: &str,
    spec: &CapabilitySpec,
    params: &Value,
) -> Result<(Value, Value), String> {
    let url = format!(
        "{}/tools/execute?tool_id={}",
        base_url.trim_end_matches('/'),
        spec.tool_id
    );
    let started = std::time::Instant::now();
    let request = json!({
        "session_id": format!("foliomind_cap_{}", Uuid::new_v4()),
        "parameters": params,
        "max_response_size": MAX_RESPONSE_SIZE,
        "respond_with": "full",
    });
    let mut last_status = 502;
    for attempt in 0..=1 {
        let response = client
            .post(&url)
            .bearer_auth(api_key)
            .json(&request)
            .send()
            .map_err(|_| "金融数据渠道连接失败")?;
        let status = response.status().as_u16();
        last_status = status;
        let body = response
            .json::<Value>()
            .map_err(|_| "金融数据渠道返回内容无法解析")?;
        let nested_status = body
            .pointer("/result/status_code")
            .or_else(|| body.get("status_code"))
            .and_then(Value::as_u64)
            .unwrap_or(200);
        if (200..300).contains(&status) {
            if body.get("success").and_then(Value::as_bool) == Some(false) || nested_status >= 400 {
                return Err("金融数据渠道暂未返回可用结果".into());
            }
            return Ok((
                body.clone(),
                audit(
                    spec,
                    params,
                    status,
                    started.elapsed().as_millis(),
                    Some(&body),
                    None,
                ),
            ));
        }
        if attempt == 0 && matches!(status, 408 | 425 | 429 | 500 | 502 | 503 | 504) {
            thread::sleep(Duration::from_millis(500));
            continue;
        }
        let reason = if matches!(status, 401 | 403) {
            "金融数据凭据无效或无权限"
        } else {
            "金融数据渠道暂时不可用"
        };
        return Err(reason.into());
    }
    Err(format!("金融数据渠道暂时不可用（HTTP {last_status}）"))
}

pub fn query(
    api_key: &str,
    capability_base_url: &str,
    input: CapabilityQueryInput,
) -> Result<CapabilityQueryResult, String> {
    let kind = input.kind.trim();
    let primary = spec(kind).ok_or("没有对应的金融能力")?;
    let primary_params = parameters(&input, kind)?;
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|_| "无法初始化金融数据客户端")?;
    let (primary_body, primary_audit) = execute(
        &client,
        api_key,
        capability_base_url,
        &primary,
        &primary_params,
    )?;
    let data = if kind == "details" {
        let fundamentals = spec("fundamentals").expect("fundamentals spec");
        let fundamentals_params = parameters(&input, "fundamentals")?;
        let mut audits = vec![primary_audit];
        let fundamentals_data = match execute(
            &client,
            api_key,
            capability_base_url,
            &fundamentals,
            &fundamentals_params,
        ) {
            Ok((body, record)) => {
                audits.push(record);
                payload(&body)
            }
            Err(error) => {
                audits.push(error_audit(&input, &error));
                Value::Object(Map::new())
            }
        };
        let mut merged = payload(&primary_body)
            .as_object()
            .cloned()
            .unwrap_or_default();
        merged.insert("fundamentals".into(), fundamentals_data);
        return Ok(CapabilityQueryResult {
            data: Value::Object(merged),
            mode: "qveris-cap".into(),
            cache_hit: false,
            audits,
            tool_id: primary.tool_id.into(),
            capability: primary.capability.into(),
        });
    } else {
        payload(&primary_body)
    };
    Ok(CapabilityQueryResult {
        data,
        mode: "qveris-cap".into(),
        cache_hit: false,
        audits: vec![primary_audit],
        tool_id: primary.tool_id.into(),
        capability: primary.capability.into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_bounded_parameters_for_series() {
        let input = CapabilityQueryInput {
            kind: "series".into(),
            symbol: Some("600519".into()),
            range: None,
            start_date: None,
            end_date: None,
            event_type: None,
            query: None,
            category: None,
            market: None,
            interval: None,
            commodity_name: None,
            frequency: None,
            limit: None,
        };
        let value = parameters(&input, "series").unwrap();
        assert_eq!(value["symbol"], "600519");
        assert!(value["start_date"].as_str().unwrap().len() == 10);
        assert!(value["end_date"].as_str().unwrap().len() == 10);
    }

    #[test]
    fn unwraps_qveris_envelopes() {
        let value = json!({"result": {"data": {"price": 1.2}}});
        assert_eq!(payload(&value)["price"], 1.2);
    }

    #[test]
    fn rejects_missing_symbol() {
        let input = CapabilityQueryInput {
            kind: "quote".into(),
            symbol: None,
            range: None,
            start_date: None,
            end_date: None,
            event_type: None,
            query: None,
            category: None,
            market: None,
            interval: None,
            commodity_name: None,
            frequency: None,
            limit: None,
        };
        assert!(parameters(&input, "quote").is_err());
    }

    #[test]
    fn extracts_explicit_structured_cost_only() {
        assert_eq!(
            cost(&json!({"result": {"cost": {"value": "0.2", "cost_unit": "credits"}}})),
            Some(json!({"amount": 0.2, "unit": "credits"}))
        );
        assert_eq!(
            cost(&json!({"data": {"amount": 99.0, "price": 12.3}})),
            None
        );
    }
}
