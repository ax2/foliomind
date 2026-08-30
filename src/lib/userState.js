import { isDesktopRuntime } from "./piRuntime.js";
import { isLocalWebRuntime, localHostRequest } from "./localHost.js";
import { normalizeConditions } from "./monitorConditions.js";
import { normalizeWatchlistItem } from "./watchlist.js";

const STORAGE_KEY = "foliomind.user-state.v1";
export const USER_STATE_BACKUP_VERSION = 1;
const BACKUP_NAME = "FolioMind User Data Backup";

const text = (value, max = 512) => String(value ?? "").trim().slice(0, max);
const finiteNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const PLAN_HORIZONS = new Set(["short", "swing", "medium", "long"]);
const PLAN_STATUSES = new Set(["none", "active", "executed", "archived"]);

function sanitizeWatchlist(items) {
  return (Array.isArray(items) ? items : []).slice(0, 200).map((item) => normalizeWatchlistItem({
    symbol: text(item?.symbol, 64),
    name: text(item?.name, 128),
    market: text(item?.market, 64),
    category: text(item?.category, 64),
    group: text(item?.group ?? item?.groupId, 64),
  })).filter((item) => item.symbol && item.name);
}

function sanitizeRules(items) {
  return (Array.isArray(items) ? items : []).slice(0, 500).map((rule) => ({
    id: text(rule?.id, 128),
    symbol: text(rule?.symbol, 64).toUpperCase(),
    strategyId: text(rule?.strategyId, 64),
    threshold: finiteNumber(rule?.threshold),
    conditions: normalizeConditions(rule?.conditions, text(rule?.strategyId, 64)),
    logic: String(rule?.logic || "AND").toUpperCase() === "OR" ? "OR" : "AND",
    intervalSeconds: finiteNumber(rule?.intervalSeconds),
    enabled: rule?.enabled !== false,
    lastCheckedAt: rule?.lastCheckedAt ? text(rule.lastCheckedAt, 64) : null,
    lastTriggeredAt: rule?.lastTriggeredAt ? text(rule.lastTriggeredAt, 64) : null,
    lastSignalTriggered: typeof rule?.lastSignalTriggered === "boolean" ? rule.lastSignalTriggered : null,
  })).filter((rule) => rule.id && rule.symbol && rule.strategyId && rule.threshold !== null && rule.intervalSeconds !== null);
}

function sanitizeNotifications(items) {
  return (Array.isArray(items) ? items : []).slice(0, 500).map((item) => ({
    id: text(item?.id, 128),
    kind: text(item?.kind, 32),
    symbol: text(item?.symbol, 64).toUpperCase(),
    name: text(item?.name, 128),
    ruleId: text(item?.ruleId, 128),
    title: text(item?.title, 256),
    body: text(item?.body, 4096),
    severity: ["info", "warning", "critical"].includes(item?.severity) ? item.severity : "info",
    createdAt: text(item?.createdAt, 64),
    read: item?.read === true,
    source: text(item?.source, 64),
    eventKey: text(item?.eventKey ?? item?.event_key, 512),
    reminderPhase: text(item?.reminderPhase ?? item?.reminder_phase, 32),
  })).filter((item) => item.id && item.title);
}

function sanitizePositions(items) {
  return (Array.isArray(items) ? items : []).slice(0, 500).map((item) => ({
    id: text(item?.id, 128),
    symbol: text(item?.symbol, 64).toUpperCase(),
    name: text(item?.name, 128),
    market: text(item?.market, 64),
    quantity: finiteNumber(item?.quantity),
    averageCost: finiteNumber(item?.averageCost),
    takeProfitPrice: finiteNumber(item?.takeProfitPrice ?? item?.take_profit_price),
    stopLossPrice: finiteNumber(item?.stopLossPrice ?? item?.stop_loss_price),
    takeProfitTriggered: item?.takeProfitTriggered === true,
    stopLossTriggered: item?.stopLossTriggered === true,
    planThesis: text(item?.planThesis ?? item?.plan_thesis, 2_000),
    planHorizon: PLAN_HORIZONS.has(String(item?.planHorizon ?? item?.plan_horizon ?? "")) ? String(item?.planHorizon ?? item?.plan_horizon) : null,
    planStatus: PLAN_STATUSES.has(String(item?.planStatus ?? item?.plan_status ?? "")) ? String(item?.planStatus ?? item?.plan_status) : null,
    planCreatedAt: item?.planCreatedAt ? text(item.planCreatedAt, 64) : null,
    planUpdatedAt: item?.planUpdatedAt ? text(item.planUpdatedAt, 64) : null,
    planActions: (Array.isArray(item?.planActions ?? item?.plan_actions) ? (item.planActions ?? item.plan_actions) : []).slice(0, 20).map((action) => ({
      id: text(action?.id, 128),
      type: text(action?.type, 32),
      at: text(action?.at, 64),
      note: text(action?.note, 512),
    })).filter((action) => action.id && action.type && action.at),
  })).filter((item) => item.id && item.symbol && item.name && item.quantity !== null && item.averageCost !== null && item.quantity > 0 && item.averageCost >= 0);
}

