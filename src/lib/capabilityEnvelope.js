/**
 * Shared, bounded handling for provider response envelopes.
 *
 * CAP providers may wrap the same domain payload in `result`, `payload` and
 * `data` more than once. Only these documented transport keys are traversed;
 * arbitrary objects are never walked. Once a likely domain record is found we
 * stop so a record's own `data` field is preserved.
 */
export const CAPABILITY_ENVELOPE_KEYS = Object.freeze(["data", "payload", "result"]);
export const MAX_CAPABILITY_ENVELOPE_DEPTH = 4;

const CAPABILITY_LEAF_KEYS = new Set([
  "price", "lastPrice", "last_price", "last", "close", "open", "high", "low", "volume", "turnover", "turnover_amount",
  "symbol", "code", "name", "title", "headline", "description", "summary", "date", "time", "timestamp", "event_date",
  "events", "news", "articles", "series", "bars", "rows", "items", "indices", "commodities", "quotes", "dates",
  "pe_ttm", "pb_ratio", "ps_ratio_ttm", "ev_to_ebitda", "market_cap", "main_net", "net_flow", "commodity_name",
  "company", "fundamentals", "capitalFlow", "capital_flow", "mainNetInflow", "main_net_inflow", "sentiment", "sentimentScore",
  "tradingDates", "trading_dates",
]);

export function hasCapabilityLeaf(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
    && Object.keys(value).some((key) => CAPABILITY_LEAF_KEYS.has(key));
}

export function capabilityData(value, depth = 0) {
  if (value == null || depth > MAX_CAPABILITY_ENVELOPE_DEPTH || typeof value !== "object" || Array.isArray(value) || hasCapabilityLeaf(value)) return value;
  for (const key of CAPABILITY_ENVELOPE_KEYS) {
    if (!Object.hasOwn(value, key) || value[key] === value) continue;
    const nested = capabilityData(value[key], depth + 1);
    if (nested !== undefined && nested !== null) return nested;
  }
  return value;
}

export function capabilityStatusCode(value, depth = 0) {
  if (value == null || depth > MAX_CAPABILITY_ENVELOPE_DEPTH || typeof value !== "object") return null;
  for (const key of ["status_code", "statusCode", "http_status", "httpStatus"]) {
    const candidate = Number(value[key]);
    if (Number.isFinite(candidate)) return candidate;
  }
  for (const key of CAPABILITY_ENVELOPE_KEYS) {
    if (Object.hasOwn(value, key)) {
      const nested = capabilityStatusCode(value[key], depth + 1);
      if (nested != null) return nested;
    }
  }
  return null;
}

export function capabilityExplicitFailure(value, depth = 0) {
  if (value == null || depth > MAX_CAPABILITY_ENVELOPE_DEPTH || typeof value !== "object") return false;
  if (value.success === false) return true;
  return CAPABILITY_ENVELOPE_KEYS.some((key) => Object.hasOwn(value, key) && capabilityExplicitFailure(value[key], depth + 1));
}

export function capabilitySource(value, depth = 0) {
  if (value == null || depth > MAX_CAPABILITY_ENVELOPE_DEPTH || typeof value !== "object" || Array.isArray(value)) return null;
  const meta = value._meta;
  if (meta && typeof meta === "object") {
    const source = meta.source_provider || meta.source_tool_id || meta.source || meta.provider;
    if (source) return String(source);
  }
  for (const key of CAPABILITY_ENVELOPE_KEYS) {
    if (Object.hasOwn(value, key)) {
      const nested = capabilitySource(value[key], depth + 1);
      if (nested) return nested;
    }
  }
  return null;
}

export function capabilityArray(value, fields = []) {
  const source = capabilityData(value);
  if (Array.isArray(source)) return source;
  for (const field of fields) if (Array.isArray(source?.[field])) return source[field];
  return [];
}
