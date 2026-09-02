export const MONITOR_TRIGGER_MODES = Object.freeze([
  { id: "edge", label: "边沿触发", description: "条件从未满足变为满足时提醒；恢复后可再次提醒" },
  { id: "once", label: "单次触发", description: "第一次触发后自动停用，避免重复检查和重复扣费" },
]);

const TRIGGER_MODE_IDS = new Set(MONITOR_TRIGGER_MODES.map((mode) => mode.id));

export function normalizeMonitorTriggerMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  return TRIGGER_MODE_IDS.has(mode) ? mode : "edge";
}

/**
 * Expiry is persisted as an ISO timestamp. The editor accepts a date-only
 * value, which is interpreted as the end of that UTC calendar day so users
 * do not lose a full day at midnight.
 */
export function normalizeMonitorExpiresAt(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const raw = String(value).trim();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? new Date(`${raw}T23:59:59.999Z`)
    : new Date(raw);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function monitorDateInputValue(value) {
  const normalized = normalizeMonitorExpiresAt(value);
  return normalized ? normalized.slice(0, 10) : "";
}

export function isMonitorRuleExpired(rule, now = Date.now()) {
  const expiry = normalizeMonitorExpiresAt(rule?.expiresAt);
  return Boolean(expiry && Date.parse(expiry) <= now);
}

export function monitorLifecycleLabel(rule, now = Date.now()) {
  if (isMonitorRuleExpired(rule, now)) return "已过期";
  if (normalizeMonitorTriggerMode(rule?.triggerMode) === "once") return "单次触发";
  return "边沿触发";
}

