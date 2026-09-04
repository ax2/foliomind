import { create } from "zustand";
import { skills, stocks, watchGroups } from "../data/market.js";
import { defaultMonitorRules, strategyFor } from "../data/monitorStrategies.js";
import { ABORTED_CODE, abortPi, askPi, isDesktopRuntime } from "../lib/piRuntime.js";
import { getDeveloperVariable, isLocalWebRuntime } from "../lib/localHost.js";
import { loadIntegrationStatus, queryCapabilityData, queryTradingCalendar } from "../lib/integrations.js";
import { loadUserState, mergeUserStateChanges, normalizeUserState, saveUserState } from "../lib/userState.js";
import { friendlyDataMessage } from "../lib/friendlyMessages.js";
import { hasModelAccess, hasRealDataAccess } from "../lib/dataStatus.js";
import { normalizePortfolioPosition, portfolioAlertChecks } from "../lib/portfolio.js";
import { sendSystemNotification } from "../lib/systemNotifications.js";
import { conditionPrompt, conditionsForRule, evaluateRuleConditions, normalizeConditions, ruleConditionSummary } from "../lib/monitorConditions.js";
import { normalizeWatchlistItem } from "../lib/watchlist.js";
import { createPortfolioReviewSnapshot } from "../lib/portfolioReview.js";
import { briefingSlot, DEFAULT_BRIEFING_SCHEDULE, hasFreshPortfolioQuote, marketCodesForPositions, normalizeBriefingSchedule, premarketSlot, SSE_MARKET_CODE } from "../lib/briefingSchedule.js";
import { buildAttributionPrompt, normalizeAttribution, normalizeAttributionEvidence, portfolioAttributionContext } from "../lib/anomalyAttribution.js";
import { collectEventReminders } from "../lib/eventReminders.js";
import { isValidQuotePrice, marketRegionFor, quoteForSymbol, quoteSymbolKey } from "../lib/quoteFormatting.js";
import { isMonitorRuleExpired, normalizeMonitorExpiresAt, normalizeMonitorTriggerMode } from "../lib/monitorLifecycle.js";
import { safeExternalUrl } from "../lib/urlSafety.js";
import { buildPremarketBriefing, normalizePremarketCommodities, normalizePremarketEvents, normalizePremarketIndices, normalizePremarketMarketNews, normalizePremarketNews } from "../lib/premarketBriefing.js";

const RUNNING_REPLY = "Pi 正在分析…";
export const MONITOR_INTERVAL_MS = 30_000;
// Keep the polling tiers explicit: selected/held/actively monitored symbols
// get a low-latency refresh while the rest of the watchlist is refreshed less
// often to stay within provider rate and cost limits.
export const LIVE_QUOTE_PRIORITY_REFRESH_INTERVAL_MS = 15_000;
export const LIVE_QUOTE_FULL_REFRESH_INTERVAL_MS = 180_000;
// Backward-compatible alias for integrations that imported the old constant.
export const LIVE_QUOTE_REFRESH_INTERVAL_MS = LIVE_QUOTE_FULL_REFRESH_INTERVAL_MS;
export const BRIEFING_RECONCILE_INTERVAL_MS = 60_000;
const DEFAULT_LIVE_QUOTE_CONCURRENCY = 2;
const MAX_LIVE_QUOTE_CONCURRENCY = 4;
const MAX_MONITOR_HISTORY = 500;
const defaultWatchlist = watchGroups.flatMap((group) => group.items.map((item) => normalizeWatchlistItem({ ...item, group: group.label }))).slice(0, 8);
let persistenceQueue = Promise.resolve();
let userStateHydrationPromise = null;
let lastPersistedState = null;
let lastLocalSnapshot = null;
let liveRequestGeneration = 0;
let liveRequestController = null;
const selectedQuoteGenerations = new Map();
const selectedQuoteControllers = new Map();
let detailsRequestGeneration = 0;
let detailsRequestController = null;
let detailsRequestSymbol = "";
let seriesRequestGeneration = 0;
let seriesRequestController = null;
let seriesRequestContext = null;
let eventsRequestGeneration = 0;
let eventsRequestController = null;
let premarketRequestGeneration = 0;
let premarketRequestController = null;
const anomalyAttributionGenerations = new Map();

function abortController(controller) {
  if (!controller || controller.signal.aborted) return;
  controller.abort("superseded");
}

function abortPendingDataRequests() {
  abortController(liveRequestController);
  liveRequestController = null;
  for (const controller of selectedQuoteControllers.values()) abortController(controller);
  selectedQuoteControllers.clear();
  abortController(detailsRequestController);
  detailsRequestController = null;
  detailsRequestSymbol = "";
  abortController(seriesRequestController);
  seriesRequestController = null;
  seriesRequestContext = null;
  abortController(eventsRequestController);
  eventsRequestController = null;
  abortController(premarketRequestController);
  premarketRequestController = null;
}

