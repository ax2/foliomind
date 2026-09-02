const numberValue = (value) => Number(value);
export const QUOTE_STALE_AFTER_MS = 15 * 60 * 1000;

/** A quote price is displayable only when the provider returned a finite positive value. */
export function isValidQuotePrice(value) {
  const number = numberValue(value);
  return Number.isFinite(number) && number > 0;
}

function timestampValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value < 10_000_000_000 ? value * 1000 : value;
  const text = String(value ?? "").trim();
  if (!text) return NaN;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const number = Number(text);
    return number < 10_000_000_000 ? number * 1000 : number;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : NaN;
}

export function quoteFreshness(value, now = Date.now(), staleAfterMs = QUOTE_STALE_AFTER_MS) {
  const timestamp = timestampValue(value);
  if (!Number.isFinite(timestamp)) return { state: "unknown", timestamp: null, ageMs: null };
  const ageMs = now - timestamp;
  // A provider clock can be a few minutes ahead. Treat a large future skew as
  // unknown instead of claiming that the quote is fresh.
  if (ageMs < -5 * 60 * 1000) return { state: "unknown", timestamp, ageMs };
  return { state: ageMs > staleAfterMs ? "stale" : "fresh", timestamp, ageMs };
}

export function formatQuoteFreshness(value, now = Date.now()) {
  const freshness = quoteFreshness(value, now);
  if (freshness.state === "unknown") return "数据时间未知";
  const time = new Date(freshness.timestamp).toLocaleString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return freshness.state === "stale" ? `可能已延迟 · 数据时间 ${time}` : `数据时间 ${time}`;
}

/**
 * Compact freshness copy for dense watchlist rows. The full timestamp remains
 * available through the row title and the evidence drawer, while this label
 * makes stale quotes visible without making the sidebar unreadable.
 */
export function formatCompactQuoteFreshness(value, now = Date.now()) {
  const freshness = quoteFreshness(value, now);
  if (freshness.state === "unknown") return "时间未知";
  const time = new Date(freshness.timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  return `${freshness.state === "stale" ? "可能延迟" : "新鲜"} · ${time}`;
}

export function formatPrice(value) {
  const number = numberValue(value);
  if (!Number.isFinite(number)) return "—";
  return number >= 1000 ? number.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : number >= 1 ? number.toFixed(2) : number.toFixed(4);
}

export function formatPercent(value) {
  const number = numberValue(value);
  return Number.isFinite(number) ? `${number >= 0 ? "+" : ""}${number.toFixed(2)}%` : "—";
}

/** Resolve a directional tone without treating missing data as up or down. */
export function changeToneClass(value) {
  const number = numberValue(value);
  if (!Number.isFinite(number)) return "";
  return number > 0 ? "up" : number < 0 ? "down" : "";
}

export function formatRefreshTime(value, now = Date.now()) {
  const timestamp = Date.parse(String(value ?? ""));
  if (!Number.isFinite(timestamp)) return "尚未更新";
  const age = Math.max(0, now - timestamp);
  const time = new Date(timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return age >= 120_000 ? `可能已过期 · 最近更新 ${time}` : `最近更新 ${time}`;
}

export function formatAmount(value, kind) {
  const number = numberValue(value);
  if (!Number.isFinite(number)) return "—";
  if (kind === "volume") return number >= 100_000_000 ? `${(number / 100_000_000).toFixed(2)} 亿股` : number >= 10_000 ? `${(number / 10_000).toFixed(2)} 万股` : `${number.toLocaleString("zh-CN")} 股`;
  if (kind === "turnover" || kind === "marketCap" || kind === "floatMarketCap") return number >= 100_000_000_000 ? `${(number / 100_000_000_000).toFixed(2)} 千亿` : number >= 100_000_000 ? `${(number / 100_000_000).toFixed(2)} 亿` : `${number.toLocaleString("zh-CN")} 元`;
  return number.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}

export function formatQuoteField(key, value) {
  if (value == null || value === "") return "—";
  if (["open", "previousClose", "high", "low"].includes(key)) return formatPrice(value);
  if (key === "turnoverRate") {
    const number = numberValue(value);
    return Number.isFinite(number) ? `${number.toFixed(2)}%` : "—";
  }
  if (["volumeRatio", "pe", "pb"].includes(key)) {
    const number = numberValue(value);
    return Number.isFinite(number) ? number.toFixed(2) : "—";
  }
  if (["grossMargin", "netMargin", "roe"].includes(key)) {
    const number = numberValue(value);
    if (!Number.isFinite(number)) return String(value);
    const percent = Math.abs(number) <= 1 ? number * 100 : number;
    return `${percent.toFixed(2)}%`;
  }
  if (["revenue", "netProfit"].includes(key)) return formatAmount(value, "turnover");
  if (key === "volume") return formatAmount(value, "volume");
  if (["turnover", "marketCap", "floatMarketCap"].includes(key)) return formatAmount(value, key);
  return String(value);
}
