import { create } from "zustand";
import { skills, watchGroups } from "../data/market.js";
import { defaultMonitorRules, strategyFor } from "../data/monitorStrategies.js";
import { ABORTED_CODE, abortPi, askPi, isDesktopRuntime } from "../lib/piRuntime.js";
import { getDeveloperVariable, isLocalWebRuntime, queryCachedData } from "../lib/localHost.js";
import { loadIntegrationStatus } from "../lib/integrations.js";
import { loadUserState, saveUserState } from "../lib/userState.js";
import { friendlyDataMessage } from "../lib/friendlyMessages.js";
import { normalizePortfolioPosition } from "../lib/portfolio.js";
import { sendSystemNotification } from "../lib/systemNotifications.js";
import { conditionPrompt, conditionsForRule, evaluateRuleConditions, normalizeConditions, ruleConditionSummary } from "../lib/monitorConditions.js";

const RUNNING_REPLY = "Pi 正在分析…";
export const MONITOR_INTERVAL_MS = 30_000;
export const LIVE_QUOTE_REFRESH_INTERVAL_MS = 60_000;
const DEFAULT_LIVE_QUOTE_CONCURRENCY = 2;
const MAX_LIVE_QUOTE_CONCURRENCY = 4;
const MAX_MONITOR_HISTORY = 500;
const defaultWatchlist = watchGroups.flatMap((group) => group.items).slice(0, 8).map((item) => ({ ...item }));
let persistenceQueue = Promise.resolve();
let liveRequestGeneration = 0;
let detailsRequestGeneration = 0;
let seriesRequestGeneration = 0;

