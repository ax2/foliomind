import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({
  clearDeveloperLogs: vi.fn().mockResolvedValue({ cleared: true }),
  testCapability: vi.fn().mockResolvedValue({ toolId: "qveris_finance.mkt_l1_rt", capability: "MKT.L1.RT" }),
  discoverCapabilities: vi.fn().mockResolvedValue({ query: "provider:qveris_finance", searchId: "srch_demo", total: 1, updatedAt: "2026-08-31T00:00:00Z", tools: [{ kind: "discovered:qveris_finance.analytics_rsi", toolId: "qveris_finance.analytics_rsi", capability: "RSI", description: "技术指标", provider: "qveris_finance", parameters: { symbol: "string", period: "integer?" }, parameterDetails: [{ name: "symbol", required: true, description: "证券代码" }], sampleParameters: { symbol: "600519", period: 14 }, returns: ["value"], expectedCost: "1 credit" }] }),
  loadDeveloperOverview: vi.fn().mockResolvedValue({ logs: [{ id: "1", at: "2026-08-29T03:00:00Z", method: "POST", path: "/api/data/query", status: 200, durationMs: 42 }], state: { activeRequest: false, keyPrefix: "cap_demo…", settings: { modelId: "model-a" }, toolCache: [{ kind: "quote" }] }, variables: { toolCacheEnabled: true, requestTimeoutMs: 120000, maxConcurrentDataRequests: 1, logLevel: "info" } }),
  updateDeveloperVariables: vi.fn().mockResolvedValue({ variables: { toolCacheEnabled: false, requestTimeoutMs: 120000, maxConcurrentDataRequests: 1, logLevel: "info" } }),
}));
vi.mock("../lib/localHost.js", () => ({ ...host, isLocalWebRuntime: () => true }));
import { capabilityToolSchema, DeveloperPanel, desktopCostSummary, normalizeCost } from "./DeveloperPanel.jsx";

describe("DeveloperPanel", () => {
  afterEach(() => cleanup());
  it("normalizes numeric native costs and keeps units separate", () => {
    expect(normalizeCost(0.25, "credits")).toEqual({ amount: 0.25, unit: "credits" });
    expect(normalizeCost({ amount: 0.012, unit: "USD" })).toEqual({ amount: 0.012, unit: "USD" });
    expect(desktopCostSummary([
      { kind: "qveris", cost: 0.25, costUnit: "credits" },
      { type: "model", cost: { amount: 0.012, unit: "USD" } },
      { kind: "qveris" },
    ])).toMatchObject({ qverisCalls: 2, qverisCost: 0.25, qverisCostKnown: 1, qverisUnits: ["credits"], modelCalls: 1, modelCost: 0.012, modelCostKnown: 1, modelUnits: ["USD"] });
  });
  it("exports a stable function-tool schema with required parameters", () => {
    expect(capabilityToolSchema({ kind: "series", toolId: "qveris_finance.mkt_bars_eod", capability: "MKT.BARS.EOD", description: "历史日线", parameters: { symbol: "string", start_date: "string", end_date: "string?" } })).toMatchObject({
      type: "function",
      function: { name: "foliomind_cap_series", parameters: { required: ["symbol", "start_date"], properties: { end_date: { type: "string" } } } },
      "x-foliomind": { tool_id: "qveris_finance.mkt_bars_eod", capability: "MKT.BARS.EOD" },
    });
  });

  it("stays collapsed until opened and exposes redacted diagnostics", async () => {
    render(<DeveloperPanel />);
    expect(screen.queryByText(/\/api\/data\/query/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /开发者面板/ }));
    expect(await screen.findByText(/\/api\/data\/query/)).toBeInTheDocument();
    expect(screen.getByText("cap_demo…")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "启用工具固化缓存" }));
    await waitFor(() => expect(host.updateDeveloperVariables).toHaveBeenCalledWith({ toolCacheEnabled: false }));
    expect(screen.getByText("当前支持的金融能力（CAP）")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "测试标的" }), { target: { value: "aapl" } });
    fireEvent.click(screen.getAllByRole("button", { name: "调用测试" })[0]);
    await waitFor(() => expect(host.testCapability).toHaveBeenCalledWith({ kind: "quote", symbol: "AAPL" }));
    expect(await screen.findByText(/测试成功/)).toBeInTheDocument();
  });

  it("copies the selected CAP as a Skill-compatible tool schema", async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    render(<DeveloperPanel />);
    fireEvent.click(screen.getByRole("button", { name: /开发者面板/ }));
    fireEvent.click((await screen.findAllByRole("button", { name: "复制 Tool Schema" }))[0]);
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
    expect(await screen.findByRole("button", { name: "已复制" })).toBeInTheDocument();
    const payload = JSON.parse(navigator.clipboard.writeText.mock.calls[0][0]);
    expect(payload.function.name).toBe("foliomind_cap_quote");
    expect(payload["x-foliomind"].tool_id).toBe("qveris_finance.mkt_l1_rt");
  });

  it("loads a live provider directory and tests a discovered capability", async () => {
    render(<DeveloperPanel />);
    fireEvent.click(screen.getByRole("button", { name: /开发者面板/ }));
    fireEvent.click(screen.getByRole("button", { name: "加载完整目录" }));
    expect(await screen.findByText("RSI")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "调用测试" }).at(-1));
    await waitFor(() => expect(host.testCapability).toHaveBeenCalledWith({ toolId: "qveris_finance.analytics_rsi", searchId: "srch_demo", parameters: { symbol: "600519", period: 14 } }));
  });
});
