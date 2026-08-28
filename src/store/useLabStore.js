import { create } from "zustand";
import { skills, watchGroups } from "../data/market.js";
import { defaultMonitorRules, strategyFor } from "../data/monitorStrategies.js";
import { ABORTED_CODE, abortPi, askPi, isDesktopRuntime } from "../lib/piRuntime.js";
import { loadIntegrationStatus } from "../lib/integrations.js";
import { loadUserState, saveUserState } from "../lib/userState.js";

const RUNNING_REPLY = "Pi 正在分析…";
export const MONITOR_INTERVAL_MS = 30_000;
const defaultWatchlist = watchGroups.flatMap((group) => group.items).slice(0, 8).map((item) => ({ ...item }));
let persistenceQueue = Promise.resolve();

function persistSnapshot(snapshot) {
  persistenceQueue = persistenceQueue.catch(() => {}).then(() => saveUserState({ watchlist: snapshot.watchlist, monitorRules: snapshot.rules, notifications: snapshot.notifications }));
  return persistenceQueue;
}
function nowIso() { return new Date().toISOString(); }
function createId(prefix) { return `${prefix}-${typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`}`; }
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
  return { id: String(rule.id ?? createId("rule")), symbol: String(rule.symbol ?? "600519"), strategyId: strategy.id, threshold: Number.isFinite(Number(rule.threshold)) ? Number(rule.threshold) : strategy.defaultThreshold, intervalSeconds: Math.max(15, Math.min(86_400, Number(rule.intervalSeconds) || 300)), enabled: rule.enabled !== false, lastCheckedAt: rule.lastCheckedAt ?? null, lastTriggeredAt: rule.lastTriggeredAt ?? null };
}
function notificationFromResult(rule, item, result, reply) {
  const strategy = strategyFor(rule.strategyId);
  const body = String(result.summary || result.body || reply.text || "检查完成，请打开对话查看完整的来源与审计记录。").trim();
  return { id: createId("notification"), kind: "monitor", title: String(result.title || `${item?.name || rule.symbol} · ${strategy.name}`), body: body.slice(0, 4096), severity: ["info", "warning", "critical"].includes(result.severity) ? result.severity : "info", createdAt: nowIso(), read: false, source: reply.mode === "pi-rpc" ? "qveris" : "browser-demo" };
}
function quoteFromReply(text) {
  const value = findJsonObject(text);
  if (value && Number.isFinite(Number(value.price))) {
    return {
      price: Number(value.price),
      change: Number.isFinite(Number(value.change)) ? Number(value.change) : null,
      asOf: String(value.asOf || ""),
      source: String(value.source || "QVeris"),
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
    source: sourceMatch?.[1]?.trim() || "QVeris",
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
    source: String(value.source ?? value.dataSource ?? "QVeris"),
    open: value.open ?? null,
    previousClose: Number.isFinite(previousClose) ? previousClose : value.previousClose ?? null,
    high: value.high ?? null,
    low: value.low ?? null,
    volume: value.volume ?? null,
    turnover: value.turnover ?? null,
    turnoverRate: value.turnoverRate ?? value.turnover_rate ?? null,
    volumeRatio: value.volumeRatio ?? value.volume_ratio ?? null,
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
  const quote = normalizeLiveQuote(value.quote) || normalizeLiveQuote(value.quotes?.[0]) || normalizeLiveQuote(value);
  const rawSeries = value.seriesByRange || value.series_by_range || {};
  const seriesByRange = Object.fromEntries(Object.entries(rawSeries).filter(([, points]) => Array.isArray(points)));
  if (Array.isArray(value.series) && !seriesByRange["分时"]) seriesByRange["分时"] = value.series;
  const fundamentals = value.fundamentals && typeof value.fundamentals === "object" ? value.fundamentals : {};
  if (!quote && !Object.keys(fundamentals).length && !value.companyDescription && !value.company_description && !Object.keys(seriesByRange).length) return null;
  return {
    quote: { ...(quote || {}), seriesByRange, fundamentals: { ...(quote?.fundamentals || {}), ...fundamentals }, companyDescription: String(value.companyDescription || value.company_description || quote?.companyDescription || "") },
    reportPeriod: String(value.reportPeriod || value.report_period || ""),
  };
}
function seriesFromReply(text) {
  const value = findJsonObject(text);
  const series = Array.isArray(value?.series) ? value.series : Array.isArray(value?.data) ? value.data : findJsonArray(text);
  return series.filter((point) => point && typeof point === "object");
}

function liveQuotesFromReply(text, symbols) {
  const value = findJsonObject(text);
  const items = Array.isArray(value?.quotes) ? value.quotes : Array.isArray(value) ? value : [];
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

export const initialLabState = {
  activeView: "watchlist", selectedSymbol: "600519", chartRange: "分时", watchlist: defaultWatchlist, liveQuotes: {}, skillItems: skills.map((item) => ({ ...item })),
  messages: [{ id: "a1", role: "assistant", text: "选择标的后点击“实时数据”，或直接告诉我需要的市场、指标和时间范围。我会通过 QVeris Search → Inspect → Call 查询，并返回来源与截至时间。", mode: "onboarding", audits: [] }],
  rules: defaultMonitorRules.map(normalizeRule), notifications: [], userStateLoaded: false, integrationStatus: null, integrationStatusLoading: false, integrationStatusError: "", liveDataLoading: false, liveDataError: "", liveDataLastRefreshAt: null, quoteDetailsLoading: {}, quoteDetailsLoaded: {}, quoteDetailsError: {}, quoteSeriesLoading: {}, quoteSeriesLoaded: {}, quoteSeriesError: {}, monitorBusy: false, monitorLastRunAt: null, runtimeMode: "ready", runtimeConfiguring: false, runtimeCancelPending: false, settingsNotice: null,
};

export const useLabStore = create((set, get) => ({
  ...initialLabState,
  hydrateIntegrationStatus: async () => {
    set({ integrationStatusLoading: true, integrationStatusError: "" });
    try { set({ integrationStatus: await loadIntegrationStatus(), integrationStatusLoading: false }); }
    catch (error) { set({ integrationStatus: null, integrationStatusLoading: false, integrationStatusError: error instanceof Error ? error.message : String(error) }); }
  },
  setIntegrationStatus: (integrationStatus) => set({ integrationStatus, integrationStatusLoading: false, integrationStatusError: "" }),
  refreshLiveData: async () => {
    const state = get();
    const configured = Boolean(state.integrationStatus?.credentialConfigured && state.integrationStatus?.settings?.modelId);
    if (!configured || !state.watchlist.length || state.liveDataLoading || state.runtimeConfiguring || state.runtimeCancelPending || state.monitorBusy || state.runtimeMode === "running" || state.runtimeMode === "cancelling") return false;
    set({ liveDataLoading: true, liveDataError: "" });
    const errors = [];
    let received = 0;
    try {
      for (const item of state.watchlist) {
        try {
          const reply = await askPi(`使用内置 qveris-finance-research Skill 查询 ${item.name}（${item.symbol}）A股实时行情快照。只做一次 Search、一次 Inspect、一次 Call，选最匹配的实时行情工具，不要交叉核验，不要第二次搜索。不要使用示例数据。严格只返回一个 JSON 对象，不要 Markdown，格式为 {"quotes":[{"symbol":"${item.symbol}","name":"${item.name}","price":null,"changePercent":null,"changeAmount":null,"open":null,"previousClose":null,"high":null,"low":null,"volume":null,"turnover":null,"turnoverRate":null,"volumeRatio":null,"pe":null,"pb":null,"marketCap":null,"floatMarketCap":null,"asOf":"数据时间","source":"数据来源"}],"errors":[]}。没有真实值的字段填 null。`, { settleTimeoutMs: 60_000 });
          const quotes = liveQuotesFromReply(reply.text, [item.symbol]);
          if (!Object.keys(quotes).length) throw new Error("未返回可识别的真实行情");
          received += 1;
          set((current) => ({ liveQuotes: { ...current.liveQuotes, ...quotes }, liveDataLastRefreshAt: nowIso() }));
        } catch (error) {
          errors.push(`${item.name}：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (!received) throw new Error(errors.join("；") || "QVeris 未返回可识别的真实行情");
      set({ liveDataLoading: false, liveDataError: errors.length ? `部分行情获取失败：${errors.join("；")}` : "" });
      return true;
    } catch (error) {
      set({ liveDataLoading: false, liveDataError: error instanceof Error ? error.message : String(error) });
      return false;
    }
  },
  refreshQuoteDetails: async (symbol) => {
    const state = get();
    const item = state.watchlist.find((entry) => entry.symbol === symbol);
    const configured = Boolean(state.integrationStatus?.credentialConfigured && state.integrationStatus?.settings?.modelId);
    if (!configured || !item || state.liveDataLoading || state.runtimeConfiguring || state.runtimeCancelPending || state.monitorBusy || state.runtimeMode === "running" || state.runtimeMode === "cancelling" || state.quoteDetailsLoading[symbol] || state.quoteDetailsLoaded[symbol]) return false;
    set((current) => ({ quoteDetailsLoading: { ...current.quoteDetailsLoading, [symbol]: true }, quoteDetailsError: { ...current.quoteDetailsError, [symbol]: "" } }));
    try {
      const reply = await askPi(`使用内置 qveris-finance-research Skill 查询 ${item.name}（${item.symbol}）的真实公司简介和最近一期财务指标。允许分别 Search 相关资料，但每个候选工具只能 Inspect 后 Call 一次。不要交叉核验，不要编造。只返回一个 JSON 对象，不要 Markdown：{"fundamentals":{"revenue":null,"netProfit":null,"grossMargin":null,"netMargin":null,"roe":null,"reportPeriod":""},"companyDescription":"","errors":[]}。没有真实数据填 null 或空字符串。`, { settleTimeoutMs: 90_000 });
      const details = detailedQuoteFromReply(reply.text);
      if (!details) throw new Error("QVeris 未返回可识别的行情详情");
      set((current) => ({ liveQuotes: { ...current.liveQuotes, [symbol]: { ...current.liveQuotes[symbol], ...details.quote, reportPeriod: details.reportPeriod } }, quoteDetailsLoading: { ...current.quoteDetailsLoading, [symbol]: false }, quoteDetailsLoaded: { ...current.quoteDetailsLoaded, [symbol]: true }, quoteDetailsError: { ...current.quoteDetailsError, [symbol]: "" } }));
      return true;
    } catch (error) {
      set((current) => ({ quoteDetailsLoading: { ...current.quoteDetailsLoading, [symbol]: false }, quoteDetailsLoaded: { ...current.quoteDetailsLoaded, [symbol]: true }, quoteDetailsError: { ...current.quoteDetailsError, [symbol]: error instanceof Error ? error.message : String(error) } }));
      return false;
    }
  },
  refreshQuoteSeries: async (symbol, range) => {
    const state = get();
    const item = state.watchlist.find((entry) => entry.symbol === symbol);
    const configured = Boolean(state.integrationStatus?.credentialConfigured && state.integrationStatus?.settings?.modelId);
    const seriesBusy = Object.values(state.quoteSeriesLoading[symbol] || {}).some(Boolean);
    if (!configured || !item || !range || state.liveDataLoading || state.quoteDetailsLoading[symbol] || seriesBusy || state.runtimeConfiguring || state.runtimeCancelPending || state.monitorBusy || ["running", "cancelling"].includes(state.runtimeMode) || state.quoteSeriesLoading[symbol]?.[range] || state.quoteSeriesLoaded[symbol]?.[range]) return false;
    set((current) => ({ quoteSeriesLoading: { ...current.quoteSeriesLoading, [symbol]: { ...(current.quoteSeriesLoading[symbol] || {}), [range]: true } }, quoteSeriesError: { ...current.quoteSeriesError, [symbol]: { ...(current.quoteSeriesError[symbol] || {}), [range]: "" } } }));
    const rangeRequest = { 分时: "今天的1分钟或5分钟分时", "5日": "最近5个交易日日线", 日K: "最近90个交易日日线", 周K: "最近52周周线", 月K: "最近60个月月线", 季K: "最近20个季度线", 年K: "最近10年年线" }[range] || range;
    try {
      const reply = await askPi(`使用内置 qveris-finance-research Skill 查询 ${item.name}（${item.symbol}）的${rangeRequest}真实行情。只做一次 Search、一次 Inspect、一次 Call，选最匹配的历史或分时工具，不要交叉核验。只返回一个 JSON 对象，不要 Markdown：{"series":[]}。时间序列点使用 {"time":"ISO或YYYY-MM-DD HH:mm:ss","open":null,"high":null,"low":null,"close":null,"value":null,"volume":null}；没有真实数据返回空数组，禁止编造。`, { settleTimeoutMs: 60_000 });
      const series = seriesFromReply(reply.text);
      set((current) => ({ liveQuotes: { ...current.liveQuotes, [symbol]: { ...current.liveQuotes[symbol], seriesByRange: { ...(current.liveQuotes[symbol]?.seriesByRange || {}), [range]: series } } }, quoteSeriesLoading: { ...current.quoteSeriesLoading, [symbol]: { ...(current.quoteSeriesLoading[symbol] || {}), [range]: false } }, quoteSeriesLoaded: { ...current.quoteSeriesLoaded, [symbol]: { ...(current.quoteSeriesLoaded[symbol] || {}), [range]: true } }, quoteSeriesError: { ...current.quoteSeriesError, [symbol]: { ...(current.quoteSeriesError[symbol] || {}), [range]: "" } } }));
      return true;
    } catch (error) {
      set((current) => ({ quoteSeriesLoading: { ...current.quoteSeriesLoading, [symbol]: { ...(current.quoteSeriesLoading[symbol] || {}), [range]: false } }, quoteSeriesError: { ...current.quoteSeriesError, [symbol]: { ...(current.quoteSeriesError[symbol] || {}), [range]: error instanceof Error ? error.message : String(error) } } }));
      return false;
    }
  },
  setActiveView: (activeView) => set({ activeView }),
  selectSymbol: (selectedSymbol) => set({ selectedSymbol, activeView: "watchlist" }),
  setChartRange: (chartRange) => set({ chartRange }),
  toggleSkill: (id) => set((state) => ({ skillItems: state.skillItems.map((item) => item.id === id ? { ...item, installed: !item.installed } : item) })),
  hydrateUserState: async () => {
    try {
      const persisted = await loadUserState();
      if (persisted && typeof persisted === "object") set((state) => ({ watchlist: Array.isArray(persisted.watchlist) && persisted.watchlist.length ? persisted.watchlist : state.watchlist, rules: Array.isArray(persisted.monitorRules) && persisted.monitorRules.length ? persisted.monitorRules.map(normalizeRule) : state.rules, notifications: Array.isArray(persisted.notifications) ? persisted.notifications : state.notifications, userStateLoaded: true }));
      else { set({ userStateLoaded: true }); void persistSnapshot(get()); }
    } catch (error) { set({ userStateLoaded: true, settingsNotice: { type: "error", text: `本地用户数据加载失败：${error instanceof Error ? error.message : String(error)}` } }); }
  },
  persistUserState: () => persistSnapshot(get()),
  addWatchlist: async (item) => {
    const value = { symbol: String(item?.symbol ?? "").trim().toUpperCase(), name: String(item?.name ?? "").trim(), market: String(item?.market ?? "").trim() || "自定义", category: String(item?.category ?? "").trim() || "自选" };
    if (!value.symbol || !value.name) throw new Error("请输入股票代码和名称");
    if (value.symbol.length > 64 || value.name.length > 128) throw new Error("股票代码或名称过长");
    if (get().watchlist.some((entry) => entry.symbol === value.symbol)) throw new Error("该标的已经在自选中");
    set((state) => ({ watchlist: [...state.watchlist, value], selectedSymbol: value.symbol })); await get().persistUserState(); return value;
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
      const reply = await askPi(`执行一次真实金融盯盘检查。标的：${item?.name || rule.symbol}（${rule.symbol}）。策略：${strategy.name}。阈值：${rule.threshold}${strategy.unit}。${strategy.prompt} 必须使用内置 qveris-finance-research Skill 按 Search → Inspect → Call 查询，不得使用界面示例数据。请严格返回一个 JSON 对象，不要 Markdown：{"triggered":true或false,"title":"简短标题","summary":"含来源和数据截至时间的结论","severity":"info|warning|critical","asOf":"数据截至时间"}。`, { settleTimeoutMs: 120_000 });
      const parsed = findJsonObject(reply.text); const result = parsed || { triggered: reply.mode !== "browser-demo", title: `${item?.name || rule.symbol} · ${strategy.name}`, summary: reply.mode === "browser-demo" ? "浏览器预览未执行真实 QVeris 查询，请在桌面端检查。" : reply.text, severity: "info" };
      set((state) => { const shouldNotify = result.triggered === true || reply.mode === "browser-demo" || !parsed; const notification = shouldNotify ? notificationFromResult(rule, item, result, reply) : null; return { monitorBusy: false, rules: state.rules.map((candidate) => candidate.id === rule.id ? { ...candidate, lastTriggeredAt: result.triggered ? nowIso() : candidate.lastTriggeredAt } : candidate), notifications: notification ? [notification, ...state.notifications].slice(0, 500) : state.notifications }; }); await get().persistUserState(); return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error); set((state) => ({ monitorBusy: false, notifications: [{ id: createId("notification"), kind: "monitor", title: `${item?.name || rule.symbol} · 检查失败`, body: message, severity: "warning", createdAt: nowIso(), read: false, source: "qveris" }, ...state.notifications].slice(0, 500) })); await get().persistUserState(); return false;
    }
  },
  runDueMonitorChecks: async () => { if (!isDesktopRuntime() || !get().userStateLoaded || get().monitorBusy) return false; const now = Date.now(); const due = get().rules.find((rule) => rule.enabled && (!rule.lastCheckedAt || now - Date.parse(rule.lastCheckedAt) >= rule.intervalSeconds * 1000)); return due ? get().runMonitorCheck(due.id) : false; },
  beginRuntimeConfiguration: () => { let acquired = false; set((state) => { if (state.runtimeConfiguring || state.runtimeCancelPending || state.monitorBusy || state.liveDataLoading || ["running", "cancelling"].includes(state.runtimeMode)) return {}; acquired = true; return { runtimeConfiguring: true }; }); return acquired; },
  endRuntimeConfiguration: () => set({ runtimeConfiguring: false }),
  setSettingsNotice: (settingsNotice) => set({ settingsNotice }), clearSettingsNotice: () => set({ settingsNotice: null }),
  sendMessage: async (text) => {
    const prompt = String(text ?? "").trim(); if (!prompt) return false; const userId = createId("message"); const assistantId = createId("message"); let acquired = false;
    set((state) => { if (state.runtimeConfiguring || state.runtimeCancelPending || state.monitorBusy || state.liveDataLoading || ["running", "cancelling"].includes(state.runtimeMode)) return {}; acquired = true; return { runtimeMode: "running", messages: [...state.messages, { id: userId, role: "user", text: prompt }, { id: assistantId, role: "assistant", text: RUNNING_REPLY, mode: "streaming", audits: [], streaming: true }] }; }); if (!acquired) return false;
    try { const reply = await askPi(prompt, { onProgress: ({ text: partialText }) => set((state) => ({ messages: state.messages.map((message) => message.id === assistantId && message.streaming ? { ...message, text: partialText } : message) })) }); const quote = /实时数据|最新行情|最新价格/.test(prompt) ? quoteFromReply(reply.text) : null; set((state) => ({ runtimeMode: reply.mode, liveQuotes: quote ? { ...state.liveQuotes, [state.selectedSymbol]: quote } : state.liveQuotes, messages: state.messages.map((message) => message.id === assistantId ? { ...message, text: reply.text, mode: reply.mode, audits: reply.audits ?? [], streaming: false } : message) })); return true; }
    catch (error) { const cancelled = error?.code === ABORTED_CODE; set((state) => ({ runtimeMode: cancelled ? "cancelled" : "error", messages: state.messages.map((message) => message.id === assistantId ? { ...message, text: cancelled ? "已取消本轮分析。" : `Pi Runtime 暂时不可用：${error instanceof Error ? error.message : String(error)}`, mode: cancelled ? "cancelled" : "error", streaming: false } : message) })); return false; }
  },
  cancelMessage: async () => { let acquired = false; set((state) => { if (state.runtimeMode !== "running" || state.runtimeCancelPending) return {}; acquired = true; return { runtimeMode: "cancelling", runtimeCancelPending: true }; }); if (!acquired) return false; try { await abortPi(); set({ runtimeCancelPending: false }); return true; } catch { set((state) => ({ runtimeCancelPending: false, ...(state.runtimeMode === "cancelling" ? { runtimeMode: "running" } : {}) })); return false; } },
}));
