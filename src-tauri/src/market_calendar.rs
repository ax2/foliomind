use reqwest::blocking::Client;
use serde::Serialize;
use serde_json::{json, Value};
use std::{thread, time::Duration};
use uuid::Uuid;

pub const TOOL_ID: &str = "cn_financial_pro.trade_dates.v1";
pub const CAPABILITY_ID: &str = "REF.EXCHANGE_CALENDAR";
pub const SSE_MARKET_CODE: &str = "212001";

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TradingCalendarResult {
    pub queried_date: String,
    pub marketcode: String,
    pub is_trading_day: bool,
    pub trading_dates: Vec<String>,
    pub source: String,
    pub tool_id: String,
    pub capability: String,
}

fn valid_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit())
}

fn parse_result(
    value: &Value,
    queried_date: &str,
    marketcode: &str,
) -> Result<TradingCalendarResult, String> {
    if value.get("success").and_then(Value::as_bool) == Some(false) {
        return Err("交易日历渠道暂未返回可用结果".into());
    }
    let values = value
        .pointer("/result/data/time")
        .or_else(|| value.pointer("/data/time"))
        .and_then(Value::as_array)
        .ok_or("交易日历返回结构无法识别")?;
    let trading_dates = values
        .iter()
        .filter_map(Value::as_str)
        .filter(|date| valid_date(date))
        .map(str::to_owned)
        .collect::<Vec<_>>();
    Ok(TradingCalendarResult {
        queried_date: queried_date.into(),
        marketcode: marketcode.into(),
        is_trading_day: trading_dates.iter().any(|date| date == queried_date),
        trading_dates,
        source: "cn_financial_pro".into(),
        tool_id: TOOL_ID.into(),
        capability: CAPABILITY_ID.into(),
    })
}

pub fn fetch_trading_calendar(
    api_key: &str,
    capability_base_url: &str,
    queried_date: &str,
    marketcode: Option<&str>,
) -> Result<TradingCalendarResult, String> {
    if !valid_date(queried_date) {
        return Err("交易日历日期参数无效".into());
    }
    let marketcode = marketcode.unwrap_or(SSE_MARKET_CODE).trim();
    if !matches!(marketcode, "212001" | "212100" | "212200" | "212020001") {
        return Err("交易日历市场参数无效".into());
    }
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| "无法初始化交易日历客户端")?;
    let url = format!(
        "{}/tools/execute?tool_id={}",
        capability_base_url.trim_end_matches('/'),
        TOOL_ID
    );
    let payload = json!({
        "session_id": format!("foliomind_calendar_{}", Uuid::new_v4()),
        "parameters": { "marketcode": marketcode, "startdate": queried_date, "enddate": queried_date, "mode": 1, "date_type": 0, "period": "D", "date_format": 0 },
        "max_response_size": 20_480,
        "respond_with": "full"
    });
    for attempt in 0..=1 {
        let response = client
            .post(&url)
            .bearer_auth(api_key)
            .json(&payload)
            .send()
            .map_err(|_| "交易日历连接失败")?;
        let status = response.status();
        if status.is_success() {
            let value = response
                .json::<Value>()
                .map_err(|_| "交易日历返回内容无法解析")?;
            return parse_result(&value, queried_date, marketcode);
        }
        if attempt == 0 && matches!(status.as_u16(), 408 | 425 | 429 | 500 | 502 | 503 | 504) {
            thread::sleep(Duration::from_millis(500));
            continue;
        }
        return Err(if status.as_u16() == 401 || status.as_u16() == 403 {
            "交易日历凭据无效或无权限".into()
        } else {
            format!("交易日历暂不可用（HTTP {}）", status.as_u16())
        });
    }
    Err("交易日历暂不可用".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_trading_and_closed_days_without_guessing() {
        let value =
            json!({"success": true, "result": {"data": {"time": ["2026-08-28", "2026-08-31"]}}});
        assert!(
            parse_result(&value, "2026-08-31", SSE_MARKET_CODE)
                .unwrap()
                .is_trading_day
        );
        assert!(
            !parse_result(&value, "2026-08-30", SSE_MARKET_CODE)
                .unwrap()
                .is_trading_day
        );
    }

    #[test]
    fn rejects_malformed_or_failed_envelopes() {
        assert!(parse_result(&json!({"success": false}), "2026-08-31", SSE_MARKET_CODE).is_err());
        assert!(parse_result(
            &json!({"success": true, "data": {}}),
            "2026-08-31",
            SSE_MARKET_CODE
        )
        .is_err());
    }
}
