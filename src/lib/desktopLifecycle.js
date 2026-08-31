import { isDesktopRuntime } from "./piRuntime.js";

async function invokeDesktop(command) {
  if (!isDesktopRuntime()) throw new Error("该功能仅在桌面版可用");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(command);
}

export const loadDesktopLifecycleStatus = () => invokeDesktop("desktop_lifecycle_status");
export const showDesktopWindow = () => invokeDesktop("desktop_window_show");
export const reconcileDesktopNow = () => invokeDesktop("desktop_reconcile_now");
export const quitDesktop = () => invokeDesktop("desktop_quit");

export async function listenForDesktopReconcile(handler) {
  if (!isDesktopRuntime()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen("foliomind://background-reconcile", () => handler());
}
