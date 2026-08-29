import { isDesktopRuntime } from "./piRuntime.js";
import { isLocalWebRuntime, localHostRequest } from "./localHost.js";

export const defaultIntegrationSettings = {
  capabilityBaseUrl: "https://qveris.ai/api/v1",
  modelGatewayBaseUrl: "https://aigateway.qveris.ai/v1",
  modelId: "",
  models: [],
  dataChannel: "qveris-cap",
  dataProvider: "qveris_finance",
};

export function apiKeyPrefix(value) {
  const key = String(value || "").trim();
  if (!key) return "";
  return `${key.slice(0, 8)}${key.length > 8 ? "…" : ""}`;
}

async function desktopInvoke(command, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(command, args);
}

export async function loadIntegrationStatus() {
  if (!isDesktopRuntime() && !isLocalWebRuntime()) return { credentialConfigured: false, settings: defaultIntegrationSettings, demo: true };
  if (!isDesktopRuntime()) {
    try { return { ...(await localHostRequest("/api/integration/status")), demo: false, environment: "local-host" }; } catch { return { credentialConfigured: false, settings: defaultIntegrationSettings, demo: true }; }
  }
  return desktopInvoke("integration_status");
}

export async function saveQVerisCredential(apiKey) {
  if (!isDesktopRuntime()) {
    if (!isLocalWebRuntime()) throw new Error("请在 localhost 本地调试页面配置 QVeris API Key");
    await localHostRequest("/api/integration/credential", { method: "POST", body: JSON.stringify({ apiKey }) });
    return true;
  }
  return desktopInvoke("qveris_credential_save", { apiKey });
}

export async function clearQVerisCredential() {
  if (!isDesktopRuntime()) {
    if (!isLocalWebRuntime()) throw new Error("浏览器预览不保存凭证");
    await localHostRequest("/api/integration/credential", { method: "DELETE" });
    return true;
  }
  return desktopInvoke("qveris_credential_clear");
}

export async function syncQVerisModels(input) {
  if (!isDesktopRuntime()) {
    if (!isLocalWebRuntime()) throw new Error("模型目录同步仅在 localhost 本地调试 Host 可用");
    return localHostRequest("/api/integration/models/sync", { method: "POST", body: JSON.stringify({ input }) });
  }
  return desktopInvoke("qveris_model_catalog_sync", { input });
}

export async function applyIntegrationSettings(input) {
  if (!isDesktopRuntime()) {
    if (!isLocalWebRuntime()) throw new Error("集成设置仅在 localhost 本地调试 Host 可用");
    return localHostRequest("/api/integration/settings", { method: "POST", body: JSON.stringify({ input }) });
  }
  return desktopInvoke("integration_settings_apply", { input });
}
