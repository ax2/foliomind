import { isDesktopRuntime } from "./piRuntime.js";
import { isLocalWebRuntime, localHostRequest } from "./localHost.js";
import { normalizeUserState as normalizeState } from "./userStateSchema.js";

const STORAGE_KEY = "foliomind.user-state.v1";
export const USER_STATE_BACKUP_VERSION = 1;
const BACKUP_NAME = "FolioMind User Data Backup";

const text = (value, max = 512) => String(value ?? "").trim().slice(0, max);
/** Normalize the persisted contract before it crosses the desktop/Web boundary. */
export const normalizeUserState = normalizeState;

/** Build a portable backup without credentials, model settings, or runtime state. */
export function userStateBackupData(state = {}) {
  return normalizeUserState(state);
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
  if (!data.watchlist.length && !data.monitorRules.length && !data.notifications.length && !data.portfolioPositions.length && !data.monitorHistory.length && !data.portfolioReviews.length && !data.briefingSchedule.enabled) {
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
  if (isDesktopRuntime()) return normalizeUserState(await desktopInvoke("user_state_load"));
  if (isLocalWebRuntime()) {
    try { return normalizeUserState(await localHostRequest("/api/user-state")); } catch { /* Keep browser preview usable when Host is offline. */ }
  }
  const state = readBrowserState();
  return state ? normalizeUserState(state) : null;
}

export async function saveUserState(state) {
  const normalized = normalizeUserState(state);
  if (isDesktopRuntime()) return desktopInvoke("user_state_save", { state: normalized });
  if (isLocalWebRuntime()) {
    try { return await localHostRequest("/api/user-state", { method: "POST", body: JSON.stringify({ state: normalized }) }); } catch { /* Fall back to browser-only preview state. */ }
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // Browser preview can run with storage disabled; state remains available for this session.
  }
  return normalized;
}
