import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
const localHost = vi.hoisted(() => ({ isLocalWebRuntime: vi.fn(() => false), localHostRequest: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("./localHost.js", () => localHost);

import { applyIntegrationSettings, DATA_CHANNEL_OPTIONS, defaultIntegrationSettings, loadIntegrationStatus, queryCapabilityData, queryTradingCalendar, syncQVerisModels, testModelConnection } from "./integrations.js";

describe("integration client", () => {
  beforeEach(() => {
    window.__TAURI_INTERNALS__ = {};
    tauri.invoke.mockReset();
    localHost.isLocalWebRuntime.mockReset().mockReturnValue(false);
    localHost.localHostRequest.mockReset();
  });

  it("exposes a stable default CAP channel and a future-compatible option", () => {
    expect(defaultIntegrationSettings.dataChannel).toBe("qveris-cap");
    expect(DATA_CHANNEL_OPTIONS.map((item) => item.id)).toEqual(["qveris-cap", "cap-compatible"]);
  });

  afterEach(() => {
    delete window.__TAURI_INTERNALS__;
  });

  it("syncs a model catalog and endpoint settings as one request", async () => {
    const input = {
      capabilityBaseUrl: "https://qveris.ai/api/v1",
      modelGatewayBaseUrl: "https://gateway.example.com/v1",
      modelId: "retired-model",
      models: [{ id: "retired-model" }],
    };
    tauri.invoke.mockResolvedValue({ ...input, modelId: "model-a", models: [{ id: "model-a" }] });

    await expect(syncQVerisModels(input)).resolves.toMatchObject({ modelId: "model-a" });
    expect(tauri.invoke).toHaveBeenCalledWith("qveris_model_catalog_sync", { input });
  });

  it("applies settings and restarts the Runtime in one Host transaction", async () => {
    const input = {
      capabilityBaseUrl: "https://qveris.ai/api/v1",
      modelGatewayBaseUrl: "https://gateway.example.com/v1",
      modelId: "model-a",
    };
    tauri.invoke.mockResolvedValue({ ...input, models: [{ id: "model-a" }] });

    await expect(applyIntegrationSettings(input)).resolves.toMatchObject({ modelId: "model-a" });
    expect(tauri.invoke).toHaveBeenCalledTimes(1);
    expect(tauri.invoke).toHaveBeenCalledWith("integration_settings_apply", { input });
  });

  it("queries the desktop trading calendar without exposing the credential", async () => {
    tauri.invoke.mockResolvedValue({ queriedDate: "2026-08-31", isTradingDay: true, source: "cn_financial_pro" });
    await expect(queryTradingCalendar("2026-08-31")).resolves.toMatchObject({ isTradingDay: true });
    expect(tauri.invoke).toHaveBeenCalledWith("qveris_trading_calendar", { date: "2026-08-31", marketcode: "212001" });
  });

  it("forwards a local trading-calendar cancellation signal", async () => {
    delete window.__TAURI_INTERNALS__;
    localHost.isLocalWebRuntime.mockReturnValue(true);
    localHost.localHostRequest.mockResolvedValue({ data: { isTradingDay: true } });
    const controller = new AbortController();
    await expect(queryTradingCalendar("2026-08-31", "212001", { signal: controller.signal, timeoutMs: 12_000 })).resolves.toMatchObject({ isTradingDay: true });
    expect(localHost.localHostRequest).toHaveBeenCalledWith("/api/data/query", expect.objectContaining({ signal: controller.signal, timeoutMs: 12_000, method: "POST" }));
  });

  it("queries fixed CAP data through the native Host", async () => {
    const input = { kind: "quote", symbol: "600519.SH", range: "" };
    tauri.invoke.mockResolvedValue({ data: { price: 1297.4 }, mode: "qveris-cap", audits: [] });
    await expect(queryCapabilityData(input)).resolves.toMatchObject({ mode: "qveris-cap" });
    expect(tauri.invoke).toHaveBeenCalledWith("qveris_data_query", { input });
  });

  it("tests the model gateway through a no-tools Host probe", async () => {
    tauri.invoke.mockResolvedValue({ text: "模型连接正常", model: "model-a", cost: null });
    await expect(testModelConnection()).resolves.toMatchObject({ text: "模型连接正常" });
    expect(tauri.invoke).toHaveBeenCalledWith("qveris_model_connection_test", undefined);
  });

  it("routes the model probe to Local Host during web debugging", async () => {
    delete window.__TAURI_INTERNALS__;
    localHost.isLocalWebRuntime.mockReturnValue(true);
    localHost.localHostRequest.mockResolvedValue({ text: "模型连接正常", model: "model-a" });
    await expect(testModelConnection()).resolves.toMatchObject({ model: "model-a" });
    expect(localHost.localHostRequest).toHaveBeenCalledWith("/api/integration/model/test", { method: "POST", timeoutMs: 40_000 });
  });

  it("surfaces a Local Host outage instead of presenting a fake demo state", async () => {
    delete window.__TAURI_INTERNALS__;
    localHost.isLocalWebRuntime.mockReturnValue(true);
    const error = new Error("无法连接本地调试 Host");
    error.code = "LOCAL_HOST_UNAVAILABLE";
    localHost.localHostRequest.mockRejectedValue(error);

    await expect(loadIntegrationStatus()).rejects.toBe(error);
    expect(localHost.localHostRequest).toHaveBeenCalledWith("/api/integration/status");
  });

  it("marks a healthy Local Host status as a real local environment", async () => {
    delete window.__TAURI_INTERNALS__;
    localHost.isLocalWebRuntime.mockReturnValue(true);
    localHost.localHostRequest.mockResolvedValue({ credentialConfigured: true, settings: { modelId: "model-a" } });

    await expect(loadIntegrationStatus()).resolves.toMatchObject({ credentialConfigured: true, demo: false, environment: "local-host" });
  });
});
