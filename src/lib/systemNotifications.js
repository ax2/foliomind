import { isDesktopRuntime } from "./piRuntime.js";
import { isLocalWebRuntime } from "./localHost.js";

const PREFERENCE_KEY = "foliomind.system-notifications.v1";
const MODE_PREFERENCE_KEY = "foliomind.system-notification-mode.v1";
const MAX_TITLE_LENGTH = 120;
const MAX_BODY_LENGTH = 320;
export const SYSTEM_NOTIFICATION_MODES = Object.freeze({
  ALL: "all",
  CRITICAL: "critical",
});

function readPreference() {
  if (typeof window === "undefined") return false;
  try { return window.localStorage.getItem(PREFERENCE_KEY) === "enabled"; } catch { return false; }
}

export function systemNotificationsEnabled() {
  return readPreference();
}

export function setSystemNotificationsEnabled(enabled) {
  if (typeof window === "undefined") return;
  try {
    if (enabled) window.localStorage.setItem(PREFERENCE_KEY, "enabled");
    else window.localStorage.removeItem(PREFERENCE_KEY);
  } catch {
    // A disabled browser storage should not prevent in-session notifications.
  }
}

export function systemNotificationMode() {
  if (typeof window === "undefined") return SYSTEM_NOTIFICATION_MODES.ALL;
  try {
    const value = window.localStorage.getItem(MODE_PREFERENCE_KEY);
    return Object.values(SYSTEM_NOTIFICATION_MODES).includes(value) ? value : SYSTEM_NOTIFICATION_MODES.ALL;
  } catch { return SYSTEM_NOTIFICATION_MODES.ALL; }
}

export function setSystemNotificationMode(mode) {
  const normalized = Object.values(SYSTEM_NOTIFICATION_MODES).includes(mode) ? mode : SYSTEM_NOTIFICATION_MODES.ALL;
  if (typeof window === "undefined") return normalized;
  try { window.localStorage.setItem(MODE_PREFERENCE_KEY, normalized); } catch {
    // A disabled browser storage should not prevent in-session preferences.
  }
  return normalized;
}

export function shouldSendSystemNotification(notification) {
  if (!systemNotificationsEnabled()) return false;
  if (systemNotificationMode() !== SYSTEM_NOTIFICATION_MODES.CRITICAL) return true;
  return notification?.severity === "critical";
}

function notificationText(value, fallback, maxLength) {
  const text = String(value ?? fallback).trim();
  return (text || fallback).slice(0, maxLength);
}

export async function requestSystemNotificationPermission() {
  if (isDesktopRuntime()) {
    try {
      const api = await import("@tauri-apps/plugin-notification");
      let granted = await api.isPermissionGranted();
      if (!granted) granted = (await api.requestPermission()) === "granted";
      return granted;
    } catch {
      return false;
    }
  }
  if (!isLocalWebRuntime() || typeof window === "undefined" || !("Notification" in window)) return false;
  if (window.Notification.permission === "granted") return true;
  try { return (await window.Notification.requestPermission()) === "granted"; } catch { return false; }
}

export async function sendSystemNotification(notification) {
  if (!shouldSendSystemNotification(notification)) return false;
  const title = notificationText(notification?.title, "FolioMind 盯盘提醒", MAX_TITLE_LENGTH);
  const body = notificationText(notification?.body, "有新的真实数据提醒，请打开 FolioMind 查看。", MAX_BODY_LENGTH);
  if (isDesktopRuntime()) {
    try {
      const api = await import("@tauri-apps/plugin-notification");
      if (!(await api.isPermissionGranted())) return false;
      api.sendNotification({ title, body });
      return true;
    } catch {
      return false;
    }
  }
  if (!isLocalWebRuntime() || typeof window === "undefined" || !("Notification" in window) || window.Notification.permission !== "granted") return false;
  try {
    new window.Notification(title, { body, tag: `foliomind-${notification?.id || "alert"}` });
    return true;
  } catch {
    return false;
  }
}
