export const BRIEFING_TIME_ZONE = "Asia/Shanghai";
export const SSE_MARKET_CODE = "212001";
export const SZSE_MARKET_CODE = "212100";
export const HKEX_MARKET_CODE = "212200";
export const CFFEX_MARKET_CODE = "212020001";
export const DEFAULT_BRIEFING_SCHEDULE = Object.freeze({ enabled: false, closeTime: "15:35", timeZone: BRIEFING_TIME_ZONE, retryMinutes: 15, lastAttemptAt: "", lastSuccessKey: "", lastResult: "idle", lastError: "", calendarDate: "", calendarStatus: "unknown", calendarCheckedAt: "", calendarSource: "", calendarToolId: "" });

const RESULT_STATES = new Set(["idle", "success", "waiting-data", "waiting-calendar", "market-closed", "error"]);
const CALENDAR_STATES = new Set(["unknown", "trading", "closed", "error"]);

function inferCnMarketCode(symbol) {
  const value = String(symbol || "").trim().toUpperCase().replace(/^(SH|SZ)/, "");
  if (["600", "601", "603", "605", "688", "689", "510", "511", "512", "513", "515", "516", "518", "588", "900"].some((prefix) => value.startsWith(prefix))) return SSE_MARKET_CODE;
  if (["000", "001", "002", "003", "159", "160", "161", "162", "163", "164", "165", "166", "167", "168", "169", "180", "181", "182", "184", "185", "186", "187", "188", "189", "200", "300", "301"].some((prefix) => value.startsWith(prefix))) return SZSE_MARKET_CODE;
  return "";
}

export function marketCodeForPosition(position = {}) {
  const market = String(position?.market || "").trim().toUpperCase();
  if (["NASDAQ", "NYSE", "AMEX", "美股", "US"].some((value) => market.includes(value) || market === value)) throw new Error("当前自动复盘暂不支持美股交易日历，请改用手动复盘");
  if (market.includes("HKEX") || market.includes("港股") || market.includes("香港") || market === "HK") return HKEX_MARKET_CODE;
  if (market.includes("CFFEX") || market.includes("中金所")) return CFFEX_MARKET_CODE;
  if (market === "深市" || market.includes("深交所") || market === "SZ" || market === "SZSE") return SZSE_MARKET_CODE;
  if (market === "沪市" || market.includes("上交所") || market === "SH" || market === "SSE") return SSE_MARKET_CODE;
  if (market.includes("A股") || market.includes("沪深") || !market || market === "自定义") {
    const code = inferCnMarketCode(position?.symbol);
    if (code) return code;
    throw new Error(`无法根据 ${String(position?.symbol || "该标的")} 确定 A 股交易所`);
  }
  throw new Error(`当前自动复盘暂不支持 ${market} 交易日历，请改用手动复盘`);
}

export function marketCodesForPositions(positions = []) {
  const codes = [...new Set((Array.isArray(positions) ? positions : []).map(marketCodeForPosition))];
  const order = new Map([[SSE_MARKET_CODE, 0], [SZSE_MARKET_CODE, 1], [HKEX_MARKET_CODE, 2], [CFFEX_MARKET_CODE, 3]]);
  return codes.sort((left, right) => (order.get(left) ?? 4) - (order.get(right) ?? 4));
}

function dateParts(value, timeZone = BRIEFING_TIME_ZONE) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const values = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return { day: `${values.year}-${values.month}-${values.day}`, weekday: values.weekday, minutes: Number(values.hour) * 60 + Number(values.minute) };
}

export function normalizeBriefingSchedule(value = {}) {
  const closeTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value?.closeTime || "")) ? String(value.closeTime) : DEFAULT_BRIEFING_SCHEDULE.closeTime;
  const retry = Number(value?.retryMinutes);
  return {
    enabled: value?.enabled === true, closeTime, timeZone: BRIEFING_TIME_ZONE,
    retryMinutes: Number.isInteger(retry) ? Math.min(60, Math.max(5, retry)) : DEFAULT_BRIEFING_SCHEDULE.retryMinutes,
    lastAttemptAt: String(value?.lastAttemptAt || "").slice(0, 64), lastSuccessKey: String(value?.lastSuccessKey || "").slice(0, 128),
    lastResult: RESULT_STATES.has(value?.lastResult) ? value.lastResult : "idle", lastError: String(value?.lastError || "").trim().slice(0, 512),
    calendarDate: /^\d{4}-\d{2}-\d{2}$/.test(String(value?.calendarDate || "")) ? String(value.calendarDate) : "",
    calendarStatus: CALENDAR_STATES.has(value?.calendarStatus) ? value.calendarStatus : "unknown",
    calendarCheckedAt: String(value?.calendarCheckedAt || "").slice(0, 64), calendarSource: String(value?.calendarSource || "").slice(0, 128), calendarToolId: String(value?.calendarToolId || "").slice(0, 256),
  };
}

export function briefingSlot({ now = new Date(), schedule = DEFAULT_BRIEFING_SCHEDULE, reviews = [], positionCount = 0 } = {}) {
  const config = normalizeBriefingSchedule(schedule);
  const local = dateParts(now, config.timeZone);
  if (!local) return { status: "invalid-time" };
  const key = `close:${local.day}`;
  if (!config.enabled) return { status: "disabled", key, tradingDate: local.day };
  if (!positionCount) return { status: "no-positions", key, tradingDate: local.day };
  const [hour, minute] = config.closeTime.split(":").map(Number);
  if (local.minutes < hour * 60 + minute) return { status: "not-due", key, tradingDate: local.day };
  if (config.lastSuccessKey === key || reviews.some((review) => review?.kind === "close" && review?.tradingDate === local.day)) return { status: "completed", key, tradingDate: local.day };
  if (config.calendarDate !== local.day || !["trading", "closed"].includes(config.calendarStatus)) return { status: "calendar-needed", key, tradingDate: local.day };
  if (config.calendarStatus === "closed") return { status: "market-closed", key, tradingDate: local.day };
  const lastAttempt = Date.parse(config.lastAttemptAt);
  if (Number.isFinite(lastAttempt) && new Date(now).getTime() - lastAttempt < config.retryMinutes * 60_000) return { status: "retry-wait", key, tradingDate: local.day };
  return { status: "due", key, tradingDate: local.day };
}

export function hasFreshPortfolioQuote({ positions = [], liveQuotes = {}, now = new Date(), timeZone = BRIEFING_TIME_ZONE } = {}) {
  const today = dateParts(now, timeZone)?.day;
  if (!today) return false;
  return positions.some((position) => {
    const quote = liveQuotes[position?.symbol];
    return Number.isFinite(Number(quote?.price)) && dateParts(quote?.asOf, timeZone)?.day === today;
  });
}

export function nextBriefingLabel(schedule, now = new Date()) {
  const config = normalizeBriefingSchedule(schedule);
  if (!config.enabled) return "未启用";
  const local = dateParts(now, config.timeZone);
  if (!local) return `交易日 ${config.closeTime}`;
  return `交易日 ${config.closeTime}（北京时间）`;
}
