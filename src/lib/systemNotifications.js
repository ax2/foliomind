import { isDesktopRuntime } from "./piRuntime.js";
import { isLocalWebRuntime } from "./localHost.js";

const PREFERENCE_KEY = "foliomind.system-notifications.v1";
const MAX_TITLE_LENGTH = 120;
const MAX_BODY_LENGTH = 320;

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
  if (!systemNotificationsEnabled()) return false;
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
