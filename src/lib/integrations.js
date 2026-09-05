import { isDesktopRuntime } from "./piRuntime.js";
import { isLocalWebRuntime, localHostRequest } from "./localHost.js";
import { publishIntegrationChange } from "./integrationChanges.js";

export const defaultIntegrationSettings = {
  capabilityBaseUrl: "https://qveris.ai/api/v1",
  modelGatewayBaseUrl: "https://aigateway.qveris.ai/v1",
  modelId: "",
  models: [],
  dataChannel: "qveris-cap",
  dataProvider: "qveris_finance",
};

export const DATA_CHANNEL_OPTIONS = Object.freeze([
  { id: "qveris-cap", label: "QVeris CAP（默认）", description: "使用内置金融能力目录与稳定 tool schema" },
  { id: "cap-compatible", label: "兼容 CAP 网关", description: "使用相同 tool schema；将来可切换到其他数据渠道" },
]);

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
    // Do not turn a real Local Host outage into a fake/demo status. The
    // settings page and store can then show a recoverable connection error and
    // offer a retry instead of telling the user to re-enter a valid key.
    return { ...(await localHostRequest("/api/integration/status")), demo: false, environment: "local-host" };
  }
  return desktopInvoke("integration_status");
}

export async function saveQVerisCredential(apiKey) {
  if (!isDesktopRuntime()) {
    if (!isLocalWebRuntime()) throw new Error("请在 localhost 本地调试页面配置 QVeris API Key");
    await localHostRequest("/api/integration/credential", { method: "POST", body: JSON.stringify({ apiKey }) });
    publishIntegrationChange();
    return true;
  }
  const result = await desktopInvoke("qveris_credential_save", { apiKey });
  publishIntegrationChange();
  return result;
}

export async function clearQVerisCredential() {
  if (!isDesktopRuntime()) {
    if (!isLocalWebRuntime()) throw new Error("浏览器预览不保存凭证");
    await localHostRequest("/api/integration/credential", { method: "DELETE" });
    publishIntegrationChange();
    return true;
  }
  const result = await desktopInvoke("qveris_credential_clear");
  publishIntegrationChange();
  return result;
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

/**
 * Run a minimal model-gateway probe. This intentionally bypasses Pi and the
 * finance tool registry: the Host sends a request with tool_choice=none so a
 * connectivity check can never trigger a billable data lookup.
 */
export async function testModelConnection() {
  if (isDesktopRuntime()) return desktopInvoke("qveris_model_connection_test");
  if (!isLocalWebRuntime()) throw new Error("模型连接测试仅在桌面端或 localhost 调试环境可用");
  return localHostRequest("/api/integration/model/test", { method: "POST", timeoutMs: 40_000 });
}

export async function queryTradingCalendar(date, marketcode = "212001", options = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) throw new Error("交易日历日期无效");
  if (isDesktopRuntime()) return desktopInvoke("qveris_trading_calendar", { date, marketcode });
  if (!isLocalWebRuntime()) throw new Error("交易日历仅在桌面端或 localhost 调试环境可用");
  const result = await localHostRequest("/api/data/query", { ...options, method: "POST", timeoutMs: options.timeoutMs ?? 30_000, body: JSON.stringify({ input: { kind: "trading_calendar", date, marketcode } }) });
  return result?.data || result;
}

/**
 * Execute a fixed CAP contract without involving the model runtime. Local
 * Web uses the authenticated Host; desktop uses the native Tauri Host.
 */
export async function queryCapabilityData(input, options = {}) {
  if (isDesktopRuntime()) return desktopInvoke("qveris_data_query", { input });
  if (!isLocalWebRuntime()) throw new Error("真实金融数据仅在桌面端或 localhost 调试环境可用");
  return localHostRequest("/api/data/query", { ...options, method: "POST", body: JSON.stringify({ input }) });
}
