import { isDesktopRuntime } from "./piRuntime.js";

export const defaultIntegrationSettings = {
  capabilityBaseUrl: "https://qveris.ai/api/v1",
  modelGatewayBaseUrl: "https://aigateway.qveris.ai/v1",
  modelId: "",
  models: [],
};

async function desktopInvoke(command, args) {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(command, args);
}

export async function loadIntegrationStatus() {
  if (!isDesktopRuntime()) return { credentialConfigured: false, settings: defaultIntegrationSettings, demo: true };
  return desktopInvoke("integration_status");
}

export async function saveQVerisCredential(apiKey) {
  if (!isDesktopRuntime()) throw new Error("请在 FolioMind 桌面端配置 QVeris API Key");
  return desktopInvoke("qveris_credential_save", { apiKey });
}

export async function clearQVerisCredential() {
  if (!isDesktopRuntime()) throw new Error("浏览器预览不保存凭证");
  return desktopInvoke("qveris_credential_clear");
}

export async function syncQVerisModels(input) {
  if (!isDesktopRuntime()) throw new Error("模型目录同步仅在桌面端可用");
  return desktopInvoke("qveris_model_catalog_sync", { input });
}

export async function applyIntegrationSettings(input) {
  if (!isDesktopRuntime()) throw new Error("集成设置仅在桌面端保存");
  return desktopInvoke("integration_settings_apply", { input });
}
