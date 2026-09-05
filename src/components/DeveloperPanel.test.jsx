import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({
  clearDeveloperLogs: vi.fn().mockResolvedValue({ cleared: true }),
  testCapability: vi.fn().mockResolvedValue({ toolId: "qveris_finance.mkt_l1_rt", capability: "MKT.L1.RT", data: { quotes: [{ symbol: "AAPL", price: 227.57 }] } }),
  discoverCapabilities: vi.fn().mockResolvedValue({ query: "provider:qveris_finance", searchId: "srch_demo", total: 1, updatedAt: "2026-08-31T00:00:00Z", tools: [{ kind: "discovered:qveris_finance.analytics_rsi", toolId: "qveris_finance.analytics_rsi", capability: "RSI", description: "技术指标", provider: "qveris_finance", parameters: { symbol: "string", period: "integer?" }, parameterDetails: [{ name: "symbol", required: true, description: "证券代码" }], sampleParameters: { symbol: "600519", period: 14 }, returns: ["value"], expectedCost: "1 credit" }] }),
  loadDeveloperOverview: vi.fn().mockResolvedValue({ logs: [{ id: "1", at: "2026-08-29T03:00:00Z", method: "POST", path: "/api/data/query", status: 200, durationMs: 42 }], state: { activeRequest: false, keyPrefix: "cap_demo…", settings: { modelId: "model-a" }, toolCache: [{ kind: "quote" }] }, variables: { toolCacheEnabled: true, requestTimeoutMs: 120000, maxConcurrentDataRequests: 1, logLevel: "info" } }),
  updateDeveloperVariables: vi.fn().mockResolvedValue({ variables: { toolCacheEnabled: false, requestTimeoutMs: 120000, maxConcurrentDataRequests: 1, logLevel: "info" } }),
}));
vi.mock("../lib/localHost.js", () => ({ ...host, LOCAL_HOST_ABORTED: "LOCAL_HOST_ABORTED", isLocalWebRuntime: () => true }));
import { capabilityTestOutcome, capabilityToolSchema, DeveloperPanel, desktopCostSummary, normalizeCost } from "./DeveloperPanel.jsx";

