import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));

import { syncQVerisModels } from "./integrations.js";

describe("integration client", () => {
  beforeEach(() => {
    window.__TAURI_INTERNALS__ = {};
    tauri.invoke.mockReset();
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
});
