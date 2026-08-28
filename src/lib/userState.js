import { isDesktopRuntime } from "./piRuntime.js";
import { isLocalWebRuntime, localHostRequest } from "./localHost.js";

const STORAGE_KEY = "foliomind.user-state.v1";

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