describe("DeveloperPanel", () => {
  afterEach(() => cleanup());
  it("normalizes numeric native costs and keeps units separate", () => {
    expect(normalizeCost(0.25, "credits")).toEqual({ amount: 0.25, unit: "credits" });
    expect(normalizeCost({ amount: 0.012, unit: "USD" })).toEqual({ amount: 0.012, unit: "USD" });
    expect(normalizeCost(null)).toBeNull();
    expect(normalizeCost("")).toBeNull();
    expect(desktopCostSummary([
      { kind: "qveris", cost: 0.25, costUnit: "credits" },
      { type: "model", cost: { amount: 0.012, unit: "USD" } },
      { kind: "qveris" },
    ])).toMatchObject({ qverisCalls: 2, qverisCost: 0.25, qverisCostKnown: 1, qverisUnits: ["credits"], modelCalls: 1, modelCost: 0.012, modelCostKnown: 1, modelUnits: ["USD"] });
    expect(desktopCostSummary([
      { kind: "qveris", cacheHit: true, cost: 9, costUnit: "credits" },
      { kind: "qveris", cacheHit: false, cost: 0.1, costUnit: "credits" },
    ])).toMatchObject({ qverisCalls: 1, qverisCost: 0.1, qverisCostKnown: 1 });
  });
  it("exports a stable function-tool schema with required parameters", () => {
    expect(capabilityToolSchema({ kind: "series", toolId: "qveris_finance.mkt_bars_eod", capability: "MKT.BARS.EOD", description: "历史日线", parameters: { symbol: "string", start_date: "string", end_date: "string?" } })).toMatchObject({
      type: "function",
      function: { name: "foliomind_cap_series", parameters: { required: ["symbol", "start_date"], properties: { end_date: { type: "string" } } } },
      "x-foliomind": { tool_id: "qveris_finance.mkt_bars_eod", capability: "MKT.BARS.EOD" },
    });
  });

  it("distinguishes usable, empty, and rejected CAP responses", () => {
    const quote = { kind: "quote" };
    expect(capabilityTestOutcome(quote, { data: { quotes: [{ price: 1297.4 }] } })).toEqual({ state: "success" });
    expect(capabilityTestOutcome(quote, { data: { quotes: [] } })).toEqual({ state: "empty", message: "调用成功，但没有返回可识别的真实行情" });
    expect(capabilityTestOutcome({ kind: "series" }, { data: { series: [] } })).toEqual({ state: "empty", message: "调用成功，但上游没有返回可展示数据" });
    expect(capabilityTestOutcome({ kind: "details" }, { result: { status_code: 503 } })).toEqual({ state: "error", error: "上游返回失败结果，请展开调用日志查看原因" });
    expect(capabilityTestOutcome({ kind: "details" }, { result: { status_code: 200, success: true, message: "ok" } })).toEqual({ state: "empty", message: "调用成功，但上游没有返回可展示数据" });
  });

  it("keeps nested dynamic CAP tests truthful", () => {
    const quote = { kind: "quote" };
    expect(capabilityTestOutcome(quote, { success: true, result: { payload: { data: { quotes: [{ last_price: "1297.4" }] } } } })).toEqual({ state: "success" });
    expect(capabilityTestOutcome(quote, { success: true, result: { payload: { data: { quotes: [] } } } })).toEqual({ state: "empty", message: "调用成功，但没有返回可识别的真实行情" });
    expect(capabilityTestOutcome({ kind: "series" }, { success: true, result: { payload: { data: { bars: [{ date: "2026-09-05", close: 12 }] } } } })).toEqual({ state: "success" });
    expect(capabilityTestOutcome({ kind: "details" }, { success: true, result: { payload: { statusCode: 503, data: { name: "不可用资料" } } } })).toEqual({ state: "error", error: "上游返回失败结果，请展开调用日志查看原因" });
  });

  it("stays collapsed until opened and exposes redacted diagnostics", async () => {
    render(<DeveloperPanel />);
    expect(screen.queryByText(/\/api\/data\/query/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /开发者面板/ }));
    expect(await screen.findByText(/\/api\/data\/query/)).toBeInTheDocument();
    expect(screen.getByText("cap_demo…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "导出日志" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "启用工具固化缓存" }));
    await waitFor(() => expect(host.updateDeveloperVariables).toHaveBeenCalledWith({ toolCacheEnabled: false }));
    expect(screen.getByText("当前支持的金融能力（CAP）")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "测试标的" }), { target: { value: "aapl" } });
    fireEvent.click(screen.getAllByRole("button", { name: "调用测试" })[0]);
    await waitFor(() => expect(host.testCapability).toHaveBeenCalledWith({ kind: "quote", symbol: "AAPL" }, expect.objectContaining({ signal: expect.any(AbortSignal), timeoutMs: 45_000 })));
    expect(await screen.findByText(/测试成功/)).toBeInTheDocument();
  });

  it("redacts unknown developer errors", async () => {
    host.loadDeveloperOverview.mockRejectedValueOnce(new Error("private upstream response"));
    render(<DeveloperPanel />);
    fireEvent.click(screen.getByRole("button", { name: /开发者面板/ }));
    expect(await screen.findByText("本地 Host 未连接", { exact: true })).toBeInTheDocument();
    expect(screen.queryByText("private upstream response")).not.toBeInTheDocument();
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
    await waitFor(() => expect(host.testCapability).toHaveBeenCalledWith({ toolId: "qveris_finance.analytics_rsi", searchId: "srch_demo", parameters: { symbol: "600519", period: 14 } }, expect.objectContaining({ signal: expect.any(AbortSignal), timeoutMs: 45_000 })));
  });

  it("allows discovered CAP parameters to be edited and rejects invalid JSON locally", async () => {
    host.testCapability.mockClear();
    render(<DeveloperPanel />);
    fireEvent.click(screen.getByRole("button", { name: /开发者面板/ }));
    fireEvent.click(screen.getByRole("button", { name: "加载完整目录" }));
    expect(await screen.findByText("RSI")).toBeInTheDocument();
    const parameters = screen.getByRole("textbox", { name: "RSI 测试参数" });
    fireEvent.change(parameters, { target: { value: '{"symbol":"AAPL","period":7}' } });
    fireEvent.click(screen.getAllByRole("button", { name: "调用测试" }).at(-1));
    await waitFor(() => expect(host.testCapability).toHaveBeenCalledWith({ toolId: "qveris_finance.analytics_rsi", searchId: "srch_demo", parameters: { symbol: "AAPL", period: 7 } }, expect.objectContaining({ signal: expect.any(AbortSignal), timeoutMs: 45_000 })));

    fireEvent.change(parameters, { target: { value: "{" } });
    fireEvent.click(screen.getAllByRole("button", { name: "调用测试" }).at(-1));
    expect(await screen.findByText("测试参数需为有效 JSON 对象")).toBeInTheDocument();
    expect(host.testCapability).toHaveBeenCalledTimes(1);
  });

  it("shows a truthful empty state when a quote test returns no usable price", async () => {
    host.testCapability.mockResolvedValueOnce({ toolId: "qveris_finance.mkt_l1_rt", capability: "MKT.L1.RT", data: { quotes: [] } });
    render(<DeveloperPanel />);
    fireEvent.click(screen.getByRole("button", { name: /开发者面板/ }));
    fireEvent.click(screen.getAllByRole("button", { name: "调用测试" })[0]);
    expect(await screen.findByText("调用成功，但没有返回可识别的真实行情")).toBeInTheDocument();
    expect(screen.queryByText(/测试成功：/)).not.toBeInTheDocument();
  });

  it("allows a slow local capability test to be stopped without committing its late result", async () => {
    let resolveTest;
    host.testCapability.mockImplementationOnce((_input, options = {}) => new Promise((resolve, reject) => {
      resolveTest = resolve;
      options.signal?.addEventListener("abort", () => {
        const error = new Error("本次本地数据请求已取消");
        error.name = "AbortError";
        error.code = "LOCAL_HOST_ABORTED";
        reject(error);
      }, { once: true });
    }));
    render(<DeveloperPanel />);
    fireEvent.click(screen.getByRole("button", { name: /开发者面板/ }));
    const testButton = (await screen.findAllByRole("button", { name: "调用测试" }))[0];
    fireEvent.click(testButton);
    expect(await screen.findByRole("button", { name: "停止测试" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "停止测试" }));
    expect(await screen.findByText("已停止本次测试，未提交迟到结果。")).toBeInTheDocument();
    resolveTest?.({ data: { quotes: [{ symbol: "600519", price: 1 }] } });
    expect(screen.queryByText(/测试成功：/)).not.toBeInTheDocument();
  });

  it("allows a slow live directory load to be stopped and retried", async () => {
    host.discoverCapabilities.mockClear();
    host.discoverCapabilities.mockImplementationOnce((_input, options = {}) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => {
        const error = new Error("目录加载已取消");
        error.name = "AbortError";
        error.code = "LOCAL_HOST_ABORTED";
        reject(error);
      }, { once: true });
    }));
    render(<DeveloperPanel />);
    fireEvent.click(screen.getByRole("button", { name: /开发者面板/ }));
    fireEvent.click(screen.getByRole("button", { name: "加载完整目录" }));
    expect(await screen.findByRole("button", { name: "停止加载" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "停止加载" }));
    expect(await screen.findByText("已停止目录加载，可稍后重新尝试")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "加载完整目录" }));
    expect(await screen.findByText("RSI")).toBeInTheDocument();
    expect(host.discoverCapabilities).toHaveBeenCalledTimes(2);
    expect(host.discoverCapabilities.mock.calls[0][1]).toEqual(expect.objectContaining({ signal: expect.any(AbortSignal), timeoutMs: 30_000 }));
  });

  it("filters the capability workbench by stable ids and shows a recoverable empty state", async () => {
    render(<DeveloperPanel />);
    fireEvent.click(screen.getByRole("button", { name: /开发者面板/ }));
    const filter = await screen.findByRole("textbox", { name: "筛选能力" });
    fireEvent.change(filter, { target: { value: "MKT.L1.RT" } });
    expect(screen.getByText("MKT.L1.RT")).toBeInTheDocument();
    expect(screen.queryByText("REF.COMPANY_PROFILE")).not.toBeInTheDocument();
    fireEvent.change(filter, { target: { value: "不存在的能力" } });
    expect(screen.getByText(/没有匹配的能力/)).toBeInTheDocument();
  });
});
