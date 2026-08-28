import { create } from "zustand";
import { skills, watchGroups } from "../data/market.js";
import { defaultMonitorRules, strategyFor } from "../data/monitorStrategies.js";
import { ABORTED_CODE, abortPi, askPi, isDesktopRuntime } from "../lib/piRuntime.js";
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
  for (let end = source.lastIndexOf("}"); end >= 0; end -= 1) {
    const start = source.lastIndexOf("{", end);
    if (start < 0) break;
    try { const value = JSON.parse(source.slice(start, end + 1)); if (value && typeof value === "object") return value; } catch { /* Try the next boundary. */ }
  }
  return null;
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
  if (!value || !Number.isFinite(Number(value.price))) return null;
  return { price: Number(value.price), change: Number.isFinite(Number(value.change)) ? Number(value.change) : null, asOf: String(value.asOf || ""), source: String(value.source || "QVeris") };
}

export const initialLabState = {
  activeView: "watchlist", selectedSymbol: "600519", chartRange: "分时", watchlist: defaultWatchlist, liveQuotes: {}, skillItems: skills.map((item) => ({ ...item })),
  messages: [{ id: "a1", role: "assistant", text: "选择标的后点击“实时数据”，或直接告诉我需要的市场、指标和时间范围。我会通过 QVeris Search → Inspect → Call 查询，并返回来源与截至时间。", mode: "onboarding", audits: [] }],
  rules: defaultMonitorRules.map(normalizeRule), notifications: [], userStateLoaded: false, monitorBusy: false, monitorLastRunAt: null, runtimeMode: "ready", runtimeConfiguring: false, runtimeCancelPending: false, settingsNotice: null,
};

export const useLabStore = create((set, get) => ({
  ...initialLabState,
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
    set((state) => { rule = state.rules.find((candidate) => candidate.id === ruleId); item = state.watchlist.find((candidate) => candidate.symbol === rule?.symbol); if (!rule || !rule.enabled || state.monitorBusy || state.runtimeConfiguring || state.runtimeCancelPending || ["running", "cancelling"].includes(state.runtimeMode)) return {}; acquired = true; const checkedAt = nowIso(); return { monitorBusy: true, monitorLastRunAt: checkedAt, rules: state.rules.map((candidate) => candidate.id === rule.id ? { ...candidate, lastCheckedAt: checkedAt } : candidate) }; });
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
  beginRuntimeConfiguration: () => { let acquired = false; set((state) => { if (state.runtimeConfiguring || state.runtimeCancelPending || state.monitorBusy || ["running", "cancelling"].includes(state.runtimeMode)) return {}; acquired = true; return { runtimeConfiguring: true }; }); return acquired; },
  endRuntimeConfiguration: () => set({ runtimeConfiguring: false }),
  setSettingsNotice: (settingsNotice) => set({ settingsNotice }), clearSettingsNotice: () => set({ settingsNotice: null }),
  sendMessage: async (text) => {
    const prompt = String(text ?? "").trim(); if (!prompt) return false; const userId = createId("message"); const assistantId = createId("message"); let acquired = false;
    set((state) => { if (state.runtimeConfiguring || state.runtimeCancelPending || state.monitorBusy || ["running", "cancelling"].includes(state.runtimeMode)) return {}; acquired = true; return { runtimeMode: "running", messages: [...state.messages, { id: userId, role: "user", text: prompt }, { id: assistantId, role: "assistant", text: RUNNING_REPLY, mode: "streaming", audits: [], streaming: true }] }; }); if (!acquired) return false;
    try { const reply = await askPi(prompt, { onProgress: ({ text: partialText }) => set((state) => ({ messages: state.messages.map((message) => message.id === assistantId && message.streaming ? { ...message, text: partialText } : message) })) }); const quote = /实时数据|最新行情|最新价格/.test(prompt) ? quoteFromReply(reply.text) : null; set((state) => ({ runtimeMode: reply.mode, liveQuotes: quote ? { ...state.liveQuotes, [state.selectedSymbol]: quote } : state.liveQuotes, messages: state.messages.map((message) => message.id === assistantId ? { ...message, text: reply.text, mode: reply.mode, audits: reply.audits ?? [], streaming: false } : message) })); return true; }
    catch (error) { const cancelled = error?.code === ABORTED_CODE; set((state) => ({ runtimeMode: cancelled ? "cancelled" : "error", messages: state.messages.map((message) => message.id === assistantId ? { ...message, text: cancelled ? "已取消本轮分析。" : `Pi Runtime 暂时不可用：${error instanceof Error ? error.message : String(error)}`, mode: cancelled ? "cancelled" : "error", streaming: false } : message) })); return false; }
  },
  cancelMessage: async () => { let acquired = false; set((state) => { if (state.runtimeMode !== "running" || state.runtimeCancelPending) return {}; acquired = true; return { runtimeMode: "cancelling", runtimeCancelPending: true }; }); if (!acquired) return false; try { await abortPi(); set({ runtimeCancelPending: false }); return true; } catch { set((state) => ({ runtimeCancelPending: false, ...(state.runtimeMode === "cancelling" ? { runtimeMode: "running" } : {}) })); return false; } },
}));
