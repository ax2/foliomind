use reqwest::blocking::Client;
use serde::Serialize;
use serde_json::{json, Value};
use std::{thread, time::Duration};
use uuid::Uuid;

pub const TOOL_ID: &str = "cn_financial_pro.trade_dates.v1";
pub const CAPABILITY_ID: &str = "REF.EXCHANGE_CALENDAR";
pub const SSE_MARKET_CODE: &str = "212001";
pub const SZSE_MARKET_CODE: &str = "212100";
pub const HKEX_MARKET_CODE: &str = "212200";
pub const CFFEX_MARKET_CODE: &str = "212020001";

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

fn normalized_market(value: &str) -> String {
    value.trim().to_uppercase()
}

fn inferred_cn_marketcode(symbol: &str) -> Option<&'static str> {
    let symbol = symbol.trim().to_uppercase();
    let code = symbol
        .strip_prefix("SH")
        .or_else(|| symbol.strip_prefix("SZ"))
        .unwrap_or(&symbol);
    if [
        "600", "601", "603", "605", "688", "689", "510", "511", "512", "513", "515", "516", "518",
        "588", "900",
    ]
    .iter()
    .any(|prefix| code.starts_with(prefix))
    {
        return Some(SSE_MARKET_CODE);
    }
    if [
        "000", "001", "002", "003", "159", "160", "161", "162", "163", "164", "165", "166", "167",
        "168", "169", "180", "181", "182", "184", "185", "186", "187", "188", "189", "200", "300",
        "301",
    ]
    .iter()
    .any(|prefix| code.starts_with(prefix))
    {
        return Some(SZSE_MARKET_CODE);
    }
    None
}

/// Resolve an explicit exchange or an unambiguous mainland A-share symbol.
/// Unknown/overseas markets fail closed so the scheduler never treats an SSE
/// holiday as the calendar for a different exchange.
pub fn marketcode_for_position(market: &str, symbol: &str) -> Result<&'static str, String> {
    let market = normalized_market(market);
    if market.contains("NASDAQ")
        || market.contains("NYSE")
        || market.contains("AMEX")
        || market.contains("美股")
        || market == "US"
    {
        return Err("当前自动复盘暂不支持美股交易日历，请改用手动复盘".into());
    }
    if market.contains("HKEX")
        || market.contains("港股")
        || market.contains("香港")
        || market == "HK"
    {
        return Ok(HKEX_MARKET_CODE);
    }
    if market.contains("CFFEX") || market.contains("中金所") {
        return Ok(CFFEX_MARKET_CODE);
    }
    if market == "深市" || market.contains("深交所") || market == "SZ" || market == "SZSE" {
        return Ok(SZSE_MARKET_CODE);
    }
    if market == "沪市" || market.contains("上交所") || market == "SH" || market == "SSE" {
        return Ok(SSE_MARKET_CODE);
    }
    if market.contains("A股") || market.contains("沪深") || market.is_empty() || market == "自定义"
    {
        return inferred_cn_marketcode(symbol)
            .ok_or_else(|| format!("无法根据 {symbol} 确定 A 股交易所"));
    }
    Err(format!(
        "当前自动复盘暂不支持 {market} 交易日历，请改用手动复盘"
    ))
}

pub fn marketcodes_for_positions<'a, I>(positions: I) -> Result<Vec<&'static str>, String>
where
    I: IntoIterator<Item = (&'a str, &'a str)>,
{
    let mut codes = positions
        .into_iter()
        .map(|(market, symbol)| marketcode_for_position(market, symbol))
        .collect::<Result<Vec<_>, _>>()?;
    codes.sort_by_key(|code| match *code {
        SSE_MARKET_CODE => 0,
        SZSE_MARKET_CODE => 1,
        HKEX_MARKET_CODE => 2,
        CFFEX_MARKET_CODE => 3,
        _ => 4,
    });
    codes.dedup();
    Ok(codes)
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
    if !matches!(
        marketcode,
        SSE_MARKET_CODE | SZSE_MARKET_CODE | HKEX_MARKET_CODE | CFFEX_MARKET_CODE
    ) {
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

    #[test]
    fn resolves_exchange_without_guessing_overseas_or_unknown_symbols() {
        assert_eq!(
            marketcode_for_position("沪深", "600519"),
            Ok(SSE_MARKET_CODE)
        );
        assert_eq!(
            marketcode_for_position("沪深", "300750"),
            Ok(SZSE_MARKET_CODE)
        );
        assert_eq!(
            marketcode_for_position("深市", "600519"),
            Ok(SZSE_MARKET_CODE)
        );
        assert!(marketcode_for_position("NASDAQ", "AAPL").is_err());
        assert!(marketcode_for_position("沪深", "999999").is_err());
        assert_eq!(
            marketcodes_for_positions([("沪深", "600519"), ("沪深", "300750")]),
            Ok(vec![SSE_MARKET_CODE, SZSE_MARKET_CODE])
        );
    }
}