function persistSnapshot(snapshot) {
  persistenceQueue = persistenceQueue.catch(() => {}).then(() => saveUserState({ watchlist: snapshot.watchlist, monitorRules: snapshot.rules, notifications: snapshot.notifications, portfolioPositions: snapshot.portfolioPositions, monitorHistory: snapshot.monitorHistory }));
  return persistenceQueue;
}
function nowIso() { return new Date().toISOString(); }
function createId(prefix) { return `${prefix}-${typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`}`; }
function qverisSymbol(value) {
  const raw = String(value || "").trim().toUpperCase();
  if (!raw) return raw;
  if (/\.(SH|SS|SZ|BJ)$/.test(raw)) return raw.replace(/\.SS$/, ".SH");
  if (/^(600|601|603|605|688|689)\d{3}$/.test(raw)) return `${raw}.SH`;
  if (/^(000|001|002|003|300|301)\d{3}$/.test(raw)) return `${raw}.SZ`;
  return raw;
}
function marketContext(item) {
  const market = String(item?.market || item?.category || "").toLocaleUpperCase("zh-CN");
  if (/NASDAQ|NYSE|AMEX|美股|US/.test(market)) return "美股";
  if (/HKEX|港股|香港|HK/.test(market)) return "港股";
  return "A股";
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
  return { id: String(rule.id ?? createId("rule")), symbol: String(rule.symbol ?? "600519"), strategyId: strategy.id, conditions, logic: String(rule.logic || "AND").toUpperCase() === "OR" ? "OR" : "AND", threshold, intervalSeconds: Math.max(15, Math.min(86_400, Number(rule.intervalSeconds) || 300)), enabled: rule.enabled !== false, lastCheckedAt: rule.lastCheckedAt ?? null, lastTriggeredAt: rule.lastTriggeredAt ?? null, lastSignalTriggered: typeof rule.lastSignalTriggered === "boolean" ? rule.lastSignalTriggered : null };
}
function notificationFromResult(rule, item, result, reply) {
  const strategy = strategyFor(rule.strategyId);
  const body = String(result.summary || result.body || reply.text || "检查完成，请打开对话查看完整的来源与审计记录。").trim();
  const dataServiceMode = ["pi-rpc", "pi-local-host", "standalone-dev-host"].includes(reply.mode);
  return { id: createId("notification"), kind: "monitor", title: String(result.title || `${item?.name || rule.symbol} · ${strategy.name}`), body: body.slice(0, 4096), severity: ["info", "warning", "critical"].includes(result.severity) ? result.severity : "info", createdAt: nowIso(), read: false, source: dataServiceMode ? "data-service" : "browser-demo" };
}
function monitorHistoryFromResult(rule, item, result, reply, checkedAt, evaluation = null, outcome = null) {
  const triggered = typeof result?.triggered === "boolean" ? result.triggered : null;
  return {
    id: createId("monitor-check"),
    ruleId: rule.id,
    symbol: rule.symbol,
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
  if (value && Number.isFinite(Number(value.price))) {
    return {
      price: Number(value.price),
      change: Number.isFinite(Number(value.change)) ? Number(value.change) : null,
      asOf: String(value.asOf || ""),
      source: String(value.source || "数据服务"),
      series: Array.isArray(value.series) ? value.series : [],
      fundamentals: value.fundamentals && typeof value.fundamentals === "object" ? value.fundamentals : {},
      companyDescription: typeof value.companyDescription === "string" ? value.companyDescription : "",
    };
  }
  const source = String(text ?? "");
  const priceMatch = source.match(/(?:最新价|当前价|收盘价|last\s*price)[^\d$￥¥]{0,24}[$￥¥]?\s*([\d,]+(?:\.\d+)?)/i);
  if (!priceMatch) return null;
  const changeMatch = source.match(/(?:涨跌幅|涨幅|change)[^\d+\-]{0,18}([+\-]?\d+(?:\.\d+)?)\s*%/i);
  const asOfMatch = source.match(/(?:数据时间|截至|as\s*of)[：:\s]*([^\n|]+)/i);
  const sourceMatch = source.match(/(?:数据来源|来源|source)[：:\s]*([^\n|]+)/i);
  return {
    price: Number(priceMatch[1].replaceAll(",", "")),
    change: changeMatch ? Number(changeMatch[1]) : null,
    asOf: asOfMatch?.[1]?.trim() || "",
    source: sourceMatch?.[1]?.trim() || "数据服务",
  };
}

function normalizeLiveQuote(value) {
  if (!value || typeof value !== "object") return null;
  const price = Number(value.price ?? value.lastPrice ?? value.last_price);
  if (!Number.isFinite(price)) return null;
  const previousClose = Number(value.previousClose ?? value.previous_close ?? value.prevClose);
  const rawChange = Number(value.changeAmount ?? value.change_amount ?? value.changeValue ?? value.change);
  const explicitPercent = Number(value.changePercent ?? value.change_percent ?? value.pctChange ?? value.percentChange);
  const change = Number.isFinite(explicitPercent)
    ? explicitPercent
    : Number.isFinite(previousClose) && previousClose !== 0 && Number.isFinite(rawChange)
      ? rawChange / previousClose * 100
      : null;
  return {
    price,
    change: Number.isFinite(change) ? change : null,
    changeAmount: Number.isFinite(rawChange) ? rawChange : Number.isFinite(previousClose) ? price - previousClose : null,
    asOf: String(value.asOf ?? value.as_of ?? value.timestamp ?? ""),
    source: String(value.source ?? value.dataSource ?? "数据服务"),
    open: value.open ?? null,
    previousClose: Number.isFinite(previousClose) ? previousClose : value.previousClose ?? null,
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

async function queryMonitorData(kind, symbol) {
  if (!isLocalWebRuntime() || typeof queryCachedData !== "function") return null;
  try {
    const cached = await queryCachedData({ kind, symbol: qverisSymbol(symbol) }, { timeoutMs: 60_000 });
    const text = JSON.stringify(cached?.data ?? cached ?? {});
    return { fields: monitorFieldsFromReply(text, symbol), mode: cached?.mode || "pi-local-host", audits: cached?.audits || [{ operation: "cap-call", outcome: "success", kind }] };
  } catch {
    return null;
  }
}

function conditionMonitorResult(rule, item, data) {
  const evaluation = evaluateRuleConditions(rule, data);
  if (!evaluation.known) throw new Error("数据服务未返回条件所需的完整字段");
  const asOf = String(data?.asOf || "数据时间未知");
  const source = String(data?.source || "数据服务");
  const metric = Number.isFinite(Number(data?.price)) ? `最新价 ${Number(data.price).toFixed(2)}；` : "";
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
  const price = Number.isFinite(Number(quote.price)) ? `最新价 ${Number(quote.price).toFixed(2)}，` : "";
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
  if (isLocalWebRuntime()) {
    try {
      const cached = await queryCachedData({ kind, symbol: qverisSymbol(symbol), range }, { timeoutMs: options?.settleTimeoutMs || 90_000 });
      return { text: JSON.stringify(cached.data ?? cached), mode: cached.mode || "pi-local-host", audits: cached.audits || [{ operation: "cached-call", outcome: "success" }], cacheHit: cached.cacheHit === true };
    } catch (error) {
      if (error?.code !== "TOOL_CACHE_MISS") {
        // A stale tool is discarded by the Host; one normal Pi run below will
        // rediscover and solidify a replacement tool.
      }
    }
  }
  return askPi(prompt, options);
}

export const initialLabState = {
  activeView: "watchlist", selectedSymbol: "600519", chartRange: "分时", watchlist: defaultWatchlist, liveQuotes: {}, skillItems: skills.map((item) => ({ ...item })),
  messages: [{ id: "a1", role: "assistant", text: "选择标的后点击“实时数据”，或直接告诉我需要的市场、指标和时间范围。我会通过已配置的数据工具查询，并返回来源与截至时间。", mode: "onboarding", audits: [] }],
  rules: defaultMonitorRules.map(normalizeRule), notifications: [], portfolioPositions: [], monitorHistory: [], userStateLoaded: false, integrationStatus: null, integrationStatusLoading: false, integrationStatusError: "", liveDataLoading: false, liveDataError: "", liveDataLastRefreshAt: null, quoteDetailsLoading: {}, quoteDetailsLoaded: {}, quoteDetailsError: {}, quoteSeriesLoading: {}, quoteSeriesLoaded: {}, quoteSeriesError: {}, monitorBusy: false, monitorLastRunAt: null, runtimeMode: "ready", runtimeConfiguring: false, runtimeCancelPending: false, settingsNotice: null,
};

function dataChannelChanged(previous, next) {
  return Boolean(previous) && (
    previous.credentialConfigured !== next?.credentialConfigured
    || previous.settings?.modelId !== next?.settings?.modelId
    || previous.settings?.modelGatewayBaseUrl !== next?.settings?.modelGatewayBaseUrl
    || previous.settings?.capabilityBaseUrl !== next?.settings?.capabilityBaseUrl
  );
}

const quoteRefreshReset = {
  liveQuotes: {}, liveDataLastRefreshAt: null, liveDataError: "", liveDataLoading: false,
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
      liveRequestGeneration += 1;
      detailsRequestGeneration += 1;
      seriesRequestGeneration += 1;
    }
    return { integrationStatus, integrationStatusLoading: false, integrationStatusError: "", ...(changed ? quoteRefreshReset : {}) };
  }),
  refreshLiveData: async () => {
    const state = get();
    const configured = Boolean(state.integrationStatus?.credentialConfigured && state.integrationStatus?.settings?.modelId);
    if (!configured || !state.watchlist.length || state.liveDataLoading || state.runtimeConfiguring || state.runtimeCancelPending || state.monitorBusy || state.runtimeMode === "running" || state.runtimeMode === "cancelling") return false;
    const requestGeneration = ++liveRequestGeneration;
    set({ liveDataLoading: true, liveDataError: "" });
    const errors = [];
    let received = 0;
    try {
      const concurrency = resolveLiveQuoteConcurrency();
      await mapWithConcurrency(state.watchlist, concurrency, async (item) => {
        try {
          if (requestGeneration !== liveRequestGeneration) return false;
          const marketSymbol = qverisSymbol(item.symbol);
          const prompt = `使用内置 qveris-finance-research Skill 查询 ${item.name}（${item.symbol}）${marketContext(item)}实时行情快照。调用工具时参数 symbol 必须使用 ${marketSymbol}。只做一次 Search、一次 Inspect、一次 Call，选最匹配的实时行情工具，不要交叉核验，不要第二次搜索。不要使用示例数据。严格只返回一个 JSON 对象，不要 Markdown，格式为 {"quotes":[{"symbol":"${item.symbol}","name":"${item.name}","price":null,"changePercent":null,"changeAmount":null,"open":null,"previousClose":null,"high":null,"low":null,"volume":null,"turnover":null,"turnoverRate":null,"volumeRatio":null,"pe":null,"pb":null,"marketCap":null,"floatMarketCap":null,"asOf":"数据时间","source":"数据来源"}],"errors":[]}。没有真实值的字段填 null。`;
          const reply = await askFinancialData(prompt, "quote", item.symbol, "", { settleTimeoutMs: 60_000 });
          if (requestGeneration !== liveRequestGeneration) return false;
          const quotes = liveQuotesFromReply(reply.text, [item.symbol]);
          if (!Object.keys(quotes).length && reply.cacheHit) {
            const rediscovered = await askPi(prompt, { settleTimeoutMs: 60_000 });
            const recovered = liveQuotesFromReply(rediscovered.text, [item.symbol]);
            if (Object.keys(recovered).length) { received += 1; set((current) => ({ liveQuotes: { ...current.liveQuotes, ...recovered }, liveDataLastRefreshAt: nowIso() })); return true; }
          }
          if (!Object.keys(quotes).length) throw new Error("未返回可识别的真实行情");
          received += 1;
          set((current) => ({ liveQuotes: { ...current.liveQuotes, ...quotes }, liveDataLastRefreshAt: nowIso() }));
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
    }
  },
  retryLiveData: async () => {
    if (get().liveDataLoading) return false;
    set({ liveDataError: "" });
    return get().refreshLiveData();
  },
  refreshQuoteDetails: async (symbol) => {
    const state = get();
    const item = state.watchlist.find((entry) => entry.symbol === symbol);
    const configured = Boolean(state.integrationStatus?.credentialConfigured && state.integrationStatus?.settings?.modelId);
    if (!configured || !item || state.liveDataLoading || state.runtimeConfiguring || state.runtimeCancelPending || state.monitorBusy || state.runtimeMode === "running" || state.runtimeMode === "cancelling" || state.quoteDetailsLoading[symbol] || state.quoteDetailsLoaded[symbol]) return false;
    const requestGeneration = ++detailsRequestGeneration;
    set((current) => ({ quoteDetailsLoading: { ...current.quoteDetailsLoading, [symbol]: true }, quoteDetailsError: { ...current.quoteDetailsError, [symbol]: "" } }));
    try {
      const prompt = `使用内置 qveris-finance-research Skill 查询 ${item.name}（${item.symbol}）的真实公司简介和最近一期财务指标。调用工具时如需股票参数，使用 ${qverisSymbol(item.symbol)}。允许分别 Search 相关资料，但每个候选工具只能 Inspect 后 Call 一次。不要交叉核验，不要编造。只返回一个 JSON 对象，不要 Markdown：{"fundamentals":{"revenue":null,"netProfit":null,"grossMargin":null,"netMargin":null,"roe":null,"reportPeriod":""},"companyDescription":"","errors":[]}。没有真实数据填 null 或空字符串。`;
      const reply = await askFinancialData(prompt, "details", item.symbol, "", { settleTimeoutMs: 90_000 });
      if (requestGeneration !== detailsRequestGeneration) return false;
      let details = detailedQuoteFromReply(reply.text);
      if (!details && reply.cacheHit) details = detailedQuoteFromReply((await askPi(prompt, { settleTimeoutMs: 90_000 })).text);
      if (!details) throw new Error("数据服务暂未返回可识别的行情详情");
      set((current) => ({ liveQuotes: { ...current.liveQuotes, [symbol]: { ...current.liveQuotes[symbol], ...details.quote, reportPeriod: details.reportPeriod } }, quoteDetailsLoading: { ...current.quoteDetailsLoading, [symbol]: false }, quoteDetailsLoaded: { ...current.quoteDetailsLoaded, [symbol]: true }, quoteDetailsError: { ...current.quoteDetailsError, [symbol]: "" } }));
      return true;
    } catch (error) {
      if (requestGeneration !== detailsRequestGeneration) return false;
      set((current) => ({ quoteDetailsLoading: { ...current.quoteDetailsLoading, [symbol]: false }, quoteDetailsLoaded: { ...current.quoteDetailsLoaded, [symbol]: true }, quoteDetailsError: { ...current.quoteDetailsError, [symbol]: friendlyDataMessage(error) } }));
      return false;
    }
  },
  retryQuoteDetails: async (symbol) => {
    set((current) => ({ quoteDetailsLoaded: { ...current.quoteDetailsLoaded, [symbol]: false }, quoteDetailsError: { ...current.quoteDetailsError, [symbol]: "" } }));
    return get().refreshQuoteDetails(symbol);
  },
  refreshQuoteSeries: async (symbol, range) => {
    const state = get();
    const item = state.watchlist.find((entry) => entry.symbol === symbol);
    const configured = Boolean(state.integrationStatus?.credentialConfigured && state.integrationStatus?.settings?.modelId);
    const seriesBusy = Object.values(state.quoteSeriesLoading[symbol] || {}).some(Boolean);
    if (!configured || !item || !range || state.liveDataLoading || state.quoteDetailsLoading[symbol] || seriesBusy || state.runtimeConfiguring || state.runtimeCancelPending || state.monitorBusy || ["running", "cancelling"].includes(state.runtimeMode) || state.quoteSeriesLoading[symbol]?.[range] || state.quoteSeriesLoaded[symbol]?.[range]) return false;
    const requestGeneration = ++seriesRequestGeneration;
    set((current) => ({ quoteSeriesLoading: { ...current.quoteSeriesLoading, [symbol]: { ...(current.quoteSeriesLoading[symbol] || {}), [range]: true } }, quoteSeriesError: { ...current.quoteSeriesError, [symbol]: { ...(current.quoteSeriesError[symbol] || {}), [range]: "" } } }));
    const rangeRequest = { 分时: "今天的1分钟或5分钟分时", "5日": "最近5个交易日日线", 日K: "最近90个交易日日线", 周K: "最近52周周线", 月K: "最近60个月月线", 季K: "最近20个季度线", 年K: "最近10年年线" }[range] || range;
    try {
      const prompt = `使用内置 qveris-finance-research Skill 查询 ${item.name}（${item.symbol}）的${rangeRequest}真实行情。调用工具时如需股票参数，使用 ${qverisSymbol(item.symbol)}。只做一次 Search、一次 Inspect、一次 Call，选最匹配的历史或分时工具，不要交叉核验。只返回一个 JSON 对象，不要 Markdown：{"series":[]}。时间序列点使用 {"time":"ISO或YYYY-MM-DD HH:mm:ss","open":null,"high":null,"low":null,"close":null,"value":null,"volume":null}；没有真实数据返回空数组，禁止编造。`;
      const reply = await askFinancialData(prompt, "series", item.symbol, rangeRequest, { settleTimeoutMs: 60_000 });
      if (requestGeneration !== seriesRequestGeneration) return false;
      const series = seriesFromReply(reply.text);
      set((current) => ({ liveQuotes: { ...current.liveQuotes, [symbol]: { ...current.liveQuotes[symbol], seriesByRange: { ...(current.liveQuotes[symbol]?.seriesByRange || {}), [range]: series } } }, quoteSeriesLoading: { ...current.quoteSeriesLoading, [symbol]: { ...(current.quoteSeriesLoading[symbol] || {}), [range]: false } }, quoteSeriesLoaded: { ...current.quoteSeriesLoaded, [symbol]: { ...(current.quoteSeriesLoaded[symbol] || {}), [range]: true } }, quoteSeriesError: { ...current.quoteSeriesError, [symbol]: { ...(current.quoteSeriesError[symbol] || {}), [range]: "" } } }));
      return true;
    } catch (error) {
      if (requestGeneration !== seriesRequestGeneration) return false;
      set((current) => ({ quoteSeriesLoading: { ...current.quoteSeriesLoading, [symbol]: { ...(current.quoteSeriesLoading[symbol] || {}), [range]: false } }, quoteSeriesLoaded: { ...current.quoteSeriesLoaded, [symbol]: { ...(current.quoteSeriesLoaded[symbol] || {}), [range]: true } }, quoteSeriesError: { ...current.quoteSeriesError, [symbol]: { ...(current.quoteSeriesError[symbol] || {}), [range]: friendlyDataMessage(error) } } }));
      return false;
    }
  },
  retryQuoteSeries: async (symbol, range) => {
    set((current) => ({ quoteSeriesLoaded: { ...current.quoteSeriesLoaded, [symbol]: { ...(current.quoteSeriesLoaded[symbol] || {}), [range]: false } }, quoteSeriesError: { ...current.quoteSeriesError, [symbol]: { ...(current.quoteSeriesError[symbol] || {}), [range]: "" } } }));
    return get().refreshQuoteSeries(symbol, range);
  },
  setActiveView: (activeView) => set({ activeView }),
  selectSymbol: (selectedSymbol) => set({ selectedSymbol, activeView: "watchlist" }),
  setChartRange: (chartRange) => set({ chartRange }),
  toggleSkill: (id) => set((state) => ({ skillItems: state.skillItems.map((item) => item.id === id ? { ...item, installed: !item.installed } : item) })),
  hydrateUserState: async () => {
    try {
      const persisted = await loadUserState();
      if (persisted && typeof persisted === "object") set((state) => ({ watchlist: Array.isArray(persisted.watchlist) && persisted.watchlist.length ? persisted.watchlist : state.watchlist, rules: Array.isArray(persisted.monitorRules) && persisted.monitorRules.length ? persisted.monitorRules.map(normalizeRule) : state.rules, notifications: Array.isArray(persisted.notifications) ? persisted.notifications : state.notifications, portfolioPositions: Array.isArray(persisted.portfolioPositions) ? persisted.portfolioPositions.map(normalizePortfolioPosition).filter(Boolean) : state.portfolioPositions, monitorHistory: Array.isArray(persisted.monitorHistory) ? persisted.monitorHistory.slice(0, MAX_MONITOR_HISTORY) : state.monitorHistory, userStateLoaded: true }));
      else { set({ userStateLoaded: true }); void persistSnapshot(get()); }
    } catch (error) { set({ userStateLoaded: true, settingsNotice: { type: "error", text: "本地数据暂时无法读取，稍后可重试" } }); }
  },
  replaceUserState: async (snapshot) => {
    const current = get();
    if (current.runtimeConfiguring || current.runtimeCancelPending || current.monitorBusy || ["running", "cancelling"].includes(current.runtimeMode)) throw new Error("当前还有任务在运行，请稍后再导入");
    const watchlist = Array.isArray(snapshot?.watchlist) && snapshot.watchlist.length ? snapshot.watchlist : null;
    if (!watchlist) throw new Error("备份至少需要包含一个自选标的");
    const rules = Array.isArray(snapshot.monitorRules) ? snapshot.monitorRules.map(normalizeRule) : [];
    const notifications = Array.isArray(snapshot.notifications) ? snapshot.notifications : [];
    const portfolioPositions = Array.isArray(snapshot.portfolioPositions) ? snapshot.portfolioPositions.map(normalizePortfolioPosition).filter(Boolean) : [];
    const monitorHistory = Array.isArray(snapshot.monitorHistory) ? snapshot.monitorHistory.slice(0, MAX_MONITOR_HISTORY) : [];
    liveRequestGeneration += 1;
    detailsRequestGeneration += 1;
    seriesRequestGeneration += 1;
    const selectedSymbol = watchlist.some((item) => item.symbol === current.selectedSymbol) ? current.selectedSymbol : watchlist[0].symbol;
    set({ watchlist, rules, notifications, portfolioPositions, monitorHistory, selectedSymbol, ...quoteRefreshReset, userStateLoaded: true });
    await get().persistUserState();
    return true;
  },
  persistUserState: () => persistSnapshot(get()),
  addWatchlist: async (item) => {
    const value = { symbol: String(item?.symbol ?? "").trim().toUpperCase(), name: String(item?.name ?? "").trim(), market: String(item?.market ?? "").trim() || "自定义", category: String(item?.category ?? "").trim() || "自选" };
    if (!value.symbol || !value.name) throw new Error("请输入股票代码和名称");
    if (value.symbol.length > 64 || value.name.length > 128) throw new Error("股票代码或名称过长");
    if (get().watchlist.some((entry) => entry.symbol === value.symbol)) throw new Error("该标的已经在自选中");
    set((state) => ({ watchlist: [...state.watchlist, value], selectedSymbol: value.symbol })); await get().persistUserState(); return value;
  },
  savePortfolioPosition: async (input) => {
    const normalized = normalizePortfolioPosition(input);
    if (!normalized) throw new Error("请输入有效的持仓数量和成本");
    normalized.id = normalized.id || createId("position");
    const current = get().portfolioPositions;
    const exists = current.some((position) => position.id === normalized.id);
    const portfolioPositions = exists ? current.map((position) => position.id === normalized.id ? normalized : position) : [...current, normalized];
    set({ portfolioPositions });
    await get().persistUserState();
    return normalized;
  },
  removePortfolioPosition: async (id) => {
    const portfolioPositions = get().portfolioPositions.filter((position) => position.id !== id);
    if (portfolioPositions.length === get().portfolioPositions.length) return false;
    set({ portfolioPositions });
    await get().persistUserState();
    return true;
  },
  removeWatchlist: async (symbol) => {
    const next = get().watchlist.filter((item) => item.symbol !== symbol); if (!next.length) throw new Error("至少保留一个自选标的");
    set((state) => ({ watchlist: next, selectedSymbol: state.selectedSymbol === symbol ? next[0].symbol : state.selectedSymbol })); await get().persistUserState();
  },
  toggleRule: (id) => { set((state) => ({ rules: state.rules.map((rule) => rule.id === id ? { ...rule, enabled: !rule.enabled } : rule) })); void get().persistUserState(); },
  addRule: async (input = {}) => { const strategy = strategyFor(input.strategyId); const rule = normalizeRule({ ...input, id: createId("rule"), symbol: String(input.symbol || get().selectedSymbol || "600519"), strategyId: strategy.id }); set((state) => ({ rules: [...state.rules, rule] })); await get().persistUserState(); return rule; },
  deleteRule: async (id) => { set((state) => ({ rules: state.rules.filter((rule) => rule.id !== id) })); await get().persistUserState(); },
  addNotification: (notification) => { set((state) => ({ notifications: [{ ...notification, id: notification.id || createId("notification"), createdAt: notification.createdAt || nowIso(), read: false }, ...state.notifications].slice(0, 500) })); void get().persistUserState(); },
  markNotificationRead: (id) => { set((state) => ({ notifications: state.notifications.map((item) => item.id === id ? { ...item, read: true } : item) })); void get().persistUserState(); },
  markAllNotificationsRead: () => { set((state) => ({ notifications: state.notifications.map((item) => ({ ...item, read: true })) })); void get().persistUserState(); },
  runMonitorCheck: async (ruleId) => {
    let acquired = false; let rule; let item;
    set((state) => { rule = state.rules.find((candidate) => candidate.id === ruleId); item = state.watchlist.find((candidate) => candidate.symbol === rule?.symbol); if (!rule || !rule.enabled || state.monitorBusy || state.liveDataLoading || state.runtimeConfiguring || state.runtimeCancelPending || ["running", "cancelling"].includes(state.runtimeMode)) return {}; acquired = true; const checkedAt = nowIso(); return { monitorBusy: true, monitorLastRunAt: checkedAt, rules: state.rules.map((candidate) => candidate.id === rule.id ? { ...candidate, lastCheckedAt: checkedAt } : candidate) }; });
    if (!acquired) return false;
    const strategy = strategyFor(rule.strategyId);
    try {
      let reply; let result; let parsed = null;
      const monitorPrompt = `执行一次真实金融盯盘检查。标的：${item?.name || rule.symbol}（${rule.symbol}）。策略：${strategy.name}。条件：${ruleConditionSummary(rule)}。${conditionPrompt(rule)} ${strategy.prompt} 必须使用内置 qveris-finance-research Skill 按 Search → Inspect → Call 查询，不得使用界面示例数据。请严格返回一个 JSON 对象，不要 Markdown：{"triggered":true、false 或 null,"title":"简短标题","summary":"含来源和数据截至时间的结论","severity":"info|warning|critical","asOf":"数据截至时间"}。`;
      if (isLocalWebRuntime() && typeof queryCachedData === "function") {
        const kinds = [...new Set(conditionsForRule(rule).map((condition) => monitorDataKind(condition.type)))];
        const directResults = (await Promise.all(kinds.map((kind) => queryMonitorData(kind, rule.symbol)))).filter(Boolean);
        const monitorData = directResults.reduce((merged, current) => ({ ...merged, ...current.fields, asOf: current.fields.asOf || merged.asOf, source: current.fields.source || merged.source }), {});
        reply = { text: JSON.stringify(monitorData), mode: directResults[0]?.mode || "pi-local-host", audits: directResults.flatMap((current) => current.audits || []) };
        const evaluation = evaluateRuleConditions(rule, monitorData);
        if (directResults.length && evaluation.known) {
          result = conditionsForRule(rule).every((condition) => condition.type === "price_change") && monitorData.price !== undefined
            ? priceMonitorResult(rule, item, monitorData)
            : conditionMonitorResult(rule, item, monitorData);
          parsed = result;
        } else {
          // Direct CAP responses may be empty or omit a condition-specific
          // field. Ask the managed runtime once for the unresolved decision.
          reply = await askPi(monitorPrompt, { settleTimeoutMs: 120_000 });
          parsed = findJsonObject(reply.text);
          result = parsed || { triggered: null, title: `${item?.name || rule.symbol} · ${strategy.name}`, summary: "数据服务未返回完整条件字段。", severity: "info" };
        }
      } else {
        reply = await askPi(monitorPrompt, { settleTimeoutMs: 120_000 });
        parsed = findJsonObject(reply.text); result = parsed || { triggered: reply.mode !== "browser-demo", title: `${item?.name || rule.symbol} · ${strategy.name}`, summary: reply.mode === "browser-demo" ? "浏览器预览未执行真实数据查询，请先配置数据服务。" : reply.text, severity: "info" };
      }
      let deliveredNotification = null;
      const checkedAt = nowIso();
      const evaluation = parsed && typeof parsed === "object" && Array.isArray(parsed.conditionResults) ? { results: parsed.conditionResults } : null;
      const historyEntry = monitorHistoryFromResult(rule, item, result, reply, checkedAt, evaluation);
      set((state) => {
        const hasDecision = typeof result.triggered === "boolean";
        const triggered = result.triggered === true;
        // Alerts are edge-triggered: keep one notification while a condition
        // remains true, then allow a new notification after it resets.
        const shouldNotify = hasDecision && ((triggered && rule.lastSignalTriggered !== true) || reply.mode === "browser-demo" || !parsed);
        const notification = shouldNotify ? notificationFromResult(rule, item, result, reply) : null;
        deliveredNotification = notification;
        return {
          monitorBusy: false,
          rules: state.rules.map((candidate) => candidate.id === rule.id ? { ...candidate, lastTriggeredAt: triggered ? nowIso() : candidate.lastTriggeredAt, lastSignalTriggered: hasDecision ? triggered : candidate.lastSignalTriggered } : candidate),
          notifications: notification ? [notification, ...state.notifications].slice(0, 500) : state.notifications,
          monitorHistory: [historyEntry, ...state.monitorHistory].slice(0, MAX_MONITOR_HISTORY),
        };
      });
      if (deliveredNotification) void sendSystemNotification(deliveredNotification);
      await get().persistUserState(); return true;
    } catch (error) {
      const message = friendlyDataMessage(error, "这次检查暂时没有返回结果，系统会稍后重试");
      const checkedAt = nowIso();
      const historyEntry = monitorHistoryFromResult(rule, item, { title: `${item?.name || rule.symbol} · 暂未完成检查`, summary: message, severity: "warning" }, { mode: "pi-local-host", audits: [] }, checkedAt, null, "error");
      set((state) => ({ monitorBusy: false, monitorHistory: [historyEntry, ...state.monitorHistory].slice(0, MAX_MONITOR_HISTORY), notifications: [{ id: createId("notification"), kind: "monitor", title: `${item?.name || rule.symbol} · 暂未完成检查`, body: message, severity: "warning", createdAt: checkedAt, read: false, source: "data-service" }, ...state.notifications].slice(0, 500) })); await get().persistUserState(); return false;
    }
  },
  runDueMonitorChecks: async () => {
    const state = get();
    const hostRuntime = isDesktopRuntime() || isLocalWebRuntime();
    const configured = Boolean(state.integrationStatus?.credentialConfigured && state.integrationStatus?.settings?.modelId);
    if (!hostRuntime || !state.userStateLoaded || !configured || state.monitorBusy) return false;
    const now = Date.now();
    const due = state.rules.find((rule) => {
      if (!rule.enabled || !rule.lastCheckedAt) return rule.enabled;
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
    try { const reply = await askPi(prompt, { onProgress: ({ text: partialText }) => set((state) => ({ messages: state.messages.map((message) => message.id === assistantId && message.streaming ? { ...message, text: partialText } : message) })) }); const quote = /实时数据|最新行情|最新价格/.test(prompt) ? quoteFromReply(reply.text) : null; set((state) => ({ runtimeMode: reply.mode, liveQuotes: quote ? { ...state.liveQuotes, [state.selectedSymbol]: quote } : state.liveQuotes, messages: state.messages.map((message) => message.id === assistantId ? { ...message, text: reply.text, mode: reply.mode, audits: reply.audits ?? [], streaming: false } : message) })); return true; }
    catch (error) { const cancelled = error?.code === ABORTED_CODE; set((state) => ({ runtimeMode: cancelled ? "cancelled" : "error", messages: state.messages.map((message) => message.id === assistantId ? { ...message, text: cancelled ? "已取消本轮分析。" : friendlyDataMessage(error, "这次分析暂时没有完成，稍后可以重试。"), mode: cancelled ? "cancelled" : "error", streaming: false } : message) })); return false; }
  },
  cancelMessage: async () => { let acquired = false; set((state) => { if (state.runtimeMode !== "running" || state.runtimeCancelPending) return {}; acquired = true; return { runtimeMode: "cancelling", runtimeCancelPending: true }; }); if (!acquired) return false; try { await abortPi(); set({ runtimeCancelPending: false }); return true; } catch { set((state) => ({ runtimeCancelPending: false, ...(state.runtimeMode === "cancelling" ? { runtimeMode: "running" } : {}) })); return false; } },
}));
