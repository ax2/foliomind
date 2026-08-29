import { isDesktopRuntime } from "./piRuntime.js";
import { isLocalWebRuntime, localHostRequest } from "./localHost.js";
import { normalizeConditions } from "./monitorConditions.js";

const STORAGE_KEY = "foliomind.user-state.v1";
export const USER_STATE_BACKUP_VERSION = 1;
const BACKUP_NAME = "FolioMind User Data Backup";

const text = (value, max = 512) => String(value ?? "").trim().slice(0, max);
const finiteNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

function sanitizeWatchlist(items) {
  return (Array.isArray(items) ? items : []).slice(0, 200).map((item) => ({
    symbol: text(item?.symbol, 64).toUpperCase(),
    name: text(item?.name, 128),
    market: text(item?.market, 64),
    category: text(item?.category, 64),
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
    title: text(item?.title, 256),
    body: text(item?.body, 4096),
    severity: ["info", "warning", "critical"].includes(item?.severity) ? item.severity : "info",
    createdAt: text(item?.createdAt, 64),
    read: item?.read === true,
    source: text(item?.source, 64),
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
  })).filter((item) => item.id && item.symbol && item.name && item.quantity !== null && item.averageCost !== null && item.quantity > 0 && item.averageCost >= 0);
}

/** Build a portable backup without credentials, model settings, or runtime state. */
export function userStateBackupData(state = {}) {
  return {
    watchlist: sanitizeWatchlist(state.watchlist),
    monitorRules: sanitizeRules(state.monitorRules ?? state.rules),
    notifications: sanitizeNotifications(state.notifications),
    portfolioPositions: sanitizePositions(state.portfolioPositions),
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
  if (!data.watchlist.length && !data.monitorRules.length && !data.notifications.length && !data.portfolioPositions.length) {
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
