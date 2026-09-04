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
  const { revision: _revision, ...portable } = normalizeUserState(state);
  return portable;
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
  const rawInstalledSkillIds = value.data.installedSkillIds ?? value.data.installedSkills;
  const hasInstalledSkills = Array.isArray(rawInstalledSkillIds) && data.installedSkillIds.length > 0;
  if (!data.watchlist.length && !data.monitorRules.length && !data.notifications.length && !data.portfolioPositions.length && !data.monitorHistory.length && !data.portfolioReviews.length && !data.premarketBriefing && !hasInstalledSkills && !data.briefingSchedule.enabled && !data.briefingSchedule.premarketEnabled) {
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
    // Local Web is a debugging view of the Host, not a second browser-only
    // data store. Falling back to localStorage while the Host is offline can
    // show stale state and later overwrite the canonical Host state.
    return normalizeUserState(await localHostRequest("/api/user-state"));
  }
  const state = readBrowserState();
  return state ? normalizeUserState(state) : null;
}

const collectionKeys = Object.freeze({ watchlist: "symbol", monitorRules: "id", notifications: "id", portfolioPositions: "id", monitorHistory: "id", portfolioReviews: "id" });
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export class UserStateMergeConflictError extends Error {
  constructor(conflicts) {
    super("用户数据同时在其他窗口发生了冲突修改，请重新加载后再操作");
    this.name = "UserStateMergeConflictError";
    this.code = "USER_STATE_MERGE_CONFLICT";
    this.conflicts = conflicts;
  }
}

function mergeCollection(baseItems, localItems, remoteItems, key, field, conflicts) {
  const base = new Map(baseItems.map((item) => [item?.[key], item]).filter(([id]) => id));
  const local = new Map(localItems.map((item) => [item?.[key], item]).filter(([id]) => id));
  const merged = new Map(remoteItems.map((item) => [item?.[key], item]).filter(([id]) => id));
  const remote = new Map(merged);
  for (const [id, baseItem] of base) {
    const localItem = local.get(id);
    const remoteItem = remote.get(id);
    const localChanged = !same(localItem, baseItem);
    const remoteChanged = !same(remoteItem, baseItem);
    if (localChanged && remoteChanged && !same(localItem, remoteItem)) conflicts.push(`${field}.${id}`);
    if (!localItem && !remoteChanged) merged.delete(id);
  }
  for (const [id, item] of local) {
    const baseItem = base.get(id);
    const remoteItem = remote.get(id);
    const localChanged = !same(item, baseItem);
    const remoteChanged = !same(remoteItem, baseItem);
    if (localChanged && !remoteChanged) merged.set(id, item);
    else if (!baseItem && !remoteItem) merged.set(id, item);
  }
  const baseOrder = [...base.keys()];
  const localOrder = [...local.keys()];
  const orderChanged = !same(baseOrder, localOrder);
  const preferred = orderChanged ? localOrder : remoteItems.map((item) => item?.[key]).filter(Boolean);
  const ordered = preferred.map((id) => merged.get(id)).filter(Boolean);
  const included = new Set(preferred);
  for (const [id, item] of merged) if (!included.has(id)) ordered.push(item);
  return ordered;
}

function mergeObject(base, local, remote, field, conflicts) {
  if (!local || typeof local !== "object" || Array.isArray(local) || !remote || typeof remote !== "object" || Array.isArray(remote)) {
    const localChanged = !same(local, base);
    const remoteChanged = !same(remote, base);
    if (localChanged && remoteChanged && !same(local, remote)) conflicts.push(field);
    return localChanged && !remoteChanged ? local : remote;
  }
  const merged = { ...remote };
  for (const [key, value] of Object.entries(local)) {
    const localChanged = !same(value, base?.[key]);
    const remoteChanged = !same(remote?.[key], base?.[key]);
    if (localChanged && remoteChanged && !same(value, remote?.[key])) conflicts.push(`${field}.${key}`);
    else if (localChanged) merged[key] = value;
  }
  return merged;
}

function mergeInstalledSkillIds(baseValues, localValues, remoteValues, conflicts) {
  const base = new Set(baseValues);
  const local = new Set(localValues);
  const remote = new Set(remoteValues);
  const order = [...new Set([...localValues, ...remoteValues, ...baseValues])];
  const merged = [];
  for (const id of order) {
    const localHas = local.has(id);
    const remoteHas = remote.has(id);
    const baseHas = base.has(id);
    const localChanged = localHas !== baseHas;
    const remoteChanged = remoteHas !== baseHas;
    if (localChanged && remoteChanged && localHas !== remoteHas) conflicts.push(`installedSkillIds.${id}`);
    const finalHas = localChanged ? localHas : remoteHas;
    if (finalHas) merged.push(id);
  }
  return merged;
}

export function mergeUserStateChanges(baseState, localState, remoteState) {
  const base = normalizeUserState(baseState);
  const local = normalizeUserState(localState);
  const remote = normalizeUserState(remoteState);
  const merged = { ...remote, revision: remote.revision };
  const conflicts = [];
  for (const [field, key] of Object.entries(collectionKeys)) merged[field] = mergeCollection(base[field], local[field], remote[field], key, field, conflicts);
  merged.briefingSchedule = mergeObject(base.briefingSchedule, local.briefingSchedule, remote.briefingSchedule, "briefingSchedule", conflicts);
  merged.premarketBriefing = mergeObject(base.premarketBriefing, local.premarketBriefing, remote.premarketBriefing, "premarketBriefing", conflicts);
  merged.installedSkillIds = mergeInstalledSkillIds(base.installedSkillIds, local.installedSkillIds, remote.installedSkillIds, conflicts);
  if (conflicts.length) throw new UserStateMergeConflictError(conflicts);
  return normalizeUserState(merged);
}

function isConflict(error) {
  return error?.code === "USER_STATE_CONFLICT" || String(error?.message || error).includes("USER_STATE_CONFLICT");
}

async function saveOnce(normalized) {
  const expectedRevision = normalized.revision;
  if (isDesktopRuntime()) return normalizeUserState(await desktopInvoke("user_state_save", { state: normalized, expectedRevision }));
  if (isLocalWebRuntime()) return normalizeUserState(await localHostRequest("/api/user-state", { method: "POST", body: JSON.stringify({ state: normalized, expectedRevision }) }));
  try {
    const next = { ...normalized, revision: expectedRevision + 1 };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    return next;
  } catch {
    return { ...normalized, revision: expectedRevision + 1 };
  }
}

export async function saveUserState(state, { baseState = state } = {}) {
  const normalized = normalizeUserState(state);
  try {
    return await saveOnce(normalized);
  } catch (error) {
    if (!isConflict(error)) throw error;
    const remote = await loadUserState();
    if (!remote) throw error;
    return saveOnce(mergeUserStateChanges(baseState, normalized, remote));
  }
}