function persistenceState(snapshot) {
  return normalizeUserState({ revision: lastPersistedState?.revision || 0, watchlist: snapshot.watchlist, monitorRules: snapshot.rules, notifications: snapshot.notifications, portfolioPositions: snapshot.portfolioPositions, monitorHistory: snapshot.monitorHistory, portfolioReviews: snapshot.portfolioReviews, briefingSchedule: snapshot.briefingSchedule, premarketBriefing: snapshot.premarketBriefing, installedSkillIds: (snapshot.skillItems || []).filter((item) => item?.installed === true).map((item) => item.id) });
}
const samePersistenceState = (left, right) => JSON.stringify(left) === JSON.stringify(right);
function persistSnapshot(snapshot) {
  persistenceQueue = persistenceQueue.catch(() => {}).then(async () => {
    // Read at execution time instead of persisting the caller's stale snapshot.
    // Background refreshes can enqueue a save immediately before a user action
    // (for example installing a skill); writing that captured snapshot later
    // would otherwise overwrite the newer action in the Host state file.
    const local = persistenceState(useLabStore.getState());
    const candidate = lastPersistedState && lastLocalSnapshot ? mergeUserStateChanges(lastLocalSnapshot, local, lastPersistedState) : local;
    try {
      const saved = await saveUserState(candidate, { baseState: lastPersistedState || candidate });
      lastPersistedState = saved && typeof saved === "object" ? normalizeUserState(saved) : { ...candidate, revision: candidate.revision + 1 };
      lastLocalSnapshot = local;
      return lastPersistedState;
    } catch (error) {
      useLabStore.setState((current) => current.settingsNotice?.type === "error" ? current : { settingsNotice: { type: "error", action: error?.code === "USER_STATE_MERGE_CONFLICT" ? "reload" : "retry", text: error?.code === "USER_STATE_MERGE_CONFLICT" ? "用户数据已在另一窗口修改，请重新读取后再操作" : "本地数据暂时无法保存，请稍后重试" } });
      // Do not let a mutating action report success when the canonical state
      // was not written. Callers that await a mutation can surface the
      // recoverable error; fire-and-forget notifications use an explicit
      // catch at their call site so the browser never gets an unhandled
      // rejection.
      throw error;
    }
  });
  return persistenceQueue;
}
function nowIso() { return new Date().toISOString(); }
function createId(prefix) { return `${prefix}-${typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`}`; }
function skillItemsForIds(items, installedSkillIds) {
  const installed = new Set(Array.isArray(installedSkillIds) ? installedSkillIds : items.filter((item) => item.installed).map((item) => item.id));
  return items.map((item) => ({ ...item, installed: installed.has(item.id) }));
}
function qverisSymbol(value, market = "") {
  const raw = String(value || "").trim().toUpperCase();
  if (!raw) return raw;
  if (/\.(SH|SS|SZ|BJ)$/.test(raw)) return raw.replace(/\.SS$/, ".SH");
  const marketText = String(market || "").trim();
  const inferChina = !marketText || marketRegionFor(marketText) === "cn";
  if (inferChina && /^(600|601|603|605|688|689)\d{3}$/.test(raw)) return `${raw}.SH`;
  if (inferChina && /^(000|001|002|003|300|301)\d{3}$/.test(raw)) return `${raw}.SZ`;
  return raw;
}
function marketContext(item) {
  const market = String(item?.market || "").toLocaleUpperCase("zh-CN");
  const region = marketRegionFor(market);
  if (region === "us") return "美股";
  if (region === "hk") return "港股";
  if (region === "cn" || !market) return "A股";
  return "未知市场";
}
function dataItemForSymbol(state, symbol) {
  const normalized = String(symbol || "").trim().toUpperCase();
  if (!normalized) return null;
  return state.watchlist.find((item) => String(item?.symbol || "").trim().toUpperCase() === normalized)
    || stocks[normalized]
    || { symbol: normalized, name: normalized, market: "", category: "" };
}
function findJsonObject(text) {
  const source = String(text ?? "");
  const first = source.indexOf("{");
  const last = source.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try {
      const value = JSON.parse(source.slice(first, last + 1));
      if (value && typeof value === "object") return value;
    } catch { /* Fall back to nested object boundaries. */ }
  }
  for (let end = source.lastIndexOf("}"); end >= 0; end -= 1) {
    const start = source.lastIndexOf("{", end);
    if (start < 0) break;
    try { const value = JSON.parse(source.slice(start, end + 1)); if (value && typeof value === "object") return value; } catch { /* Try the next boundary. */ }
  }
  return null;
}
function findJsonArray(text) {
  const source = String(text ?? "");
  const first = source.indexOf("[");
  const last = source.lastIndexOf("]");
  if (first >= 0 && last > first) {
    try { const value = JSON.parse(source.slice(first, last + 1)); if (Array.isArray(value)) return value; } catch { /* Fall back to nested array boundaries. */ }
  }
  return [];
}
function normalizeRule(rule) {
  const strategy = strategyFor(rule.strategyId);
  const conditions = normalizeConditions(rule.conditions, strategy.id);
  const firstValue = conditions[0]?.value;
  const threshold = Number.isFinite(Number(rule.threshold)) ? Number(rule.threshold) : Number.isFinite(Number(firstValue)) ? Number(firstValue) : strategy.defaultThreshold;
  const scope = rule.scope === "watchlist" ? "watchlist" : "symbol";
  const symbol = scope === "watchlist" ? "*" : String(rule.symbol ?? "600519");
  const lastSignalBySymbol = Object.fromEntries(Object.entries(rule.lastSignalBySymbol || {})
    .map(([key, value]) => [String(key).trim().toUpperCase(), value])
    .filter(([key, value]) => key && typeof value === "boolean")
    .slice(0, 200));
  return { id: String(rule.id ?? createId("rule")), scope, symbol, strategyId: strategy.id, conditions, logic: String(rule.logic || "AND").toUpperCase() === "OR" ? "OR" : "AND", threshold, intervalSeconds: Math.max(15, Math.min(86_400, Number(rule.intervalSeconds) || 300)), enabled: rule.enabled !== false, lastCheckedAt: rule.lastCheckedAt ?? null, lastTriggeredAt: rule.lastTriggeredAt ?? null, lastSignalTriggered: typeof rule.lastSignalTriggered === "boolean" ? rule.lastSignalTriggered : null, lastSignalBySymbol, triggerMode: normalizeMonitorTriggerMode(rule.triggerMode), expiresAt: normalizeMonitorExpiresAt(rule.expiresAt) };
}
function notificationFromResult(rule, item, result, reply) {
  const strategy = strategyFor(rule.strategyId);
  const body = String(result.summary || result.body || reply.text || "检查完成，请打开对话查看完整的来源与审计记录。").trim();
  const dataServiceMode = ["pi-rpc", "pi-local-host", "standalone-dev-host"].includes(reply.mode);
  return { id: createId("notification"), kind: "monitor", symbol: String(item?.symbol || rule.symbol || ""), name: String(item?.name || ""), ruleId: String(rule.id || ""), title: String(result.title || `${item?.name || rule.symbol} · ${strategy.name}`), body: body.slice(0, 4096), severity: ["info", "warning", "critical"].includes(result.severity) ? result.severity : "info", createdAt: nowIso(), read: false, source: dataServiceMode ? "data-service" : "browser-demo" };
}

function portfolioAlertNotification(position, alert) {
  const price = Number(alert.currentPrice).toFixed(2);
  const target = Number(alert.target).toFixed(2);
  const asOf = alert.asOf || "数据时间未返回";
  return {
    id: createId("portfolio-alert"),
    kind: "portfolio-alert",
    symbol: String(position.symbol || ""),
    name: String(position.name || ""),
    title: `${position.name} · ${alert.label}价已到达`,
    body: `${alert.label}价 ${target}，当前真实价格 ${price}；数据截至 ${asOf}，来源 ${alert.source}。请结合自己的交易计划判断，不构成投资建议。`,
    severity: alert.severity,
    createdAt: nowIso(),
    read: false,
    source: "data-service",
  };
}

function hasPortfolioPlan(position) {
  return Boolean(position?.planThesis || position?.planHorizon || position?.takeProfitPrice != null || position?.stopLossPrice != null);
}

function appendPortfolioPlanAction(position, type, note = "") {
  const at = nowIso();
  const status = type === "executed" ? "executed" : type === "archived" ? "archived" : "active";
  const defaultNote = type === "executed" ? "用户确认已执行计划" : type === "reopened" ? "重新开启计划跟踪" : type === "created" ? "建立交易计划" : type === "adjusted" ? "调整交易计划参数" : "更新交易计划";
  return {
    ...position,
    planStatus: status,
    planCreatedAt: position.planCreatedAt || at,
    planUpdatedAt: at,
    planActions: [{ id: createId("plan-action"), type, at, note: String(note || defaultNote).slice(0, 512) }, ...(position.planActions || [])].slice(0, 20),
  };
}

function portfolioPlanChanged(previous, next) {
  return Boolean(previous) && (
    previous.planThesis !== next.planThesis
    || previous.planHorizon !== next.planHorizon
    || previous.takeProfitPrice !== next.takeProfitPrice
    || previous.stopLossPrice !== next.stopLossPrice
  );
}

function mergeLiveQuotesWithPortfolio(state, quotes) {
  let portfolioPositions = state.portfolioPositions;
  let notifications = state.notifications;
  let portfolioChanged = false;
  const delivered = [];
  for (const position of state.portfolioPositions) {
    const quote = quoteForSymbol(quotes, position.symbol);
    if (!quote) continue;
    const checks = portfolioAlertChecks(position, quote);
    const nextPosition = { ...position, ...checks.updates };
    if (nextPosition.takeProfitTriggered !== position.takeProfitTriggered || nextPosition.stopLossTriggered !== position.stopLossTriggered) {
      if (!portfolioChanged) portfolioPositions = [...state.portfolioPositions];
      portfolioPositions[state.portfolioPositions.indexOf(position)] = nextPosition;
      portfolioChanged = true;
    }
    if (checks.alerts.length) {
      const nextNotifications = checks.alerts.map((alert) => portfolioAlertNotification(position, alert));
      notifications = [...nextNotifications, ...notifications].slice(0, 500);
      delivered.push(...nextNotifications);
    }
  }
  return { liveQuotes: { ...state.liveQuotes, ...quotes }, portfolioPositions, notifications, portfolioChanged, delivered };
}

function rollbackPortfolioAlertMutation(current, previousPositions, optimisticPositions, generatedNotifications) {
  const previousById = new Map((previousPositions || []).map((position) => [position.id, position]));
  const optimisticById = new Map((optimisticPositions || []).map((position) => [position.id, position]));
  const restoredPositions = current.portfolioPositions.map((position) => {
    const previous = previousById.get(position.id);
    const optimistic = optimisticById.get(position.id);
    if (previous && optimistic && JSON.stringify(position) === JSON.stringify(optimistic)) return previous;
    return position;
  });
  const generatedIds = new Set((generatedNotifications || []).map((notification) => notification.id));
  return {
    portfolioPositions: restoredPositions,
    notifications: generatedIds.size ? current.notifications.filter((notification) => !generatedIds.has(notification.id)) : current.notifications,
  };
}
function monitorHistoryFromResult(rule, item, result, reply, checkedAt, evaluation = null, outcome = null) {
  const triggered = typeof result?.triggered === "boolean" ? result.triggered : null;
  return {
    id: createId("monitor-check"),
    ruleId: rule.id,
    symbol: String(item?.symbol || rule.symbol || ""),
    scope: rule.scope || "symbol",
    checkedAt,
    outcome: outcome || (triggered === true ? "triggered" : triggered === false ? "not_triggered" : "unknown"),
    triggered,
    title: String(result?.title || `${item?.name || rule.symbol} · ${strategyFor(rule.strategyId).name}`),
    summary: String(result?.summary || result?.body || "数据服务未返回完整条件结论。").slice(0, 4096),
    severity: ["info", "warning", "critical"].includes(result?.severity) ? result.severity : "info",
    source: ["pi-rpc", "pi-local-host", "standalone-dev-host"].includes(reply?.mode) ? "data-service" : "browser-demo",
    asOf: String(result?.asOf || ""),
    conditionResults: Array.isArray(evaluation?.results) ? evaluation.results : [],
    audits: Array.isArray(reply?.audits) ? reply.audits.slice(0, 12) : [],
  };
}
function quoteFromReply(text) {
  const value = findJsonObject(text);
  const structuredPrice = value && numberOrNull(value.price);
  if (value && structuredPrice != null && structuredPrice > 0) {
    return {
      price: structuredPrice,
      change: numberOrNull(value.change),
      asOf: String(value.asOf || ""),
      source: String(value.source || "数据服务"),
      series: Array.isArray(value.series) ? value.series : [],
      fundamentals: value.fundamentals && typeof value.fundamentals === "object" ? value.fundamentals : {},
      companyDescription: typeof value.companyDescription === "string" ? value.companyDescription : "",
    };
  }
  const source = String(text ?? "");
  const priceMatch = source.match(/(?:最新价|当前价|收盘价|last\s*price)[^\d$￥¥]{0,24}[$￥¥]?\s*([\d,]+(?:\.\d+)?)/i);
  const parsedPrice = priceMatch ? numberOrNull(priceMatch[1].replaceAll(",", "")) : null;
  if (parsedPrice == null || parsedPrice <= 0) return null;
  const changeMatch = source.match(/(?:涨跌幅|涨幅|change)[^\d+\-]{0,18}([+\-]?\d+(?:\.\d+)?)\s*%/i);
  const asOfMatch = source.match(/(?:数据时间|截至|as\s*of)[：:\s]*([^\n|]+)/i);
  const sourceMatch = source.match(/(?:数据来源|来源|source)[：:\s]*([^\n|]+)/i);
  return {
    price: parsedPrice,
    change: changeMatch ? numberOrNull(changeMatch[1]) : null,
    asOf: asOfMatch?.[1]?.trim() || "",
    source: sourceMatch?.[1]?.trim() || "数据服务",
  };
}

function numberOrNull(rawValue) {
  if (rawValue == null || rawValue === "") return null;
  const value = Number(rawValue);
  return Number.isFinite(value) ? value : null;
}

function normalizeLiveQuote(value) {
  if (!value || typeof value !== "object") return null;
  const price = numberOrNull(value.price ?? value.lastPrice ?? value.last_price);
  if (price == null || price <= 0) return null;
  const previousClose = numberOrNull(value.previousClose ?? value.previous_close ?? value.prevClose);
  const rawChange = numberOrNull(value.changeAmount ?? value.change_amount ?? value.changeValue ?? value.change);
  const explicitPercent = numberOrNull(value.changePercent ?? value.change_percent ?? value.pctChange ?? value.percentChange);
  const change = explicitPercent != null
    ? explicitPercent
    : previousClose != null && previousClose !== 0 && rawChange != null
      ? rawChange / previousClose * 100
      : null;
  return {
    price,
    change,
    changeAmount: rawChange ?? (previousClose != null ? price - previousClose : null),
    asOf: String(value.asOf ?? value.as_of ?? value.timestamp ?? ""),
    source: String(value.source ?? value.dataSource ?? "数据服务"),
    open: value.open ?? null,
    previousClose,
    high: value.high ?? null,
    low: value.low ?? null,
    volume: value.volume ?? null,
    turnover: value.turnover ?? null,
    turnoverRate: value.turnoverRate ?? value.turnover_rate ?? null,
    volumeRatio: value.volumeRatio ?? value.volume_ratio ?? null,
    technicalSignal: value.technicalSignal ?? value.technical_signal ?? null,
    eventCount: value.eventCount ?? value.event_count ?? null,
    mainNetInflow: value.mainNetInflow ?? value.main_net_inflow ?? value.netInflow ?? null,
    sentiment: value.sentiment ?? value.sentimentLabel ?? null,
    pe: value.pe ?? value.peTtm ?? value.pe_ttm ?? null,
    pb: value.pb ?? null,
    marketCap: value.marketCap ?? value.market_cap ?? null,
    floatMarketCap: value.floatMarketCap ?? value.float_market_cap ?? null,
    series: Array.isArray(value.series) ? value.series : [],
    fundamentals: value.fundamentals && typeof value.fundamentals === "object" ? value.fundamentals : {},
    companyDescription: typeof value.companyDescription === "string" ? value.companyDescription : "",
  };
}

function detailedQuoteFromReply(text) {
  const value = findJsonObject(text) || {};
  const source = value.data && typeof value.data === "object" ? value.data : value.result && typeof value.result === "object" ? value.result : value;
  const quote = normalizeLiveQuote(source.quote) || normalizeLiveQuote(source.quotes?.[0]) || normalizeLiveQuote(source);
  const rawSeries = source.seriesByRange || source.series_by_range || {};
  const seriesByRange = Object.fromEntries(Object.entries(rawSeries).filter(([, points]) => Array.isArray(points)));
  if (Array.isArray(source.series) && !seriesByRange["分时"]) seriesByRange["分时"] = source.series;
  const fundamentals = source.fundamentals && typeof source.fundamentals === "object" ? source.fundamentals : {};
  if (!quote && !Object.keys(fundamentals).length && !source.companyDescription && !source.company_description && !Object.keys(seriesByRange).length) return null;
  return {
    quote: { ...(quote || {}), seriesByRange, fundamentals: { ...(quote?.fundamentals || {}), ...fundamentals }, companyDescription: String(source.companyDescription || source.company_description || quote?.companyDescription || "") },
    reportPeriod: String(source.reportPeriod || source.report_period || ""),
  };
}
function seriesFromReply(text) {
  const value = findJsonObject(text);
  const source = value?.data && typeof value.data === "object" ? value.data : value?.result && typeof value.result === "object" ? value.result : value;
  const series = Array.isArray(source?.series) ? source.series : Array.isArray(source?.data) ? source.data : findJsonArray(text);
  return series.filter((point) => point && typeof point === "object");
}

function eventsFromReply(text) {
  const value = findJsonObject(text) || {};
  const source = value?.data && typeof value.data === "object" ? value.data : value?.result && typeof value.result === "object" ? value.result : value;
  const items = Array.isArray(source.events) ? source.events : Array.isArray(source.data) ? source.data : Array.isArray(source) ? source : [];
  const fallbackSource = String(source.source || value.source || "数据服务");
  return items.filter((event) => event && typeof event === "object").map((event) => ({
    date: String(event.date || event.event_date || event.effective_date || ""),
    type: String(event.type || event.event_type || "其他"),
    title: String(event.title || event.description || event.name || ""),
    detail: String(event.detail || event.description || event.title || ""),
    source: String(event.source || event.sourceName || fallbackSource),
    url: safeExternalUrl(event.url),
  })).filter((event) => event.date || event.title);
}

function liveQuotesFromReply(text, symbols) {
  const value = findJsonObject(text);
  const items = Array.isArray(value?.quotes) ? value.quotes : Array.isArray(value?.data?.quotes) ? value.data.quotes : Array.isArray(value?.result?.quotes) ? value.result.quotes : Array.isArray(value) ? value : [value?.quote, value?.data, value?.result, value].filter(Boolean);
  const canonical = (symbol) => String(symbol ?? "").trim().toUpperCase().replace(/\.(?:SH|SS|SZ)$/i, "");
  const allowed = new Set(symbols.map(canonical));
  return items.reduce((result, item) => {
    const symbol = canonical(item?.symbol ?? item?.code);
    if (!symbol || !allowed.has(symbol)) return result;
    const quote = normalizeLiveQuote(item);
    if (quote) result[symbol] = quote;
    return result;
  }, {});
}

function monitorDataKind(conditionType) {
  if (conditionType === "technical") return "series";
  if (["core_event", "capital_flow", "sentiment"].includes(conditionType)) return conditionType;
  return "quote";
}

function monitorFieldsFromReply(text, symbol) {
  const value = findJsonObject(text) || {};
  const source = value?.data && typeof value.data === "object" ? value.data : value?.result && typeof value.result === "object" ? value.result : value;
  const quote = Object.values(liveQuotesFromReply(text, [symbol]))[0] || normalizeLiveQuote(source.quote) || normalizeLiveQuote(source);
  const events = Array.isArray(source.events) ? source.events : [];
  const flow = Array.isArray(source.capitalFlow) ? source.capitalFlow : Array.isArray(source.capital_flow) ? source.capital_flow : [];
  const news = Array.isArray(source.news) ? source.news : [];
  const series = Array.isArray(source.series) ? source.series : [];
  const fields = quote ? { ...quote } : {};
  if (source.eventCount !== null && source.eventCount !== undefined && source.eventCount !== "" && Number.isFinite(Number(source.eventCount))) fields.eventCount = Number(source.eventCount);
  if (source.mainNetInflow !== null && source.mainNetInflow !== undefined && source.mainNetInflow !== "" && Number.isFinite(Number(source.mainNetInflow))) fields.mainNetInflow = Number(source.mainNetInflow);
  if (source.sentiment !== null && source.sentiment !== undefined && source.sentiment !== "") fields.sentiment = String(source.sentiment).toLowerCase();
  if (source.sentimentScore !== null && source.sentimentScore !== undefined && source.sentimentScore !== "" && Number.isFinite(Number(source.sentimentScore))) fields.sentimentScore = Number(source.sentimentScore);
  if (events.length) fields.events = events;
  if (flow.length) fields.capitalFlow = flow;
  if (news.length) fields.news = news;
  if (series.length) fields.series = series;
  if (!fields.asOf && source.asOf) fields.asOf = String(source.asOf);
  if (!fields.source && source.source) fields.source = String(source.source);
  return fields;
}

function portfolioContextForSymbol(positions, symbol, quote) {
  const normalized = String(symbol || "").trim().toUpperCase().replace(/\.(?:SH|SS|SZ)$/i, "");
  const position = (Array.isArray(positions) ? positions : []).find((item) => String(item?.symbol || "").trim().toUpperCase().replace(/\.(?:SH|SS|SZ)$/i, "") === normalized);
  return portfolioAttributionContext(position, quote);
}

async function queryMonitorData(kind, symbol, market = "") {
  if ((!isLocalWebRuntime() && !isDesktopRuntime()) || typeof queryCapabilityData !== "function") return null;
  try {
    const cached = await queryCapabilityData({ kind, symbol: qverisSymbol(symbol, market) }, { timeoutMs: 60_000 });
    const text = JSON.stringify(cached?.data ?? cached ?? {});
    return { fields: monitorFieldsFromReply(text, symbol), mode: cached?.mode || "pi-local-host", audits: cached?.audits || [{ operation: "cap-call", outcome: "success", kind }] };
  } catch (error) {
    // Do not hide authentication, throttling, timeout, or Host cancellation
    // failures.  Swallowing them here would make executeMonitorForItem fall
    // through to a model Search, causing another slow/chargeable request even
    // though the fixed CAP path already gave a definitive failure.
    return { error, fields: {}, mode: "pi-local-host", audits: [] };
  }
}

function shouldBlockMonitorModelFallback(error) {
  const status = Number(error?.status);
  if ([401, 403, 408, 425, 429].includes(status) || status >= 500) return true;
  const code = String(error?.code || "").toUpperCase();
  if (["LOCAL_HOST_UNAVAILABLE", "LOCAL_HOST_ABORTED", "CLIENT_DISCONNECTED", "ABORT_ERR"].includes(code)) return true;
  return /超时|timeout|限流|请求过多|认证|权限|断开|无法连接|network/i.test(String(error?.message || ""));
}

function conditionMonitorResult(rule, item, data) {
  const evaluation = evaluateRuleConditions(rule, data);
  if (!evaluation.known) throw new Error("数据服务未返回条件所需的完整字段");
  const asOf = String(data?.asOf || "数据时间未知");
  const source = String(data?.source || "数据服务");
  const metric = isValidQuotePrice(data?.price) ? `最新价 ${Number(data.price).toFixed(2)}；` : "";
  return {
    triggered: evaluation.triggered,
    title: `${item?.name || rule.symbol} · ${strategyFor(rule.strategyId).name}`,
    summary: `${metric}${evaluation.triggered ? "条件已触发" : "条件未触发"}；条件：${ruleConditionSummary(rule)}。数据截至 ${asOf}，来源 ${source}。`,
    severity: evaluation.triggered ? "warning" : "info",
    asOf,
    source,
    conditionResults: evaluation.results,
  };
}

function priceMonitorResult(rule, item, quote) {
  const change = Number(quote?.change);
  const evaluation = evaluateRuleConditions(rule, { ...quote, changePercent: quote?.change });
  if (!evaluation.known) throw new Error("数据服务未返回条件所需的完整字段");
  const triggered = evaluation.triggered;
  const direction = change > 0 ? "上涨" : change < 0 ? "下跌" : "持平";
  const price = isValidQuotePrice(quote.price) ? `最新价 ${Number(quote.price).toFixed(2)}，` : "";
  const asOf = String(quote.asOf || "数据时间未知");
  const source = String(quote.source || "数据服务");
  return {
    triggered,
    title: `${item?.name || rule.symbol} · ${strategyFor(rule.strategyId).name}`,
    summary: `${price}${Number.isFinite(change) ? `${direction} ${change >= 0 ? "+" : ""}${change.toFixed(2)}%` : "条件检查完成"}；条件：${ruleConditionSummary(rule)}。数据截至 ${asOf}，来源 ${source}。`,
    severity: triggered ? "warning" : "info",
    asOf,
    source,
    conditionResults: evaluation.results,
  };
}

function resolveLiveQuoteConcurrency() {
  if (!isLocalWebRuntime()) return DEFAULT_LIVE_QUOTE_CONCURRENCY;
  const configured = Number(getDeveloperVariable("maxConcurrentDataRequests", DEFAULT_LIVE_QUOTE_CONCURRENCY));
  if (Number.isInteger(configured)) return Math.max(1, Math.min(MAX_LIVE_QUOTE_CONCURRENCY, configured));
  return DEFAULT_LIVE_QUOTE_CONCURRENCY;
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, limit), items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }));
  return results;
}

async function askFinancialData(prompt, kind, symbol, range, options) {
  if (isLocalWebRuntime() || isDesktopRuntime()) {
    try {
      const requestOptions = { timeoutMs: options?.settleTimeoutMs || 90_000 };
      if (options?.signal) requestOptions.signal = options.signal;
      const cached = await queryCapabilityData({ kind, symbol: qverisSymbol(symbol, options?.market), range }, requestOptions);
      // A test double or a malformed native response must not silently turn a
      // successful transport into an Agent fallback. Treat a missing result as
      // an explicit cache miss so the fallback policy below remains narrow.
      if (!cached || typeof cached !== "object") {
        const error = new Error("金融能力缓存未返回结果");
        error.code = "TOOL_CACHE_MISS";
        throw error;
      }
      return { text: JSON.stringify(cached.data ?? cached), mode: cached.mode || "pi-local-host", audits: cached.audits || [{ operation: "cached-call", outcome: "success" }], cacheHit: cached.cacheHit === true };
    } catch (error) {
      if (!shouldFallbackToAgent(error)) throw error;
      // A missing/invalidated solidified tool can be rediscovered once by the
      // managed Agent. Authentication, rate limits, timeouts and upstream
      // outages stay on the direct CAP error path and never add a billable
      // Search → Inspect → Call round.
    }
  }
  return askPi(prompt, options);
}

/**
 * Keep page-level CAP recovery aligned with the Host fallback guard. Only an
 * explicit cache miss or capability-not-found response may enter the Agent
 * discovery path; generic errors are user-visible and retryable in place.
 */
export function shouldFallbackToAgent(error) {
  const code = String(error?.code || "").toUpperCase();
  if (["TOOL_CACHE_MISS", "CAPABILITY_NOT_FOUND"].includes(code)) return true;
  if (Number(error?.status) === 404) return true;
  const text = String(error?.message ?? error ?? "").toLowerCase();
  return /tool[_ -]?cache[_ -]?miss|尚未固化|没有对应的金融能力|capability[^\n]{0,24}not[^\n]{0,24}found/.test(text);
}

function liveQuotePrompt(item) {
  const marketSymbol = qverisSymbol(item.symbol, item.market);
  return `使用内置 qveris-finance-research Skill 查询 ${item.name}（${item.symbol}）${marketContext(item)}实时行情快照。调用工具时参数 symbol 必须使用 ${marketSymbol}。只做一次 Search、一次 Inspect、一次 Call，选最匹配的实时行情工具，不要交叉核验，不要第二次搜索。不要使用示例数据。严格只返回一个 JSON 对象，不要 Markdown，格式为 {"quotes":[{"symbol":"${item.symbol}","name":"${item.name}","price":null,"changePercent":null,"changeAmount":null,"open":null,"previousClose":null,"high":null,"low":null,"volume":null,"turnover":null,"turnoverRate":null,"volumeRatio":null,"pe":null,"pb":null,"marketCap":null,"floatMarketCap":null,"asOf":"数据时间","source":"数据来源"}],"errors":[]}。没有真实值的字段填 null。`;
}

async function fetchLiveQuote(item, options = {}) {
  const prompt = liveQuotePrompt(item);
  const requestOptions = { settleTimeoutMs: options.settleTimeoutMs || 60_000 };
  if (options.signal) requestOptions.signal = options.signal;
  const reply = await askFinancialData(prompt, "quote", item.symbol, "", { ...requestOptions, market: item.market });
  let quotes = liveQuotesFromReply(reply.text, [item.symbol]);
  // A stale cached selection may return an empty envelope. Rediscover once so
  // the fast path remains self-healing without making every request slow.
  if (!Object.keys(quotes).length && reply.cacheHit) {
    const rediscoverOptions = { settleTimeoutMs: options.settleTimeoutMs || 60_000 };
    if (options.signal) rediscoverOptions.signal = options.signal;
    const rediscovered = await askPi(prompt, rediscoverOptions);
    quotes = liveQuotesFromReply(rediscovered.text, [item.symbol]);
  }
  if (!Object.keys(quotes).length) throw new Error("未返回可识别的真实行情");
  return { quotes, reply };
}

async function executeMonitorForItem(rule, item) {
  const strategy = strategyFor(rule.strategyId);
  let reply;
  let result;
  let parsed = null;
  const monitorPrompt = `执行一次真实金融盯盘检查。标的：${item?.name || rule.symbol}（${item?.symbol || rule.symbol}）。策略：${strategy.name}。条件：${ruleConditionSummary(rule)}。${conditionPrompt(rule)} ${strategy.prompt} 必须使用内置 qveris-finance-research Skill 按 Search → Inspect → Call 查询，不得使用界面示例数据。请严格返回一个 JSON 对象，不要 Markdown：{"triggered":true、false 或 null,"title":"简短标题","summary":"含来源和数据截至时间的结论","severity":"info|warning|critical","asOf":"数据截至时间"}。`;
  if ((isLocalWebRuntime() || isDesktopRuntime()) && typeof queryCapabilityData === "function") {
    const kinds = [...new Set(conditionsForRule(rule).map((condition) => monitorDataKind(condition.type)))];
    const queryResults = (await Promise.all(kinds.map((kind) => queryMonitorData(kind, item?.symbol || rule.symbol, item?.market)))).filter(Boolean);
    const directFailures = queryResults.map((current) => current.error).filter(Boolean);
    if (directFailures.some(shouldBlockMonitorModelFallback)) throw directFailures.find(shouldBlockMonitorModelFallback);
    const directResults = queryResults.filter((current) => !current.error);
    const monitorData = directResults.reduce((merged, current) => ({ ...merged, ...current.fields, asOf: current.fields.asOf || merged.asOf, source: current.fields.source || merged.source }), {});
    reply = { text: JSON.stringify(monitorData), mode: directResults[0]?.mode || "pi-local-host", audits: directResults.flatMap((current) => current.audits || []) };
    const evaluation = evaluateRuleConditions(rule, monitorData);
    if (directResults.length && evaluation.known) {
      result = conditionsForRule(rule).every((condition) => condition.type === "price_change") && monitorData.price !== undefined
        ? priceMonitorResult(rule, item, monitorData)
        : conditionMonitorResult(rule, item, monitorData);
      parsed = result;
    } else {
      // Direct CAP responses may be empty or omit a condition-specific field.
      // Ask the managed runtime once for the unresolved decision.
      reply = await askPi(monitorPrompt, { settleTimeoutMs: 120_000 });
      parsed = findJsonObject(reply.text);
      result = parsed || { triggered: null, title: `${item?.name || rule.symbol} · ${strategy.name}`, summary: "数据服务未返回完整条件字段。", severity: "info" };
    }
  } else {
    reply = await askPi(monitorPrompt, { settleTimeoutMs: 120_000 });
    parsed = findJsonObject(reply.text);
    result = parsed || { triggered: reply.mode !== "browser-demo", title: `${item?.name || rule.symbol} · ${strategy.name}`, summary: reply.mode === "browser-demo" ? "浏览器预览未执行真实数据查询，请先配置数据服务。" : reply.text, severity: "info" };
  }
  return { result, reply, parsed };
}

export const initialLabState = {
  activeView: "watchlist", selectedSymbol: "600519", chartRange: "分时", watchlist: defaultWatchlist, liveQuotes: {}, skillItems: skills.map((item) => ({ ...item })),
  messages: [{ id: "a1", role: "assistant", text: "选择标的后点击“获取实时数据”，或直接告诉我需要的市场、指标和时间范围。我会通过已配置的数据工具查询，并返回来源与截至时间。", mode: "onboarding", audits: [] }],
  rules: defaultMonitorRules.map(normalizeRule), notifications: [], portfolioPositions: [], portfolioReviews: [], briefingSchedule: { ...DEFAULT_BRIEFING_SCHEDULE }, briefingScheduleBusy: false, premarketBriefing: null, premarketBriefingLoading: false, premarketBriefingScheduleBusy: false, premarketBriefingError: "", monitorHistory: [], anomalyAttributions: {}, anomalyAttributionLoading: {}, anomalyAttributionError: {}, events: [], eventDataLoading: false, eventDataError: "", eventDataLastRefreshAt: null, eventDataLoaded: false, eventDataReceivedCount: 0, eventDataTotalCount: 0, userStateLoaded: false, userStateLoading: false, userStateError: "", integrationStatus: null, integrationStatusLoading: true, integrationStatusError: "", liveDataLoading: false, liveDataError: "", liveDataLastRefreshAt: null, selectedQuoteLoading: {}, quoteDetailsLoading: {}, quoteDetailsLoaded: {}, quoteDetailsError: {}, quoteSeriesLoading: {}, quoteSeriesLoaded: {}, quoteSeriesError: {}, monitorBusy: false, monitorLastRunAt: null, runtimeMode: "ready", runtimeConfiguring: false, runtimeCancelPending: false, persistenceRetrying: false, settingsNotice: null,
};

function dataChannelChanged(previous, next) {
  return Boolean(previous) && (
    previous.credentialConfigured !== next?.credentialConfigured
    || previous.settings?.modelId !== next?.settings?.modelId
    || previous.settings?.modelGatewayBaseUrl !== next?.settings?.modelGatewayBaseUrl
    || previous.settings?.capabilityBaseUrl !== next?.settings?.capabilityBaseUrl
    || previous.settings?.dataChannel !== next?.settings?.dataChannel
    || previous.settings?.dataProvider !== next?.settings?.dataProvider
  );
}

const quoteRefreshReset = {
  liveQuotes: {}, liveDataLastRefreshAt: null, liveDataError: "", liveDataLoading: false, selectedQuoteLoading: {},
  quoteDetailsLoading: {}, quoteDetailsLoaded: {}, quoteDetailsError: {},
  quoteSeriesLoading: {}, quoteSeriesLoaded: {}, quoteSeriesError: {},
};

export const useLabStore = create((set, get) => ({
  ...initialLabState,
  hydrateIntegrationStatus: async () => {
    set({ integrationStatusLoading: true, integrationStatusError: "" });
    try { get().setIntegrationStatus(await loadIntegrationStatus()); }
    catch (error) { set({ integrationStatus: null, integrationStatusLoading: false, integrationStatusError: error instanceof Error ? error.message : String(error) }); }
  },
  setIntegrationStatus: (integrationStatus) => set((state) => {
    const changed = dataChannelChanged(state.integrationStatus, integrationStatus);
    if (changed) {
      abortPendingDataRequests();
      liveRequestGeneration += 1;
      selectedQuoteGenerations.clear();
      detailsRequestGeneration += 1;
      seriesRequestGeneration += 1;
      eventsRequestGeneration += 1;
      premarketRequestGeneration += 1;
      anomalyAttributionGenerations.clear();
    }
    return { integrationStatus, integrationStatusLoading: false, integrationStatusError: "", ...(changed ? quoteRefreshReset : {}), ...(changed ? { anomalyAttributions: {}, anomalyAttributionLoading: {}, anomalyAttributionError: {}, portfolioPositions: state.portfolioPositions.map((position) => ({ ...position, takeProfitTriggered: false, stopLossTriggered: false })), briefingSchedule: { ...state.briefingSchedule, calendarDate: "", calendarStatus: "unknown", calendarCheckedAt: "", calendarSource: "", calendarToolId: "", premarketLastAttemptAt: "", premarketLastSuccessKey: "", premarketLastResult: "idle", premarketLastError: "" }, premarketBriefing: null, premarketBriefingLoading: false, premarketBriefingScheduleBusy: false, premarketBriefingError: "", events: [], eventDataError: "", eventDataLastRefreshAt: null, eventDataLoaded: false, eventDataReceivedCount: 0, eventDataTotalCount: 0, eventDataLoading: false } : {}) };
  }),
  cancelLiveDataRefresh: () => {
    if (!get().liveDataLoading) return false;
    // Invalidate the whole sweep before aborting the controller. Workers that
    // are already between a CAP response and their state commit will then
    // discard their result, while the Host still cancels the active upstream
    // request when all shared waiters have left.
    liveRequestGeneration += 1;
    abortController(liveRequestController);
    liveRequestController = null;
    set({ liveDataLoading: false, liveDataError: "已停止本轮行情更新，可稍后重试" });
    return true;
  },
  cancelEventsRefresh: () => {
    if (!get().eventDataLoading) return false;
    // Event refreshes have an independent controller from quote refreshes.
    // Invalidate the sweep before aborting so a worker that races with the
    // abort cannot commit a late event or trigger reminders.
    eventsRequestGeneration += 1;
    abortController(eventsRequestController);
    eventsRequestController = null;
    set({ eventDataLoading: false, eventDataLoaded: true, eventDataError: "已停止本轮事件更新，可稍后重试" });
    return true;
  },
  refreshLiveData: async (options = {}) => {
    const state = get();
    const configured = hasRealDataAccess(state.integrationStatus);
    if (!configured || !state.watchlist.length || state.liveDataLoading || state.runtimeConfiguring || state.runtimeCancelPending || state.monitorBusy || state.runtimeMode === "running" || state.runtimeMode === "cancelling") return false;
    const requestedSymbols = Array.isArray(options?.symbols)
      ? new Set(options.symbols.map((symbol) => String(symbol || "").trim().toUpperCase()).filter(Boolean))
      : null;
    const items = requestedSymbols
      ? state.watchlist.filter((item) => requestedSymbols.has(String(item?.symbol || "").trim().toUpperCase()))
      : state.watchlist;
    if (!items.length) return false;
    const requestGeneration = ++liveRequestGeneration;
    const requestController = new AbortController();
    liveRequestController = requestController;
    set({ liveDataLoading: true, liveDataError: "" });
    const errors = [];
    let received = 0;
    try {
      const concurrency = resolveLiveQuoteConcurrency();
      await mapWithConcurrency(items, concurrency, async (item) => {
        try {
          if (requestGeneration !== liveRequestGeneration) return false;
          const { quotes } = await fetchLiveQuote(item, { signal: requestController.signal });
          if (requestGeneration !== liveRequestGeneration) return false;
          received += 1;
          let delivered = [];
          let portfolioChanged = false;
          let previousPositions = [];
          let optimisticPositions = [];
          set((current) => {
            previousPositions = current.portfolioPositions;
            const merged = mergeLiveQuotesWithPortfolio(current, quotes);
            delivered = merged.delivered;
            portfolioChanged = merged.portfolioChanged;
            optimisticPositions = merged.portfolioPositions;
            return { liveQuotes: merged.liveQuotes, ...(portfolioChanged ? { portfolioPositions: merged.portfolioPositions, notifications: merged.notifications } : {}), liveDataLastRefreshAt: nowIso() };
          });
          if (portfolioChanged) {
            try {
              await get().persistUserState();
            } catch (error) {
              set((current) => rollbackPortfolioAlertMutation(current, previousPositions, optimisticPositions, delivered));
              throw error;
            }
            for (const notification of delivered) void sendSystemNotification(notification);
          }
          return true;
        } catch (error) {
          if (requestGeneration !== liveRequestGeneration) return false;
          errors.push(`${item.name}：${friendlyDataMessage(error)}`);
          return false;
        }
      });
      if (requestGeneration !== liveRequestGeneration) return false;
      if (!received) {
        set({ liveDataLoading: false, liveDataError: errors.join("；") || "暂时没有可用数据，系统会稍后再查" });
        return false;
      }
      set({ liveDataLoading: false, liveDataError: errors.length ? "部分标的暂未更新，系统会稍后自动重试" : "" });
      return true;
    } catch (error) {
      set({ liveDataLoading: false, liveDataError: friendlyDataMessage(error) });
      return false;
    } finally {
      if (liveRequestController === requestController) liveRequestController = null;
    }
  },
  refreshSelectedQuote: async (symbol) => {
    const state = get();
    const item = dataItemForSymbol(state, symbol);
    const configured = hasRealDataAccess(state.integrationStatus);
    if (!configured || !item || state.selectedQuoteLoading?.[symbol] || state.runtimeConfiguring || state.runtimeCancelPending || state.monitorBusy || ["running", "cancelling"].includes(state.runtimeMode)) return false;
    const requestGeneration = (selectedQuoteGenerations.get(symbol) || 0) + 1;
    selectedQuoteGenerations.set(symbol, requestGeneration);
    const requestController = new AbortController();
    selectedQuoteControllers.set(symbol, requestController);
    set((current) => ({ selectedQuoteLoading: { ...current.selectedQuoteLoading, [symbol]: true }, liveDataError: current.liveDataLoading ? current.liveDataError : "" }));
    try {
      const { quotes } = await fetchLiveQuote(item, { signal: requestController.signal });
      if (requestGeneration !== selectedQuoteGenerations.get(symbol)) return false;
      let delivered = [];
      let portfolioChanged = false;
      let previousPositions = [];
      let optimisticPositions = [];
      set((current) => {
        previousPositions = current.portfolioPositions;
        const merged = mergeLiveQuotesWithPortfolio(current, quotes);
        delivered = merged.delivered;
        portfolioChanged = merged.portfolioChanged;
        optimisticPositions = merged.portfolioPositions;
        return { liveQuotes: merged.liveQuotes, ...(portfolioChanged ? { portfolioPositions: merged.portfolioPositions, notifications: merged.notifications } : {}), selectedQuoteLoading: { ...current.selectedQuoteLoading, [symbol]: false }, liveDataError: current.liveDataLoading ? current.liveDataError : "", liveDataLastRefreshAt: nowIso() };
      });
      if (portfolioChanged) {
        try {
          await get().persistUserState();
        } catch (error) {
          set((current) => rollbackPortfolioAlertMutation(current, previousPositions, optimisticPositions, delivered));
          throw error;
        }
        for (const notification of delivered) void sendSystemNotification(notification);
      }
      return true;
    } catch (error) {
      if (requestGeneration !== selectedQuoteGenerations.get(symbol)) return false;
      set((current) => ({ selectedQuoteLoading: { ...current.selectedQuoteLoading, [symbol]: false }, liveDataError: current.liveDataLoading ? current.liveDataError : friendlyDataMessage(error) }));
      return false;
    } finally {
      if (selectedQuoteControllers.get(symbol) === requestController) selectedQuoteControllers.delete(symbol);
    }
  },
  retryLiveData: async () => {
    if (get().liveDataLoading) return false;
    set({ liveDataError: "" });
    return get().refreshLiveData();
  },
  explainAnomaly: async (anomaly) => {
    const id = String(anomaly?.id || "").trim();
    const symbol = String(anomaly?.symbol || "").trim();
    const state = get();
    const configured = hasModelAccess(state.integrationStatus);
    if (!id || !symbol || !configured || state.anomalyAttributionLoading[id] || state.runtimeConfiguring || state.runtimeCancelPending || state.monitorBusy || ["running", "cancelling"].includes(state.runtimeMode)) return false;
    const requestGeneration = (anomalyAttributionGenerations.get(id) || 0) + 1;
    anomalyAttributionGenerations.set(id, requestGeneration);
    set((current) => ({ anomalyAttributionLoading: { ...current.anomalyAttributionLoading, [id]: true }, anomalyAttributionError: { ...current.anomalyAttributionError, [id]: "" } }));
    const quote = quoteForSymbol(state.liveQuotes, symbol);
    const portfolio = portfolioContextForSymbol(state.portfolioPositions, symbol, quote);
    let evidence = normalizeAttributionEvidence({ quote });
    let audits = [];
    try {
      if ((isLocalWebRuntime() || isDesktopRuntime()) && typeof queryCapabilityData === "function") {
        const anomalyItem = dataItemForSymbol(state, symbol);
        const results = await Promise.allSettled(["sentiment", "core_event", "capital_flow"].map((kind) => queryCapabilityData({ kind, symbol: qverisSymbol(symbol, anomalyItem?.market) }, { timeoutMs: 60_000 })));
        const data = results.filter((result) => result.status === "fulfilled").flatMap((result) => {
          const value = result.value;
          audits = [...audits, ...(Array.isArray(value?.audits) ? value.audits : [])];
          return [value?.data ?? value ?? {}];
        }).reduce((merged, value) => ({ ...merged, ...value }), {});
        evidence = normalizeAttributionEvidence({ quote, news: data.news, events: data.events, capitalFlow: data.capitalFlow || data.capital_flow });
      }
      if (!evidence.length) throw new Error("当前没有足够的真实证据，暂时无法生成解读");
      const reply = await askPi(buildAttributionPrompt({ anomaly, evidence, portfolio }), { settleTimeoutMs: 120_000 });
      if (requestGeneration !== anomalyAttributionGenerations.get(id)) return false;
      audits = [...audits, ...(reply.audits || [])];
      const attribution = normalizeAttribution(reply.text, { anomaly, evidence, portfolio });
      set((current) => ({ anomalyAttributions: { ...current.anomalyAttributions, [id]: { ...attribution, audits } }, anomalyAttributionLoading: { ...current.anomalyAttributionLoading, [id]: false }, anomalyAttributionError: { ...current.anomalyAttributionError, [id]: "" } }));
      return true;
    } catch (error) {
      if (requestGeneration !== anomalyAttributionGenerations.get(id)) return false;
      set((current) => ({ anomalyAttributionLoading: { ...current.anomalyAttributionLoading, [id]: false }, anomalyAttributionError: { ...current.anomalyAttributionError, [id]: friendlyDataMessage(error, "暂时没有足够的真实证据，稍后可以重试") } }));
      return false;
    }
  },
  refreshQuoteDetails: async (symbol) => {
    const state = get();
    const item = dataItemForSymbol(state, symbol);
    const configured = hasRealDataAccess(state.integrationStatus);
    if (!configured || !item || state.liveDataLoading || state.runtimeConfiguring || state.runtimeCancelPending || state.monitorBusy || state.runtimeMode === "running" || state.runtimeMode === "cancelling" || state.quoteDetailsLoading[symbol] || state.quoteDetailsLoaded[symbol]) return false;
    // Details belong to the currently selected symbol. If the user switches
    // symbols before the previous request completes, cancel the obsolete
    // upstream call instead of paying for a response that will be discarded.
    const obsoleteSymbol = detailsRequestSymbol;
    abortController(detailsRequestController);
    detailsRequestController = null;
    if (obsoleteSymbol && obsoleteSymbol !== symbol) {
      set((current) => ({ quoteDetailsLoading: { ...current.quoteDetailsLoading, [obsoleteSymbol]: false }, quoteDetailsError: { ...current.quoteDetailsError, [obsoleteSymbol]: "" } }));
    }
    detailsRequestSymbol = symbol;
    const requestGeneration = ++detailsRequestGeneration;
    const requestController = new AbortController();
    detailsRequestController = requestController;
    set((current) => ({ quoteDetailsLoading: { ...current.quoteDetailsLoading, [symbol]: true }, quoteDetailsError: { ...current.quoteDetailsError, [symbol]: "" } }));
    try {
      const prompt = `使用内置 qveris-finance-research Skill 查询 ${item.name}（${item.symbol}）的真实公司简介和最近一期财务指标。调用工具时如需股票参数，使用 ${qverisSymbol(item.symbol, item.market)}。允许分别 Search 相关资料，但每个候选工具只能 Inspect 后 Call 一次。不要交叉核验，不要编造。只返回一个 JSON 对象，不要 Markdown：{"fundamentals":{"revenue":null,"netProfit":null,"grossMargin":null,"netMargin":null,"roe":null,"reportPeriod":""},"companyDescription":"","errors":[]}。没有真实数据填 null 或空字符串。`;
      const reply = await askFinancialData(prompt, "details", item.symbol, "", { settleTimeoutMs: 90_000, signal: requestController.signal, market: item.market });
      if (requestGeneration !== detailsRequestGeneration) return false;
      let details = detailedQuoteFromReply(reply.text);
      if (!details && reply.cacheHit) details = detailedQuoteFromReply((await askPi(prompt, { settleTimeoutMs: 90_000, signal: requestController.signal })).text);
      if (!details) throw new Error("数据服务暂未返回可识别的行情详情");
      set((current) => ({ liveQuotes: { ...current.liveQuotes, [symbol]: { ...current.liveQuotes[symbol], ...details.quote, reportPeriod: details.reportPeriod } }, quoteDetailsLoading: { ...current.quoteDetailsLoading, [symbol]: false }, quoteDetailsLoaded: { ...current.quoteDetailsLoaded, [symbol]: true }, quoteDetailsError: { ...current.quoteDetailsError, [symbol]: "" } }));
      return true;
    } catch (error) {
      if (requestGeneration !== detailsRequestGeneration) return false;
      set((current) => ({ quoteDetailsLoading: { ...current.quoteDetailsLoading, [symbol]: false }, quoteDetailsLoaded: { ...current.quoteDetailsLoaded, [symbol]: true }, quoteDetailsError: { ...current.quoteDetailsError, [symbol]: friendlyDataMessage(error) } }));
      return false;
    } finally {
      if (detailsRequestController === requestController) {
        detailsRequestController = null;
        detailsRequestSymbol = "";
      }
    }
  },
  retryQuoteDetails: async (symbol) => {
    set((current) => ({ quoteDetailsLoaded: { ...current.quoteDetailsLoaded, [symbol]: false }, quoteDetailsError: { ...current.quoteDetailsError, [symbol]: "" } }));
    return get().refreshQuoteDetails(symbol);
  },
  refreshQuoteSeries: async (symbol, range) => {
    const state = get();
    const item = dataItemForSymbol(state, symbol);
    const configured = hasRealDataAccess(state.integrationStatus);
    if (!configured || !item || !range || state.liveDataLoading || state.quoteDetailsLoading[symbol] || state.runtimeConfiguring || state.runtimeCancelPending || state.monitorBusy || ["running", "cancelling"].includes(state.runtimeMode) || state.quoteSeriesLoading[symbol]?.[range] || state.quoteSeriesLoaded[symbol]?.[range]) return false;
    // A range change or symbol switch makes the previous chart request
    // irrelevant. Abort it before starting the replacement to avoid wasting
    // network time and provider credits.
    const obsoleteSeries = seriesRequestContext;
    abortController(seriesRequestController);
    seriesRequestController = null;
    if (obsoleteSeries && (obsoleteSeries.symbol !== symbol || obsoleteSeries.range !== range)) {
      set((current) => ({ quoteSeriesLoading: { ...current.quoteSeriesLoading, [obsoleteSeries.symbol]: { ...(current.quoteSeriesLoading[obsoleteSeries.symbol] || {}), [obsoleteSeries.range]: false } }, quoteSeriesError: { ...current.quoteSeriesError, [obsoleteSeries.symbol]: { ...(current.quoteSeriesError[obsoleteSeries.symbol] || {}), [obsoleteSeries.range]: "" } } }));
    }
    seriesRequestContext = { symbol, range };
    const requestGeneration = ++seriesRequestGeneration;
    const requestController = new AbortController();
    seriesRequestController = requestController;
    set((current) => ({ quoteSeriesLoading: { ...current.quoteSeriesLoading, [symbol]: { ...(current.quoteSeriesLoading[symbol] || {}), [range]: true } }, quoteSeriesError: { ...current.quoteSeriesError, [symbol]: { ...(current.quoteSeriesError[symbol] || {}), [range]: "" } } }));
    const rangeRequest = { 分时: "今天的1分钟或5分钟分时", "5日": "最近5个交易日日线", 日K: "最近90个交易日日线", 周K: "最近52周周线", 月K: "最近60个月月线", 季K: "最近20个季度线", 年K: "最近10年年线" }[range] || range;
    try {
      const prompt = `使用内置 qveris-finance-research Skill 查询 ${item.name}（${item.symbol}）的${rangeRequest}真实行情。调用工具时如需股票参数，使用 ${qverisSymbol(item.symbol, item.market)}。只做一次 Search、一次 Inspect、一次 Call，选最匹配的历史或分时工具，不要交叉核验。只返回一个 JSON 对象，不要 Markdown：{"series":[]}。时间序列点使用 {"time":"ISO或YYYY-MM-DD HH:mm:ss","open":null,"high":null,"low":null,"close":null,"value":null,"volume":null}；没有真实数据返回空数组，禁止编造。`;
      const reply = await askFinancialData(prompt, "series", item.symbol, rangeRequest, { settleTimeoutMs: 60_000, signal: requestController.signal, market: item.market });
      if (requestGeneration !== seriesRequestGeneration) return false;
      const series = seriesFromReply(reply.text);
      set((current) => ({ liveQuotes: { ...current.liveQuotes, [symbol]: { ...current.liveQuotes[symbol], seriesByRange: { ...(current.liveQuotes[symbol]?.seriesByRange || {}), [range]: series } } }, quoteSeriesLoading: { ...current.quoteSeriesLoading, [symbol]: { ...(current.quoteSeriesLoading[symbol] || {}), [range]: false } }, quoteSeriesLoaded: { ...current.quoteSeriesLoaded, [symbol]: { ...(current.quoteSeriesLoaded[symbol] || {}), [range]: true } }, quoteSeriesError: { ...current.quoteSeriesError, [symbol]: { ...(current.quoteSeriesError[symbol] || {}), [range]: "" } } }));
      return true;
    } catch (error) {
      if (requestGeneration !== seriesRequestGeneration) return false;
      set((current) => ({ quoteSeriesLoading: { ...current.quoteSeriesLoading, [symbol]: { ...(current.quoteSeriesLoading[symbol] || {}), [range]: false } }, quoteSeriesLoaded: { ...current.quoteSeriesLoaded, [symbol]: { ...(current.quoteSeriesLoaded[symbol] || {}), [range]: true } }, quoteSeriesError: { ...current.quoteSeriesError, [symbol]: { ...(current.quoteSeriesError[symbol] || {}), [range]: friendlyDataMessage(error) } } }));
      return false;
    } finally {
      if (seriesRequestController === requestController) {
        seriesRequestController = null;
        seriesRequestContext = null;
      }
    }
  },
  retryQuoteSeries: async (symbol, range) => {
    set((current) => ({ quoteSeriesLoaded: { ...current.quoteSeriesLoaded, [symbol]: { ...(current.quoteSeriesLoaded[symbol] || {}), [range]: false } }, quoteSeriesError: { ...current.quoteSeriesError, [symbol]: { ...(current.quoteSeriesError[symbol] || {}), [range]: "" } } }));
    return get().refreshQuoteSeries(symbol, range);
  },
  refreshEvents: async () => {
    const state = get();
    const configured = hasRealDataAccess(state.integrationStatus);
    if (!configured || !state.watchlist.length || state.eventDataLoading || state.liveDataLoading || state.runtimeConfiguring || state.runtimeCancelPending || state.monitorBusy || ["running", "cancelling"].includes(state.runtimeMode)) return false;
    const requestGeneration = ++eventsRequestGeneration;
    const requestController = new AbortController();
    eventsRequestController = requestController;
    const total = state.watchlist.length;
    set({ eventDataLoading: true, eventDataError: "", eventDataLoaded: false, eventDataReceivedCount: 0, eventDataTotalCount: total });
    const errors = [];
    const rows = [];
    let received = 0;
    try {
      await mapWithConcurrency(state.watchlist, resolveLiveQuoteConcurrency(), async (item) => {
        try {
          if (requestGeneration !== eventsRequestGeneration) return false;
          const prompt = `使用内置 qveris-finance-research Skill 查询 ${item.name}（${item.symbol}）未来 90 天内已排期的公司事件，包括分红、拆股、股东会和财报相关日期。只返回真实数据，不要公告全文，不要编造。严格只返回一个 JSON 对象，不要 Markdown：{"events":[{"date":"YYYY-MM-DD或ISO时间","type":"事件类型","title":"事件标题","detail":"事件说明","source":"数据来源","url":"可选链接"}]}。没有真实事件返回空数组。`;
          const reply = await askFinancialData(prompt, "core_event", item.symbol, "", { settleTimeoutMs: 60_000, signal: requestController.signal, market: item.market });
          if (requestGeneration !== eventsRequestGeneration) return false;
          const itemEvents = eventsFromReply(reply.text).map((event, index) => ({ ...event, id: `${item.symbol}-${event.date || "undated"}-${index}`, symbol: item.symbol, name: item.name, market: item.market, capability: "EVENT.CALENDAR.CORP", provider: "qveris_finance" }));
          rows.push(...itemEvents);
          received += 1;
          set({ eventDataReceivedCount: received });
          return true;
        } catch (error) {
          if (requestGeneration !== eventsRequestGeneration) return false;
          errors.push(`${item.name}：${friendlyDataMessage(error)}`);
          return false;
        }
      });
      if (requestGeneration !== eventsRequestGeneration) return false;
      const unique = [...new Map(rows.map((event) => [`${event.symbol}|${event.date}|${event.type}|${event.title}`, event])).values()];
      unique.sort((left, right) => {
        const leftTime = Date.parse(left.date);
        const rightTime = Date.parse(right.date);
        if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return leftTime - rightTime;
        return String(left.date).localeCompare(String(right.date));
      });
      set({ events: unique, eventDataLoading: false, eventDataLoaded: true, eventDataReceivedCount: received, eventDataTotalCount: total, eventDataError: errors.length ? "部分标的事件暂未更新，系统会稍后自动重试" : "", eventDataLastRefreshAt: nowIso() });
      await get().notifyDueEventReminders(unique);
      return received > 0;
    } catch (error) {
      if (requestGeneration !== eventsRequestGeneration) return false;
      set({ events: [], eventDataLoading: false, eventDataLoaded: true, eventDataReceivedCount: received, eventDataTotalCount: total, eventDataError: friendlyDataMessage(error), eventDataLastRefreshAt: nowIso() });
      return false;
    } finally {
      if (eventsRequestController === requestController) eventsRequestController = null;
    }
  },
  retryEvents: async () => {
    if (get().eventDataLoading) return false;
    set({ eventDataError: "", eventDataLoaded: false });
    return get().refreshEvents();
  },
  notifyDueEventReminders: async (items, now = new Date()) => {
    let delivered = [];
    set((state) => {
      const reminders = collectEventReminders(items, state.notifications, { now });
      if (!reminders.length) return {};
      delivered = reminders;
      return { notifications: [...reminders, ...state.notifications].slice(0, 500) };
    });
    if (!delivered.length) return 0;
    const deliveredIds = new Set(delivered.map((notification) => notification.id));
    try {
      await get().persistUserState();
    } catch {
      // Keep any unrelated concurrent notification edits, but remove only the
      // reminders that never reached the canonical state. System notifications
      // are sent only after persistence succeeds so a retry cannot duplicate a
      // reminder for data that was not actually saved.
      set((state) => ({ notifications: state.notifications.filter((notification) => !deliveredIds.has(notification.id)) }));
      return 0;
    }
    for (const notification of delivered) void sendSystemNotification(notification);
    return delivered.length;
  },
  setActiveView: (activeView) => set({ activeView }),
  selectSymbol: (selectedSymbol) => {
    const requested = String(selectedSymbol ?? "").trim();
    const key = quoteSymbolKey(requested);
    const resolved = get().watchlist.find((item) => quoteSymbolKey(item.symbol) === key)?.symbol || requested;
    set({ selectedSymbol: resolved, activeView: "watchlist" });
  },
  setChartRange: (chartRange) => set({ chartRange }),
  toggleSkill: async (id) => {
    const previous = get().skillItems;
    const next = previous.map((item) => item.id === id ? { ...item, installed: !item.installed } : item);
    if (next.every((item, index) => item.installed === previous[index]?.installed)) return false;
    set({ skillItems: next });
    try {
      await get().persistUserState();
      return true;
    } catch (error) {
      set((state) => ({ skillItems: state.skillItems.map((item) => {
        const optimistic = next.find((candidate) => candidate.id === item.id);
        const original = previous.find((candidate) => candidate.id === item.id);
        return optimistic && original && JSON.stringify(item) === JSON.stringify(optimistic) ? original : item;
      }) }));
      throw error;
    }
  },
  hydrateUserState: () => {
    if (userStateHydrationPromise) return userStateHydrationPromise;
    userStateHydrationPromise = (async () => {
      set({ userStateLoading: true, userStateError: "" });
      try {
        const persisted = await loadUserState();
        if (persisted && typeof persisted === "object") {
          const remote = normalizeUserState(persisted);
          // A user can interact with the shell before a slow Host responds. Treat
          // the built-in state as the three-way merge base so those early edits
          // are not silently replaced by the remote snapshot.
          const base = persistenceState(initialLabState);
          const local = persistenceState(get());
          const localChanged = !samePersistenceState(local, base);
          const hydrated = localChanged ? mergeUserStateChanges(base, local, remote) : remote;
          lastPersistedState = remote;
          lastLocalSnapshot = localChanged ? base : remote;
          set((state) => {
            const nextWatchlist = hydrated.watchlist.length
              ? hydrated.watchlist.map(normalizeWatchlistItem).filter((item) => item.symbol && item.name)
              : state.watchlist;
            // A persisted watchlist can legitimately change outside the current
            // WebView (another window, import, or a desktop session). Keep the
            // selected workspace anchored to a real row after hydration instead
            // of rendering a stale default/removed symbol in the detail pane.
            const selectedSymbol = nextWatchlist.some((item) => item.symbol === state.selectedSymbol)
              ? state.selectedSymbol
              : nextWatchlist[0]?.symbol || state.selectedSymbol;
            return { watchlist: nextWatchlist, selectedSymbol, rules: hydrated.monitorRules.length ? hydrated.monitorRules.map(normalizeRule) : state.rules, notifications: hydrated.notifications, portfolioPositions: hydrated.portfolioPositions.map(normalizePortfolioPosition).filter(Boolean), portfolioReviews: hydrated.portfolioReviews.slice(0, 90), briefingSchedule: normalizeBriefingSchedule(hydrated.briefingSchedule), premarketBriefing: hydrated.premarketBriefing, monitorHistory: hydrated.monitorHistory.slice(0, MAX_MONITOR_HISTORY), skillItems: skillItemsForIds(state.skillItems, hydrated.installedSkillIds), userStateLoaded: true, userStateLoading: false, userStateError: "" };
          });
          if (localChanged && !samePersistenceState(hydrated, remote)) void persistSnapshot(get());
        } else { lastPersistedState = null; lastLocalSnapshot = null; set({ userStateLoaded: true, userStateLoading: false, userStateError: "" }); await persistSnapshot(get()); }
        return true;
      } catch {
        const message = "本地数据暂时无法读取；请检查本地 Host 后重试";
        set({ userStateLoading: false, userStateError: message, userStateLoaded: false });
        return false;
      }
    })();
    userStateHydrationPromise = userStateHydrationPromise.finally(() => { userStateHydrationPromise = null; });
    return userStateHydrationPromise;
  },
  replaceUserState: async (snapshot) => {
    const current = get();
    if (current.runtimeConfiguring || current.runtimeCancelPending || current.monitorBusy || ["running", "cancelling"].includes(current.runtimeMode)) throw new Error("当前还有任务在运行，请稍后再导入");
    const watchlist = Array.isArray(snapshot?.watchlist) && snapshot.watchlist.length ? snapshot.watchlist.map(normalizeWatchlistItem).filter((item) => item.symbol && item.name) : null;
    if (!watchlist) throw new Error("备份至少需要包含一个自选标的");
    const rules = Array.isArray(snapshot.monitorRules) ? snapshot.monitorRules.map(normalizeRule) : [];
    const notifications = Array.isArray(snapshot.notifications) ? snapshot.notifications : [];
    const portfolioPositions = Array.isArray(snapshot.portfolioPositions) ? snapshot.portfolioPositions.map(normalizePortfolioPosition).filter(Boolean) : [];
    const portfolioReviews = Array.isArray(snapshot.portfolioReviews) ? snapshot.portfolioReviews.slice(0, 90) : [];
    const briefingSchedule = normalizeBriefingSchedule(snapshot.briefingSchedule);
    const premarketBriefing = normalizeUserState(snapshot).premarketBriefing;
    const monitorHistory = Array.isArray(snapshot.monitorHistory) ? snapshot.monitorHistory.slice(0, MAX_MONITOR_HISTORY) : [];
    liveRequestGeneration += 1;
    detailsRequestGeneration += 1;
    seriesRequestGeneration += 1;
    eventsRequestGeneration += 1;
    premarketRequestGeneration += 1;
    const selectedSymbol = watchlist.some((item) => item.symbol === current.selectedSymbol) ? current.selectedSymbol : watchlist[0].symbol;
    anomalyAttributionGenerations.clear();
    const previous = get();
    const nextSkillItems = skillItemsForIds(previous.skillItems, snapshot.installedSkillIds);
    const optimistic = { watchlist, rules, notifications, portfolioPositions, portfolioReviews, briefingSchedule, premarketBriefing, monitorHistory, skillItems: nextSkillItems, selectedSymbol };
    set((state) => ({ ...optimistic, premarketBriefingLoading: false, premarketBriefingScheduleBusy: false, premarketBriefingError: "", anomalyAttributions: {}, anomalyAttributionLoading: {}, anomalyAttributionError: {}, events: [], eventDataLoading: false, eventDataError: "", eventDataLastRefreshAt: null, eventDataLoaded: false, eventDataReceivedCount: 0, eventDataTotalCount: 0, ...quoteRefreshReset, userStateLoaded: true }));
    try {
      await get().persistUserState();
      return true;
    } catch (error) {
      set((state) => ({
        watchlist: JSON.stringify(state.watchlist) === JSON.stringify(optimistic.watchlist) ? previous.watchlist : state.watchlist,
        rules: JSON.stringify(state.rules) === JSON.stringify(optimistic.rules) ? previous.rules : state.rules,
        notifications: JSON.stringify(state.notifications) === JSON.stringify(optimistic.notifications) ? previous.notifications : state.notifications,
        portfolioPositions: JSON.stringify(state.portfolioPositions) === JSON.stringify(optimistic.portfolioPositions) ? previous.portfolioPositions : state.portfolioPositions,
        portfolioReviews: JSON.stringify(state.portfolioReviews) === JSON.stringify(optimistic.portfolioReviews) ? previous.portfolioReviews : state.portfolioReviews,
        briefingSchedule: JSON.stringify(state.briefingSchedule) === JSON.stringify(optimistic.briefingSchedule) ? previous.briefingSchedule : state.briefingSchedule,
        premarketBriefing: JSON.stringify(state.premarketBriefing) === JSON.stringify(optimistic.premarketBriefing) ? previous.premarketBriefing : state.premarketBriefing,
        monitorHistory: JSON.stringify(state.monitorHistory) === JSON.stringify(optimistic.monitorHistory) ? previous.monitorHistory : state.monitorHistory,
        skillItems: JSON.stringify(state.skillItems) === JSON.stringify(optimistic.skillItems) ? previous.skillItems : state.skillItems,
        selectedSymbol: state.selectedSymbol === optimistic.selectedSymbol ? previous.selectedSymbol : state.selectedSymbol,
        userStateLoaded: previous.userStateLoaded,
        ...quoteRefreshReset,
      }));
      throw error;
    }
  },
  persistUserState: () => persistSnapshot(get()),
  retryPersistedUserState: async () => {
    if (get().persistenceRetrying) return false;
    set({ persistenceRetrying: true });
    try {
      await get().persistUserState();
      set({ settingsNotice: { type: "success", text: "本地数据已保存" } });
      return true;
    } catch {
      return false;
    } finally {
      set({ persistenceRetrying: false });
    }
  },
  addWatchlist: async (item) => {
    const value = normalizeWatchlistItem({ ...item, market: String(item?.market ?? "").trim() || "自定义", category: String(item?.category ?? "").trim() || "自选" });
    if (!value.symbol || !value.name) throw new Error("请输入股票代码和名称");
    if (value.symbol.length > 64 || value.name.length > 128) throw new Error("股票代码或名称过长");
    if (get().watchlist.some((entry) => entry.symbol === value.symbol)) throw new Error("该标的已经在自选中");
    const previousSelectedSymbol = get().selectedSymbol;
    set((state) => ({ watchlist: [...state.watchlist, value], selectedSymbol: value.symbol }));
    try {
      await get().persistUserState();
      return value;
    } catch (error) {
      set((state) => ({
        watchlist: state.watchlist.filter((entry) => !(entry.symbol === value.symbol && JSON.stringify(entry) === JSON.stringify(value))),
        selectedSymbol: state.selectedSymbol === value.symbol ? previousSelectedSymbol : state.selectedSymbol,
      }));
      throw error;
    }
  },
  importWatchlistItems: async (items) => {
    const current = get().watchlist;
    const seen = new Set(current.map((item) => normalizeWatchlistItem(item).symbol));
    const added = [];
    let skipped = 0;
    for (const item of Array.isArray(items) ? items : []) {
      const value = normalizeWatchlistItem({ ...item, market: String(item?.market ?? "").trim() || "自定义", category: String(item?.category ?? "").trim() || "自选" });
      if (!value.symbol || !value.name || value.symbol.length > 64 || value.name.length > 128) { skipped += 1; continue; }
      if (seen.has(value.symbol)) { skipped += 1; continue; }
      if (current.length + added.length >= 200) throw new Error("自选最多保存 200 个标的");
      seen.add(value.symbol);
      added.push(value);
    }
    if (!added.length) throw new Error("没有可导入的新标的（可能已存在或格式无效）");
    const previousSelectedSymbol = get().selectedSymbol;
    set((state) => ({ watchlist: [...state.watchlist, ...added], selectedSymbol: added[0].symbol }));
    try {
      await get().persistUserState();
      return { added: added.length, skipped };
    } catch (error) {
      const addedBySymbol = new Map(added.map((entry) => [entry.symbol, entry]));
      set((state) => ({
        watchlist: state.watchlist.filter((entry) => {
          const original = addedBySymbol.get(entry.symbol);
          return !original || JSON.stringify(entry) !== JSON.stringify(original);
        }),
        selectedSymbol: state.selectedSymbol === added[0].symbol ? previousSelectedSymbol : state.selectedSymbol,
      }));
      throw error;
    }
  },
  moveWatchlistItem: async (symbol, direction) => {
    const previous = get().watchlist;
    const normalizedSymbol = String(symbol || "").trim().toUpperCase();
    const offset = direction === "up" ? -1 : direction === "down" ? 1 : 0;
    const currentIndex = previous.findIndex((item) => String(item?.symbol || "").trim().toUpperCase() === normalizedSymbol);
    if (!normalizedSymbol || offset === 0 || currentIndex < 0) return false;
    const currentGroup = normalizeWatchlistItem(previous[currentIndex]).group;
    const groupIndexes = previous.reduce((indexes, item, index) => {
      if (normalizeWatchlistItem(item).group === currentGroup) indexes.push(index);
      return indexes;
    }, []);
    const groupPosition = groupIndexes.indexOf(currentIndex);
    const targetIndex = groupIndexes[groupPosition + offset];
    if (targetIndex == null) return false;
    const next = [...previous];
    [next[currentIndex], next[targetIndex]] = [next[targetIndex], next[currentIndex]];
    set({ watchlist: next });
    try {
      await get().persistUserState();
      return true;
    } catch (error) {
      // Preserve a later edit made while persistence was in flight; only undo
      // this move when the list is still exactly the optimistic snapshot.
      set((state) => JSON.stringify(state.watchlist) === JSON.stringify(next) ? { watchlist: previous } : {});
      throw error;
    }
  },
  savePortfolioPosition: async (input) => {
    const normalized = normalizePortfolioPosition(input);
    if (!normalized) throw new Error("请输入有效的持仓数量和成本");
    normalized.id = normalized.id || createId("position");
    const current = get().portfolioPositions;
    const previous = current.find((position) => position.id === normalized.id) || null;
    const exists = Boolean(previous);
    let next = normalized;
    if (hasPortfolioPlan(normalized)) {
      next = { ...next, planCreatedAt: previous?.planCreatedAt || normalized.planCreatedAt || nowIso(), planActions: previous?.planActions || normalized.planActions };
      if (!previous) next = appendPortfolioPlanAction(next, "created", "建立交易计划");
      else if (portfolioPlanChanged(previous, normalized)) {
        next = { ...next, takeProfitTriggered: false, stopLossTriggered: false };
        next = appendPortfolioPlanAction(next, "adjusted", "调整交易计划参数");
      } else next = { ...next, planStatus: previous.planStatus || "active", planUpdatedAt: previous.planUpdatedAt || null };
    } else if (previous && hasPortfolioPlan(previous)) {
      next = appendPortfolioPlanAction({ ...next, planActions: previous.planActions, planCreatedAt: previous.planCreatedAt }, "archived", "清除计划参数");
      next = { ...next, planThesis: "", planHorizon: null, takeProfitPrice: null, stopLossPrice: null, takeProfitTriggered: false, stopLossTriggered: false };
    }
    const portfolioPositions = exists ? current.map((position) => position.id === next.id ? next : position) : [...current, next];
    const previousPremarket = get().premarketBriefing;
    set({ portfolioPositions, premarketBriefing: null, premarketBriefingError: "" });
    try {
      await get().persistUserState();
      return next;
    } catch (error) {
      set((state) => ({ portfolioPositions: state.portfolioPositions.map((position) => {
        if (position.id !== next.id) return position;
        const optimisticPosition = position.id === next.id && JSON.stringify(position) === JSON.stringify(next);
        return optimisticPosition ? previous || null : position;
      }).filter(Boolean), premarketBriefing: state.premarketBriefing ? state.premarketBriefing : previousPremarket }));
      throw error;
    }
  },
  importPortfolioItems: async (items) => {
    const imported = (Array.isArray(items) ? items : []).map(normalizePortfolioPosition).filter(Boolean);
    if (!imported.length) throw new Error("没有可导入的有效持仓");
    const previous = get().portfolioPositions;
    const bySymbol = new Map(previous.map((position) => [position.symbol, position]));
    const nextImported = imported.map((position) => ({ ...position, id: bySymbol.get(position.symbol)?.id || createId("position") }));
    const importedSymbols = new Set(nextImported.map((position) => position.symbol));
    const importedBySymbol = new Map(nextImported.map((position) => [position.symbol, position]));
    const next = previous.map((position) => importedBySymbol.get(position.symbol) || position);
    next.push(...nextImported.filter((position) => !previous.some((candidate) => candidate.symbol === position.symbol)));
    const previousPremarket = get().premarketBriefing;
    set({ portfolioPositions: next, premarketBriefing: null, premarketBriefingError: "" });
    try {
      await get().persistUserState();
      return nextImported;
    } catch (error) {
      set((state) => JSON.stringify(state.portfolioPositions) === JSON.stringify(next) ? { portfolioPositions: previous, premarketBriefing: previousPremarket } : {});
      throw error;
    }
  },
  updatePortfolioPlanStatus: async (id, status, note = "") => {
    if (!["active", "executed", "archived"].includes(status)) throw new Error("交易计划状态无效");
    const current = get().portfolioPositions;
    const previous = current.find((position) => position.id === id);
    if (!previous || !hasPortfolioPlan(previous)) return false;
    const action = status === "executed" ? "executed" : status === "archived" ? "archived" : "reopened";
    const next = appendPortfolioPlanAction(previous, action, note);
    set({ portfolioPositions: current.map((position) => position.id === id ? next : position) });
    try {
      await get().persistUserState();
      return next;
    } catch (error) {
      set((state) => ({ portfolioPositions: state.portfolioPositions.map((position) => position.id === id && JSON.stringify(position) === JSON.stringify(next) ? previous : position) }));
      throw error;
    }
  },
  removePortfolioPosition: async (id) => {
    const previous = get().portfolioPositions;
    const removedIndex = previous.findIndex((position) => position.id === id);
    const portfolioPositions = previous.filter((position) => position.id !== id);
    if (removedIndex < 0) return false;
    const previousPremarket = get().premarketBriefing;
    set({ portfolioPositions, premarketBriefing: null, premarketBriefingError: "" });
    try {
      await get().persistUserState();
      return true;
    } catch (error) {
      const removed = previous[removedIndex];
      set((state) => state.portfolioPositions.some((position) => position.id === id)
        ? {}
        : { portfolioPositions: [...state.portfolioPositions.slice(0, removedIndex), removed, ...state.portfolioPositions.slice(removedIndex)], premarketBriefing: previousPremarket });
      throw error;
    }
  },
  createPortfolioReview: async () => {
    const state = get();
    const review = createPortfolioReviewSnapshot({ positions: state.portfolioPositions, liveQuotes: state.liveQuotes, events: state.events, createdAt: nowIso(), id: createId("portfolio-review") });
    set({ portfolioReviews: [review, ...state.portfolioReviews].slice(0, 90) });
    try {
      await get().persistUserState();
      return review;
    } catch (error) {
      set((current) => ({ portfolioReviews: current.portfolioReviews.filter((candidate) => candidate.id !== review.id) }));
      throw error;
    }
  },
  cancelPremarketBriefing: () => {
    if (!get().premarketBriefingLoading) return false;
    premarketRequestGeneration += 1;
    abortController(premarketRequestController);
    premarketRequestController = null;
    set({ premarketBriefingLoading: false, premarketBriefingError: "已停止本轮盘前摘要更新，可稍后重试" });
    return true;
  },
  generatePremarketBriefing: async (createdAt = new Date()) => {
    const state = get();
    if (!hasRealDataAccess(state.integrationStatus)) {
      set({ premarketBriefingError: "请先在设置中保存 API Key，再获取真实盘前数据" });
      return false;
    }
    if (!state.portfolioPositions.length || state.premarketBriefingLoading) return false;
    const requestGeneration = ++premarketRequestGeneration;
    const requestController = new AbortController();
    abortController(premarketRequestController);
    premarketRequestController = requestController;
    set({ premarketBriefingLoading: true, premarketBriefingError: "" });
    const newsBySymbol = {};
    const eventRows = [];
    const industryNews = [];
    const macroNews = [];
    const overseas = [];
    let received = 0;
    try {
      await mapWithConcurrency(state.portfolioPositions, resolveLiveQuoteConcurrency(), async (position) => {
        if (requestGeneration !== premarketRequestGeneration) return false;
        const input = { symbol: qverisSymbol(position.symbol, position.market) };
        const results = await Promise.allSettled([
          queryCapabilityData({ kind: "sentiment", ...input }, { timeoutMs: 60_000, signal: requestController.signal }),
          queryCapabilityData({ kind: "core_event", ...input }, { timeoutMs: 60_000, signal: requestController.signal }),
        ]);
        if (requestGeneration !== premarketRequestGeneration) return false;
        const newsResult = results[0]?.status === "fulfilled" ? results[0].value : null;
        const eventResult = results[1]?.status === "fulfilled" ? results[1].value : null;
        const key = String(position.symbol || "").trim().toUpperCase();
        const normalizedNews = normalizePremarketNews(newsResult, position);
        const normalizedEvents = normalizePremarketEvents(eventResult, position);
        newsBySymbol[key] = normalizedNews;
        eventRows.push(...normalizedEvents);
        if (normalizedNews.length || normalizedEvents.length) received += 1;
        return true;
      });
      if (requestGeneration !== premarketRequestGeneration) return false;
      const categories = [...new Set(state.portfolioPositions.map((position) => String(position.category || "").trim()).filter(Boolean))].slice(0, 3);
      const indexSymbols = ["DJI", "SPX", "IXIC"];
      const contextRequests = [
        ...categories.map((category) => queryCapabilityData({ kind: "market_news", query: category, category: "market", limit: 8 }, { timeoutMs: 45_000, signal: requestController.signal })),
        queryCapabilityData({ kind: "market_news", query: "宏观经济 利率 通胀 政策", category: "market", limit: 10 }, { timeoutMs: 45_000, signal: requestController.signal }),
        ...indexSymbols.map((symbol) => queryCapabilityData({ kind: "index_levels", symbol, market: "US", interval: "tick" }, { timeoutMs: 45_000, signal: requestController.signal })),
        queryCapabilityData({ kind: "commodity", commodityName: "WTI", frequency: "daily" }, { timeoutMs: 45_000, signal: requestController.signal }),
        queryCapabilityData({ kind: "commodity", commodityName: "Gold", frequency: "daily" }, { timeoutMs: 45_000, signal: requestController.signal }),
      ];
      const contextResults = await Promise.allSettled(contextRequests);
      if (requestGeneration !== premarketRequestGeneration) return false;
      categories.forEach((_, index) => { const result = contextResults[index]?.status === "fulfilled" ? contextResults[index].value : null; industryNews.push(...normalizePremarketMarketNews(result)); });
      const macroResult = contextResults[categories.length]?.status === "fulfilled" ? contextResults[categories.length].value : null;
      macroNews.push(...normalizePremarketMarketNews(macroResult));
      for (const result of contextResults.slice(categories.length + 1, categories.length + 1 + indexSymbols.length)) if (result.status === "fulfilled") overseas.push(...normalizePremarketIndices(result.value));
      for (const result of contextResults.slice(categories.length + 1 + indexSymbols.length)) if (result.status === "fulfilled") overseas.push(...normalizePremarketCommodities(result.value));
      const normalizedCreatedAt = createdAt instanceof Date ? createdAt.toISOString() : String(createdAt || new Date().toISOString());
      const briefing = buildPremarketBriefing({ positions: get().portfolioPositions, newsBySymbol, events: [...get().events, ...eventRows], industryNews, macroNews, overseas, createdAt: normalizedCreatedAt, id: createId("premarket") });
      const previousBriefing = get().premarketBriefing;
      set({ premarketBriefing: briefing, premarketBriefingLoading: false, premarketBriefingError: received ? "" : "当前渠道暂未返回持仓公告或事件" });
      try {
        await get().persistUserState();
      } catch (error) {
        set((current) => current.premarketBriefing?.id === briefing.id ? { premarketBriefing: previousBriefing, premarketBriefingError: friendlyDataMessage(error, "盘前摘要已生成但暂时无法保存，请稍后重试") } : {});
        return false;
      }
      return true;
    } catch (error) {
      if (requestGeneration !== premarketRequestGeneration) return false;
      set({ premarketBriefingLoading: false, premarketBriefingError: friendlyDataMessage(error, "盘前真实数据暂时无法获取，可稍后重试") });
      return false;
    } finally {
      if (premarketRequestController === requestController) premarketRequestController = null;
    }
  },
  runDuePremarketBriefing: async (now = new Date()) => {
    let acquired = false;
    let slot;
    let calendarQuerying = false;
    const attemptedAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    set((state) => {
      slot = premarketSlot({ now, schedule: state.briefingSchedule, positionCount: state.portfolioPositions.length });
      if (!["due", "calendar-needed"].includes(slot.status) || state.premarketBriefingScheduleBusy || state.premarketBriefingLoading) return {};
      acquired = true;
      calendarQuerying = slot.status === "calendar-needed";
      return { premarketBriefingScheduleBusy: true, briefingSchedule: { ...state.briefingSchedule, premarketLastAttemptAt: attemptedAt, premarketLastResult: calendarQuerying ? "waiting-calendar" : "waiting-data", premarketLastError: calendarQuerying ? "正在核对真实交易日历" : "正在获取真实盘前数据" } };
    });
    if (!acquired) return slot?.status || false;
    try {
      await get().persistUserState();
      if (calendarQuerying) {
        const marketcodes = marketCodesForPositions(get().portfolioPositions);
        const calendars = await Promise.all(marketcodes.map((marketcode) => marketcode === SSE_MARKET_CODE
          ? queryTradingCalendar(slot.tradingDate)
          : queryTradingCalendar(slot.tradingDate, marketcode)));
        const calendarStatus = calendars.every((calendar) => calendar?.isTradingDay === true) ? "trading" : "closed";
        const sources = [...new Set(calendars.map((calendar) => String(calendar?.source || "数据服务")))];
        const toolIds = [...new Set(calendars.map((calendar) => String(calendar?.toolId || "")).filter(Boolean))];
        set((current) => ({ briefingSchedule: { ...current.briefingSchedule, calendarDate: slot.tradingDate, calendarStatus, calendarCheckedAt: attemptedAt, calendarSource: sources.join(", "), calendarToolId: toolIds.join(", "), premarketLastResult: calendarStatus === "closed" ? "market-closed" : "waiting-data", premarketLastError: "" } }));
        await get().persistUserState();
        if (calendarStatus === "closed") {
          set({ premarketBriefingScheduleBusy: false });
          return "market-closed";
        }
        slot = { ...slot, status: "due" };
      }
      const generated = await get().generatePremarketBriefing(now);
      if (!generated) {
        set((current) => ({ premarketBriefingScheduleBusy: false, briefingSchedule: { ...current.briefingSchedule, premarketLastResult: "error", premarketLastError: current.premarketBriefingError || "盘前摘要暂时无法生成" } }));
        await get().persistUserState().catch(() => null);
        return "error";
      }
      const notification = { id: createId("notification"), kind: "briefing", symbol: "", name: "", ruleId: "", eventKey: slot.key, reminderPhase: "completed", title: `${slot.tradingDate} 盘前摘要已更新`, body: "已完成持仓公告、行业/宏观与隔夜市场的真实数据聚合。", severity: "info", createdAt: attemptedAt, read: false, source: "data-service" };
      set((current) => ({ notifications: [notification, ...current.notifications].slice(0, 500), premarketBriefingScheduleBusy: false, briefingSchedule: { ...current.briefingSchedule, premarketLastSuccessKey: slot.key, premarketLastResult: "success", premarketLastError: "" } }));
      try {
        await get().persistUserState();
      } catch (error) {
        set((current) => ({ premarketBriefingScheduleBusy: false, notifications: current.notifications.filter((candidate) => candidate.id !== notification.id), briefingSchedule: { ...current.briefingSchedule, premarketLastResult: "error", premarketLastError: friendlyDataMessage(error, "盘前摘要已生成但通知暂时无法保存") } }));
        return "error";
      }
      void sendSystemNotification(notification);
      return "success";
    } catch (error) {
      const message = friendlyDataMessage(error, "盘前真实数据暂时无法获取，可稍后重试");
      set((current) => ({ premarketBriefingScheduleBusy: false, briefingSchedule: { ...current.briefingSchedule, ...(calendarQuerying ? { calendarDate: slot?.tradingDate || "", calendarStatus: "error", calendarCheckedAt: attemptedAt } : {}), premarketLastResult: calendarQuerying ? "waiting-calendar" : "error", premarketLastError: message } }));
      await get().persistUserState().catch(() => null);
      return "error";
    }
  },
  updateBriefingSchedule: async (input) => {
    const previous = get().briefingSchedule;
    const briefingSchedule = normalizeBriefingSchedule({ ...previous, ...input, lastError: input?.enabled === false ? "" : previous.lastError });
    set({ briefingSchedule });
    try {
      await get().persistUserState();
    } catch (error) {
      set((state) => ({ briefingSchedule: JSON.stringify(state.briefingSchedule) === JSON.stringify(briefingSchedule) ? previous : state.briefingSchedule }));
      throw error;
    }
    if (briefingSchedule.enabled && !isDesktopRuntime()) void get().runDuePortfolioReview();
    if (briefingSchedule.premarketEnabled && !isDesktopRuntime()) void get().runDuePremarketBriefing();
    return briefingSchedule;
  },
  runDuePortfolioReview: async (now = new Date()) => {
    let acquired = false;
    let slot;
    let calendarQuerying = false;
    const attemptedAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    set((state) => {
      slot = briefingSlot({ now, schedule: state.briefingSchedule, reviews: state.portfolioReviews, positionCount: state.portfolioPositions.length });
      if (!["due", "calendar-needed"].includes(slot.status) || state.briefingScheduleBusy) return {};
      acquired = true;
      calendarQuerying = slot.status === "calendar-needed";
      return { briefingScheduleBusy: true, briefingSchedule: { ...state.briefingSchedule, lastAttemptAt: attemptedAt, lastResult: calendarQuerying ? "waiting-calendar" : "waiting-data", lastError: calendarQuerying ? "正在核对真实交易日历" : "正在刷新持仓真实行情" } };
    });
    if (!acquired) return slot?.status || false;
    try {
      await get().persistUserState();
    } catch (error) {
      set((current) => ({ briefingScheduleBusy: false, briefingSchedule: { ...current.briefingSchedule, lastResult: "error", lastError: friendlyDataMessage(error, "本地数据暂时无法保存，请稍后重试") } }));
      return "error";
    }
    try {
      if (calendarQuerying) {
        const marketcodes = marketCodesForPositions(get().portfolioPositions);
        const calendars = await Promise.all(marketcodes.map((marketcode) => marketcode === SSE_MARKET_CODE
          ? queryTradingCalendar(slot.tradingDate)
          : queryTradingCalendar(slot.tradingDate, marketcode)));
        const calendarStatus = calendars.every((calendar) => calendar?.isTradingDay === true) ? "trading" : "closed";
        const sources = [...new Set(calendars.map((calendar) => String(calendar?.source || "数据服务")))];
        const toolIds = [...new Set(calendars.map((calendar) => String(calendar?.toolId || "")).filter(Boolean))];
        set((current) => ({ briefingSchedule: { ...current.briefingSchedule, calendarDate: slot.tradingDate, calendarStatus, calendarCheckedAt: attemptedAt, calendarSource: sources.join(", "), calendarToolId: toolIds.join(", "), lastResult: calendarStatus === "closed" ? "market-closed" : "waiting-data", lastError: "" } }));
        await get().persistUserState();
        if (calendarStatus === "closed") {
          set({ briefingScheduleBusy: false });
          return "market-closed";
        }
        // This owner already paid for and completed the calendar gate.  Do not
        // let the attempt timestamp written above throttle the same run before
        // it reaches the real-quote gate; it only throttles later retries.
        slot = { ...slot, status: "due" };
      }
      if (!hasFreshPortfolioQuote({ positions: get().portfolioPositions, liveQuotes: get().liveQuotes, now })) await get().refreshLiveData();
      const state = get();
      if (!hasFreshPortfolioQuote({ positions: state.portfolioPositions, liveQuotes: state.liveQuotes, now })) {
        set((current) => ({ briefingScheduleBusy: false, briefingSchedule: { ...current.briefingSchedule, lastResult: "waiting-data", lastError: "尚未取得当日真实持仓行情，将按重试间隔再次尝试" } }));
        await get().persistUserState();
        return "waiting-data";
      }
      if (state.portfolioReviews.some((review) => review.kind === "close" && review.tradingDate === slot.tradingDate)) {
        set((current) => ({ briefingScheduleBusy: false, briefingSchedule: { ...current.briefingSchedule, lastSuccessKey: slot.key, lastResult: "success", lastError: "" } }));
        await get().persistUserState();
        return "completed";
      }
      const review = createPortfolioReviewSnapshot({ positions: state.portfolioPositions, liveQuotes: state.liveQuotes, events: state.events, createdAt: attemptedAt, id: createId("portfolio-review") });
      const notification = { id: createId("notification"), kind: "briefing", symbol: "", name: "", ruleId: "", eventKey: slot.key, reminderPhase: "completed", title: `${review.tradingDate} 组合复盘已生成`, body: `已使用 ${review.pricedCount}/${review.totalCount} 个持仓的当日真实行情生成复盘。`, severity: "info", createdAt: attemptedAt, read: false, source: "data-service" };
      set((current) => ({ portfolioReviews: [review, ...current.portfolioReviews].slice(0, 90), notifications: [notification, ...current.notifications].slice(0, 500), briefingScheduleBusy: false, briefingSchedule: { ...current.briefingSchedule, lastSuccessKey: slot.key, lastResult: "success", lastError: "" } }));
      try {
        await get().persistUserState();
      } catch (error) {
        set((current) => ({
          briefingScheduleBusy: false,
          portfolioReviews: current.portfolioReviews.filter((candidate) => candidate.id !== review.id),
          notifications: current.notifications.filter((candidate) => candidate.id !== notification.id),
          briefingSchedule: { ...current.briefingSchedule, lastResult: "error", lastError: friendlyDataMessage(error, "本地数据暂时无法保存，请稍后重试") },
        }));
        return "error";
      }
      void sendSystemNotification(notification);
      return "success";
    } catch (error) {
      const message = friendlyDataMessage(error);
      set((current) => ({ briefingScheduleBusy: false, briefingSchedule: { ...current.briefingSchedule, ...(calendarQuerying ? { calendarDate: slot?.tradingDate || "", calendarStatus: "error", calendarCheckedAt: attemptedAt } : {}), lastResult: calendarQuerying ? "waiting-calendar" : "error", lastError: message } }));
      // This is a background reconciliation path. Keep the in-memory error
      // visible for retry, but never turn a second persistence failure into an
      // unhandled rejection from an interval/desktop worker.
      await get().persistUserState().catch(() => null);
      return "error";
    }
  },
  removePortfolioReview: async (id) => {
    const previous = get().portfolioReviews;
    const removed = previous.find((review) => review.id === id);
    if (!removed) return false;
    set({ portfolioReviews: previous.filter((review) => review.id !== id) });
    try {
      await get().persistUserState();
      return true;
    } catch (error) {
      // Do not overwrite a newer edit made while the write was in flight.
      set((state) => state.portfolioReviews.some((review) => review.id === id)
        ? {}
        : { portfolioReviews: [...state.portfolioReviews, removed] });
      throw error;
    }
  },
  removeWatchlist: async (symbol) => {
    const previous = get().watchlist;
    const next = previous.filter((item) => item.symbol !== symbol);
    if (next.length === previous.length) return false;
    if (!next.length) throw new Error("至少保留一个自选标的");
    const removedIndex = previous.findIndex((item) => item.symbol === symbol);
    const previousSelectedSymbol = get().selectedSymbol;
    const optimisticSelectedSymbol = previousSelectedSymbol === symbol ? next[0].symbol : previousSelectedSymbol;
    set((state) => ({ watchlist: next, selectedSymbol: state.selectedSymbol === symbol ? next[0].symbol : state.selectedSymbol }));
    try {
      await get().persistUserState();
      return true;
    } catch (error) {
      // A concurrent add/edit is preserved; restore the removed row only when
      // it is still absent from the current list.
      set((state) => {
        if (state.watchlist.some((item) => item.symbol === symbol)) return {};
        const restored = [...state.watchlist];
        const removed = previous.find((item) => item.symbol === symbol);
        if (removed) restored.splice(Math.min(Math.max(removedIndex, 0), restored.length), 0, removed);
        return { watchlist: restored, selectedSymbol: state.selectedSymbol === optimisticSelectedSymbol ? previousSelectedSymbol : state.selectedSymbol };
      });
      throw error;
    }
  },
  toggleRule: async (id) => {
    const previous = get().rules;
    const previousRule = previous.find((rule) => rule.id === id);
    if (!previousRule) return false;
    const nextRule = { ...previousRule, enabled: !previousRule.enabled };
    set((state) => ({ rules: state.rules.map((rule) => rule.id === id ? nextRule : rule) }));
    try {
      await get().persistUserState();
      return true;
    } catch (error) {
      set((state) => state.rules.some((rule) => rule.id === id && JSON.stringify(rule) !== JSON.stringify(nextRule))
        ? {}
        : { rules: state.rules.map((rule) => rule.id === id ? previousRule : rule) });
      throw error;
    }
  },
  addRule: async (input = {}) => {
    const strategy = strategyFor(input.strategyId);
    const rule = normalizeRule({ ...input, id: createId("rule"), symbol: String(input.symbol || get().selectedSymbol || "600519"), strategyId: strategy.id });
    set((state) => ({ rules: [...state.rules, rule] }));
    try {
      await get().persistUserState();
      return rule;
    } catch (error) {
      set((state) => ({ rules: state.rules.filter((candidate) => candidate.id !== rule.id || JSON.stringify(candidate) !== JSON.stringify(rule)) }));
      throw error;
    }
  },
  updateRule: async (id, input = {}) => {
    const currentRules = get().rules;
    const previous = currentRules.find((rule) => rule.id === id);
    if (!previous) throw new Error("找不到要编辑的盯盘规则");
    const strategy = strategyFor(input.strategyId || previous.strategyId);
    const next = normalizeRule({ ...previous, ...input, id, strategyId: strategy.id });
    // Editing a condition invalidates the previous edge state. Keep the
    // timeline for audit, but require one fresh real-data evaluation before a
    // notification can fire again.
    const resetSignal = {
      ...next,
      lastCheckedAt: null,
      lastTriggeredAt: null,
      lastSignalTriggered: null,
      lastSignalBySymbol: {},
    };
    set((state) => ({ rules: state.rules.map((rule) => rule.id === id ? resetSignal : rule) }));
    try {
      await get().persistUserState();
      return resetSignal;
    } catch (error) {
      set((state) => ({ rules: state.rules.map((rule) => rule.id === id && JSON.stringify(rule) === JSON.stringify(resetSignal) ? previous : rule) }));
      throw error;
    }
  },
  deleteRule: async (id) => {
    const previous = get().rules;
    if (!previous.some((rule) => rule.id === id)) return false;
    const removedIndex = previous.findIndex((rule) => rule.id === id);
    const removed = previous[removedIndex];
    set({ rules: previous.filter((rule) => rule.id !== id) });
    try {
      await get().persistUserState();
      return true;
    } catch (error) {
      set((state) => state.rules.some((rule) => rule.id === id)
        ? {}
        : { rules: [...state.rules.slice(0, removedIndex), removed, ...state.rules.slice(removedIndex)].filter(Boolean) });
      throw error;
    }
  },
  addNotification: async (notification) => {
    const value = { ...notification, id: notification.id || createId("notification"), createdAt: notification.createdAt || nowIso(), read: false };
    set((state) => ({ notifications: [value, ...state.notifications].slice(0, 500) }));
    try {
      await get().persistUserState();
      return value;
    } catch (error) {
      set((state) => ({ notifications: state.notifications.filter((item) => item.id !== value.id) }));
      throw error;
    }
  },
  markNotificationRead: async (id) => {
    const previous = get().notifications.find((item) => item.id === id);
    if (!previous || previous.read) return false;
    set((state) => ({ notifications: state.notifications.map((item) => item.id === id ? { ...item, read: true } : item) }));
    try {
      await get().persistUserState();
      return true;
    } catch (error) {
      set((state) => ({ notifications: state.notifications.map((item) => item.id === id && item.read === true ? previous : item) }));
      throw error;
    }
  },
  markAllNotificationsRead: async () => {
    const previous = get().notifications;
    if (!previous.some((item) => !item.read)) return false;
    const unreadIds = new Set(previous.filter((item) => !item.read).map((item) => item.id));
    set((state) => ({ notifications: state.notifications.map((item) => unreadIds.has(item.id) ? { ...item, read: true } : item) }));
    try {
      await get().persistUserState();
      return true;
    } catch (error) {
      const previousById = new Map(previous.map((item) => [item.id, item]));
      set((state) => ({ notifications: state.notifications.map((item) => unreadIds.has(item.id) && item.read === true ? previousById.get(item.id) || item : item) }));
      throw error;
    }
  },
  runMonitorCheck: async (ruleId) => {
    // Keep the real-data boundary defensive at the Store API as well as in
    // the UI. Older views or direct integrations must not turn browser
    // preview output into persisted monitor history or notifications.
    const runtimeState = get();
    if (!(isLocalWebRuntime() || isDesktopRuntime()) || !hasRealDataAccess(runtimeState.integrationStatus)) return false;
    let acquired = false; let expired = false; let rule; let previousRule = null; let items = [];
    set((state) => {
      rule = state.rules.find((candidate) => candidate.id === ruleId);
      previousRule = rule ? { ...rule, lastSignalBySymbol: { ...(rule.lastSignalBySymbol || {}) } } : null;
      items = rule?.scope === "watchlist" ? state.watchlist : state.watchlist.filter((candidate) => candidate.symbol === rule?.symbol);
      if (rule?.enabled && isMonitorRuleExpired(rule)) {
        expired = true;
        return { rules: state.rules.map((candidate) => candidate.id === rule.id ? { ...candidate, enabled: false } : candidate) };
      }
      if (!rule || !rule.enabled || !items.length || state.monitorBusy || state.liveDataLoading || state.runtimeConfiguring || state.runtimeCancelPending || ["running", "cancelling"].includes(state.runtimeMode)) return {};
      acquired = true;
      const checkedAt = nowIso();
      return { monitorBusy: true, monitorLastRunAt: checkedAt, rules: state.rules.map((candidate) => candidate.id === rule.id ? { ...candidate, lastCheckedAt: checkedAt } : candidate) };
    });
    if (expired) {
      try {
        await get().persistUserState();
      } catch {
        set((state) => ({ rules: state.rules.map((candidate) => candidate.id === rule?.id && candidate.enabled === false && previousRule?.enabled === true ? previousRule : candidate) }));
      }
      return false;
    }
    if (!acquired) return false;
    const outcomes = await mapWithConcurrency(items, resolveLiveQuoteConcurrency(), async (item) => {
      const checkedAt = nowIso();
      try {
        const { result, reply, parsed } = await executeMonitorForItem(rule, item);
        const evaluation = parsed && typeof parsed === "object" && Array.isArray(parsed.conditionResults) ? { results: parsed.conditionResults } : null;
        return { item, result, reply, parsed, history: monitorHistoryFromResult(rule, item, result, reply, checkedAt, evaluation) };
      } catch (error) {
        const message = friendlyDataMessage(error, "这次检查暂时没有返回结果，系统会稍后重试");
        return { item, error: message, history: monitorHistoryFromResult(rule, item, { title: `${item?.name || rule.symbol} · 暂未完成检查`, summary: message, severity: "warning" }, { mode: "pi-local-host", audits: [] }, checkedAt, null, "error") };
      }
    });
    const deliveredNotifications = [];
    const createdNotificationIds = new Set();
    const createdHistoryIds = new Set();
    let committedRule = null;
    const checkedAt = nowIso();
    set((state) => {
      const currentRule = state.rules.find((candidate) => candidate.id === rule.id) || rule;
      const signalBySymbol = { ...(currentRule.lastSignalBySymbol || {}) };
      let lastSignalTriggered = currentRule.lastSignalTriggered;
      let lastTriggeredAt = currentRule.lastTriggeredAt;
      const notifications = [];
      let onceTriggered = false;
      const histories = outcomes.map((outcome) => outcome.history).filter(Boolean);
      for (const outcome of outcomes) {
        const symbol = outcome.item?.symbol || currentRule.symbol;
        if (outcome.error) continue;
        const hasDecision = typeof outcome.result?.triggered === "boolean";
        const triggered = outcome.result?.triggered === true;
        const previous = currentRule.scope === "watchlist" ? signalBySymbol[symbol] : currentRule.lastSignalTriggered;
        if (currentRule.scope === "watchlist") signalBySymbol[symbol] = hasDecision ? triggered : previous;
        else lastSignalTriggered = hasDecision ? triggered : lastSignalTriggered;
        if (triggered) lastTriggeredAt = checkedAt;
        if (currentRule.triggerMode === "once" && triggered) onceTriggered = true;
        // Alerts are edge-triggered per symbol; repeated true checks do not spam notifications.
        if (hasDecision && ((triggered && previous !== true) || outcome.reply?.mode === "browser-demo" || !outcome.parsed)) {
          const notification = notificationFromResult(currentRule, outcome.item, outcome.result, outcome.reply);
          notifications.push(notification);
          deliveredNotifications.push(notification);
        }
      }
      const failures = outcomes.filter((outcome) => outcome.error);
      if (failures.length) {
        const detail = failures.slice(0, 4).map((outcome) => `${outcome.item?.name || outcome.item?.symbol}：${outcome.error}`).join("；");
        const notification = { id: createId("notification"), kind: "monitor", symbol: currentRule.scope === "watchlist" ? "*" : String(currentRule.symbol || ""), name: currentRule.scope === "watchlist" ? "整个自选" : String(failures[0]?.item?.name || ""), ruleId: String(currentRule.id || ""), title: `${currentRule.scope === "watchlist" ? "整个自选" : failures[0]?.item?.name || currentRule.symbol} · 暂未完成检查`, body: `${detail}${failures.length > 4 ? `；另有 ${failures.length - 4} 个标的失败` : ""}`, severity: "warning", createdAt: checkedAt, read: false, source: "data-service" };
        notifications.push(notification);
        deliveredNotifications.push(notification);
      }
      histories.forEach((history) => createdHistoryIds.add(history.id));
      notifications.forEach((notification) => { createdNotificationIds.add(notification.id); });
      committedRule = { ...currentRule, enabled: onceTriggered ? false : currentRule.enabled, lastTriggeredAt, lastSignalTriggered, lastSignalBySymbol: signalBySymbol };
      return {
        monitorBusy: false,
        rules: state.rules.map((candidate) => candidate.id === currentRule.id ? committedRule : candidate),
        notifications: notifications.length ? [...notifications, ...state.notifications].slice(0, 500) : state.notifications,
        monitorHistory: [...histories, ...state.monitorHistory].slice(0, MAX_MONITOR_HISTORY),
      };
    });
    try {
      await get().persistUserState();
    } catch {
      // A failed save must not leave a successful-looking check or send a
      // system notification that cannot be recovered from the canonical state.
      set((state) => ({
        monitorBusy: false,
        rules: state.rules.map((candidate) => candidate.id === rule?.id && committedRule && JSON.stringify(candidate) === JSON.stringify(committedRule) ? previousRule : candidate),
        notifications: state.notifications.filter((notification) => !createdNotificationIds.has(notification.id)),
        monitorHistory: state.monitorHistory.filter((history) => !createdHistoryIds.has(history.id)),
      }));
      return false;
    }
    for (const notification of deliveredNotifications) void sendSystemNotification(notification);
    return outcomes.some((outcome) => !outcome.error);
  },
  runDueMonitorChecks: async () => {
    let state = get();
    const hostRuntime = isDesktopRuntime() || isLocalWebRuntime();
    const configured = hasRealDataAccess(state.integrationStatus);
    if (!hostRuntime || !state.userStateLoaded || !configured || state.monitorBusy) return false;
    const now = Date.now();
    const expiredIds = state.rules.filter((rule) => rule.enabled && isMonitorRuleExpired(rule, now)).map((rule) => rule.id);
    if (expiredIds.length) {
      const previousRules = state.rules;
      set((current) => ({ rules: current.rules.map((rule) => expiredIds.includes(rule.id) ? { ...rule, enabled: false } : rule) }));
      try {
        await get().persistUserState();
      } catch {
        set((current) => ({ rules: current.rules.map((rule) => {
          const previous = previousRules.find((candidate) => candidate.id === rule.id);
          return previous && expiredIds.includes(rule.id) && rule.enabled === false ? previous : rule;
        }) }));
        return false;
      }
      state = get();
    }
    const due = state.rules.find((rule) => {
      if (!rule.enabled || isMonitorRuleExpired(rule, now)) return false;
      if (!rule.lastCheckedAt) return rule.enabled;
      const checkedAt = Date.parse(rule.lastCheckedAt);
      return !Number.isFinite(checkedAt) || now - checkedAt >= rule.intervalSeconds * 1000;
    });
    return due ? get().runMonitorCheck(due.id) : false;
  },
  beginRuntimeConfiguration: () => { let acquired = false; set((state) => { if (state.runtimeConfiguring || state.runtimeCancelPending || state.monitorBusy || ["running", "cancelling"].includes(state.runtimeMode)) return {}; acquired = true; return { runtimeConfiguring: true }; }); return acquired; },
  endRuntimeConfiguration: () => set({ runtimeConfiguring: false }),
  setSettingsNotice: (settingsNotice) => set({ settingsNotice }), clearSettingsNotice: () => set({ settingsNotice: null }),
  sendMessage: async (text) => {
    const prompt = String(text ?? "").trim(); if (!prompt) return false; const userId = createId("message"); const assistantId = createId("message"); let acquired = false;
    set((state) => { if (state.runtimeConfiguring || state.runtimeCancelPending || state.monitorBusy || state.liveDataLoading || ["running", "cancelling"].includes(state.runtimeMode)) return {}; acquired = true; return { runtimeMode: "running", messages: [...state.messages, { id: userId, role: "user", text: prompt }, { id: assistantId, role: "assistant", text: RUNNING_REPLY, mode: "streaming", audits: [], streaming: true }] }; }); if (!acquired) return false;
    try {
      const integration = get().integrationStatus;
      const localHostNeedsSetup = isLocalWebRuntime() && integration && (!integration.credentialConfigured || !integration.settings?.modelId);
      if (localHostNeedsSetup) {
        const error = new Error("请先配置 QVeris API Key 和模型");
        error.code = "INTEGRATION_NOT_CONFIGURED";
        throw error;
      }
      const reply = await askPi(prompt, { onProgress: ({ text: partialText }) => set((state) => ({ messages: state.messages.map((message) => message.id === assistantId && message.streaming ? { ...message, text: partialText } : message) })) }); const quote = /实时数据|最新行情|最新价格/.test(prompt) ? quoteFromReply(reply.text) : null; set((state) => ({ runtimeMode: reply.mode, liveQuotes: quote ? { ...state.liveQuotes, [state.selectedSymbol]: quote } : state.liveQuotes, messages: state.messages.map((message) => message.id === assistantId ? { ...message, text: reply.text, mode: reply.mode, audits: reply.audits ?? [], streaming: false } : message) })); return true;
    }
    catch (error) { const cancelled = error?.code === ABORTED_CODE; set((state) => ({ runtimeMode: cancelled ? "cancelled" : "error", messages: state.messages.map((message) => message.id === assistantId ? { ...message, text: cancelled ? "已取消本轮分析。" : friendlyDataMessage(error, "这次分析暂时没有完成，稍后可以重试。"), mode: cancelled ? "cancelled" : "error", streaming: false } : message) })); return false; }
  },
  cancelMessage: async () => { let acquired = false; set((state) => { if (state.runtimeMode !== "running" || state.runtimeCancelPending) return {}; acquired = true; return { runtimeMode: "cancelling", runtimeCancelPending: true }; }); if (!acquired) return false; try { await abortPi(); set({ runtimeCancelPending: false }); return true; } catch { set((state) => ({ runtimeCancelPending: false, ...(state.runtimeMode === "cancelling" ? { runtimeMode: "running" } : {}) })); return false; } },
}));