function sanitizeMonitorHistory(items) {
  return (Array.isArray(items) ? items : []).slice(0, 500).map((item) => ({
    id: text(item?.id, 128),
    ruleId: text(item?.ruleId, 128),
    symbol: text(item?.symbol, 64).toUpperCase(),
    checkedAt: text(item?.checkedAt, 64),
    outcome: ["triggered", "not_triggered", "unknown", "error"].includes(item?.outcome) ? item.outcome : "unknown",
    triggered: typeof item?.triggered === "boolean" ? item.triggered : null,
    title: text(item?.title, 256),
    summary: text(item?.summary, 4096),
    severity: ["info", "warning", "critical"].includes(item?.severity) ? item.severity : "info",
    source: text(item?.source, 64),
    asOf: text(item?.asOf, 128),
    conditionResults: Array.isArray(item?.conditionResults) ? item.conditionResults.slice(0, 6).map((value) => typeof value === "boolean" ? value : null) : [],
    audits: Array.isArray(item?.audits) ? item.audits.slice(0, 12).map((audit) => ({
      operation: text(audit?.operation, 64),
      outcome: text(audit?.outcome, 64),
      toolId: text(audit?.toolId ?? audit?.tool_id, 160),
      capability: text(audit?.capability, 128),
    })).filter((audit) => audit.operation || audit.outcome || audit.toolId || audit.capability) : [],
  })).filter((item) => item.id && item.ruleId && item.symbol && item.checkedAt);
}

/** Build a portable backup without credentials, model settings, or runtime state. */
export function userStateBackupData(state = {}) {
  return {
    watchlist: sanitizeWatchlist(state.watchlist),
    monitorRules: sanitizeRules(state.monitorRules ?? state.rules),
    notifications: sanitizeNotifications(state.notifications),
    portfolioPositions: sanitizePositions(state.portfolioPositions),
    monitorHistory: sanitizeMonitorHistory(state.monitorHistory),
  };
}

export function serializeUserStateBackup(state = {}, exportedAt = new Date().toISOString()) {
  return JSON.stringify({ name: BACKUP_NAME, version: USER_STATE_BACKUP_VERSION, exportedAt: text(exportedAt, 64), data: userStateBackupData(state) }, null, 2);
}

export function parseUserStateBackup(raw) {
  let value;
  try { value = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { throw new Error("备份文件不是有效的 JSON"); }
  if (!value || typeof value !== "object" || value.name !== BACKUP_NAME || value.version !== USER_STATE_BACKUP_VERSION || !value.data || typeof value.data !== "object") {
    throw new Error("备份文件版本不受支持");
  }
  const data = userStateBackupData(value.data);
  if (!data.watchlist.length && !data.monitorRules.length && !data.notifications.length && !data.portfolioPositions.length && !data.monitorHistory.length) {
    throw new Error("备份文件中没有可恢复的数据");
  }
  return data;
}

async function desktopInvoke(command, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(command, args);
}

function readBrowserState() {
  try {
    const value = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null");
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

export async function loadUserState() {
  if (isDesktopRuntime()) return desktopInvoke("user_state_load");
  if (isLocalWebRuntime()) {
    try { return await localHostRequest("/api/user-state"); } catch { /* Keep browser preview usable when Host is offline. */ }
  }
  return readBrowserState();
}

export async function saveUserState(state) {
  if (isDesktopRuntime()) return desktopInvoke("user_state_save", { state });
  if (isLocalWebRuntime()) {
    try { return await localHostRequest("/api/user-state", { method: "POST", body: JSON.stringify({ state }) }); } catch { /* Fall back to browser-only preview state. */ }
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Browser preview can run with storage disabled; state remains available for this session.
  }
  return state;
}
