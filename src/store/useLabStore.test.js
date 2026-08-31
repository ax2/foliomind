import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ abortPi: vi.fn(), askPi: vi.fn(), queryCachedData: vi.fn() }));

vi.mock("../lib/piRuntime.js", () => ({ ABORTED_CODE: "PI_ABORTED", abortPi: runtime.abortPi, askPi: runtime.askPi, isDesktopRuntime: () => false }));
vi.mock("../lib/localHost.js", () => ({ getDeveloperVariable: (_name, fallback) => fallback === undefined ? 2 : fallback, isLocalWebRuntime: () => true, queryCachedData: runtime.queryCachedData }));
vi.mock("../lib/userState.js", () => ({ loadUserState: vi.fn().mockResolvedValue(null), saveUserState: vi.fn().mockResolvedValue(true) }));

import { initialLabState, useLabStore } from "./useLabStore.js";

describe("lab store streaming lifecycle", () => {
  beforeEach(() => {
    runtime.askPi.mockReset();
    runtime.abortPi.mockReset();
    runtime.queryCachedData.mockReset();
    useLabStore.setState({
      ...initialLabState,
      messages: initialLabState.messages.map((message) => ({ ...message })),
    });
  });

  it("updates one assistant placeholder in place until the final answer", async () => {
    let reportProgress;
    let finish;
    runtime.askPi.mockImplementation((_prompt, { onProgress }) => {
      reportProgress = onProgress;
      return new Promise((resolve) => { finish = resolve; });
    });

    const sent = useLabStore.getState().sendMessage("分析 AAPL");
    const pending = useLabStore.getState().messages.at(-1);
    expect(pending).toMatchObject({ role: "assistant", text: "Pi 正在分析…", streaming: true });

    reportProgress({ text: "第一段结果" });
    expect(useLabStore.getState().messages.at(-1)).toMatchObject({ id: pending.id, text: "第一段结果", streaming: true });

    finish({ text: "完整结果", mode: "pi-rpc", audits: [{ toolCallId: "call-1", operation: "search", outcome: "success" }] });
    await expect(sent).resolves.toBe(true);
    expect(useLabStore.getState().messages.at(-1)).toMatchObject({ id: pending.id, text: "完整结果", mode: "pi-rpc", streaming: false });
    expect(useLabStore.getState().messages.filter((message) => message.role === "assistant")).toHaveLength(2);
  });

  it("hydrates page quotes from a real structured QVeris response", async () => {
    useLabStore.setState({
      integrationStatus: { credentialConfigured: true, settings: { modelId: "model-a" } },
      userStateLoaded: true,
      watchlist: [{ symbol: "600519", name: "贵州茅台", market: "沪深", category: "白酒" }],
    });
    runtime.askPi.mockResolvedValue({
      text: JSON.stringify({ quotes: [{ symbol: "600519.SS", price: 1297.4, changePercent: 0.39, asOf: "2026-08-28 15:17:32", source: "caidazi" }] }),
      mode: "pi-local-host",
      audits: [{ operation: "search" }],
    });

    await expect(useLabStore.getState().refreshLiveData()).resolves.toBe(true);
    expect(runtime.askPi).toHaveBeenCalledOnce();
    expect(useLabStore.getState().liveQuotes["600519"]).toMatchObject({ price: 1297.4, change: 0.39, source: "caidazi" });
    expect(useLabStore.getState().liveDataError).toBe("");
  });

  it("refreshes only the selected quote through the cached data path", async () => {
    useLabStore.setState({
      integrationStatus: { credentialConfigured: true, settings: { modelId: "model-a" } },
      userStateLoaded: true,
      watchlist: [
        { symbol: "600519", name: "贵州茅台", market: "沪深", category: "白酒" },
        { symbol: "AAPL", name: "Apple Inc.", market: "NASDAQ", category: "科技" },
      ],
      liveQuotes: { AAPL: { price: 200, source: "已有数据" } },
    });
    runtime.queryCachedData.mockResolvedValue({
      data: { quotes: [{ symbol: "600519", price: 1297.4, changePercent: 0.39, asOf: "2026-08-30 10:00:00", source: "真实 CAP" }] },
      cacheHit: true,
      mode: "qveris-cap",
      audits: [],
    });

    await expect(useLabStore.getState().refreshSelectedQuote("600519")).resolves.toBe(true);
    expect(runtime.queryCachedData).toHaveBeenCalledWith({ kind: "quote", symbol: "600519.SH", range: "" }, { timeoutMs: 60_000 });
    expect(useLabStore.getState().liveQuotes).toMatchObject({ "600519": { price: 1297.4 }, AAPL: { price: 200 } });
    expect(useLabStore.getState().liveDataLoading).toBe(false);
  });

  it("does not block a selected refresh while the background batch is running", async () => {
    useLabStore.setState({
      integrationStatus: { credentialConfigured: true, settings: { modelId: "model-a" } },
      userStateLoaded: true,
      liveDataLoading: true,
      watchlist: [{ symbol: "600519", name: "贵州茅台", market: "沪深", category: "白酒" }],
    });
    runtime.queryCachedData.mockResolvedValue({
      data: { quotes: [{ symbol: "600519", price: 1297.4, asOf: "2026-08-30 10:00:00", source: "真实 CAP" }] },
      cacheHit: true,
      mode: "qveris-cap",
      audits: [],
    });

    await expect(useLabStore.getState().refreshSelectedQuote("600519")).resolves.toBe(true);
    expect(useLabStore.getState().liveQuotes["600519"].price).toBe(1297.4);
    expect(useLabStore.getState().liveDataLoading).toBe(true);
  });

  it("creates edge-triggered portfolio price alerts from real quotes", async () => {
    useLabStore.setState({
      integrationStatus: { credentialConfigured: true, settings: { modelId: "model-a" } },
      userStateLoaded: true,
      watchlist: [{ symbol: "600519", name: "贵州茅台", market: "沪深", category: "白酒" }],
      portfolioPositions: [{ id: "p1", symbol: "600519", name: "贵州茅台", market: "沪深", quantity: 1, averageCost: 1000, takeProfitPrice: 1200, stopLossPrice: 800, takeProfitTriggered: false, stopLossTriggered: false }],
    });
    runtime.askPi.mockResolvedValue({ text: JSON.stringify({ quotes: [{ symbol: "600519", price: 1200, asOf: "2026-08-30 10:00:00", source: "真实 CAP" }] }), mode: "pi-local-host", audits: [] });

    await expect(useLabStore.getState().refreshLiveData()).resolves.toBe(true);
    expect(useLabStore.getState().portfolioPositions[0].takeProfitTriggered).toBe(true);
    expect(useLabStore.getState().notifications).toHaveLength(1);
    expect(useLabStore.getState().notifications[0]).toMatchObject({ kind: "portfolio-alert", severity: "warning", source: "data-service" });
    expect(useLabStore.getState().notifications[0].body).toContain("不构成投资建议");

    await expect(useLabStore.getState().refreshLiveData()).resolves.toBe(true);
    expect(useLabStore.getState().notifications).toHaveLength(1);
  });

  it("stores a reproducible portfolio close review from real quotes", async () => {
    useLabStore.setState({
      portfolioPositions: [{ id: "p1", symbol: "AAPL", name: "Apple", market: "NASDAQ", quantity: 2, averageCost: 100 }],
      liveQuotes: { AAPL: { price: 120, asOf: "2026-08-30T08:00:00Z", source: "provider" } },
      events: [],
    });
    await expect(useLabStore.getState().createPortfolioReview()).resolves.toMatchObject({ pricedCount: 1, totalPnl: 40 });
    expect(useLabStore.getState().portfolioReviews).toHaveLength(1);
    await expect(useLabStore.getState().removePortfolioReview(useLabStore.getState().portfolioReviews[0].id)).resolves.toBe(true);
    expect(useLabStore.getState().portfolioReviews).toEqual([]);
  });

  it("creates one scheduled close review from same-day real quotes", async () => {
    useLabStore.setState({
      portfolioPositions: [{ id: "p1", symbol: "600519", name: "贵州茅台", market: "沪深", quantity: 1, averageCost: 1000 }],
      liveQuotes: { "600519": { price: 1200, asOf: "2026-09-01T07:20:00Z", source: "真实 CAP" } },
      events: [],
      briefingSchedule: { ...initialLabState.briefingSchedule, enabled: true, closeTime: "15:35" },
    });
    await expect(useLabStore.getState().runDuePortfolioReview(new Date("2026-09-01T08:00:00Z"))).resolves.toBe("success");
    expect(useLabStore.getState().portfolioReviews).toHaveLength(1);
    expect(useLabStore.getState().notifications[0]).toMatchObject({ kind: "briefing", eventKey: "close:2026-09-01" });
    expect(useLabStore.getState().briefingSchedule).toMatchObject({ lastResult: "success", lastSuccessKey: "close:2026-09-01" });
    await expect(useLabStore.getState().runDuePortfolioReview(new Date("2026-09-01T08:10:00Z"))).resolves.toBe("completed");
    expect(useLabStore.getState().portfolioReviews).toHaveLength(1);
  });

  it("refreshes multiple watchlist quotes with the local concurrency limit", async () => {
    const watchlist = [
      { symbol: "600519", name: "贵州茅台", market: "沪深", category: "白酒" },
      { symbol: "300750", name: "宁德时代", market: "沪深", category: "新能源" },
      { symbol: "600036", name: "招商银行", market: "沪深", category: "银行" },
      { symbol: "601318", name: "中国平安", market: "沪深", category: "保险" },
    ];
    useLabStore.setState({ integrationStatus: { credentialConfigured: true, settings: { modelId: "model-a" } }, userStateLoaded: true, watchlist });
    let active = 0;
    let maxActive = 0;
    runtime.askPi.mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 8));
      active -= 1;
      return { text: JSON.stringify({ quotes: watchlist.map((item) => ({ symbol: item.symbol, price: 100 })) }), mode: "pi-local-host", audits: [] };
    });

    await expect(useLabStore.getState().refreshLiveData()).resolves.toBe(true);
    expect(maxActive).toBe(2);
    expect(Object.keys(useLabStore.getState().liveQuotes)).toHaveLength(4);
  });

  it("uses the selected instrument market instead of labeling every quote as A-share", async () => {
    useLabStore.setState({
      integrationStatus: { credentialConfigured: true, settings: { modelId: "model-a" } },
      userStateLoaded: true,
      watchlist: [{ symbol: "AAPL", name: "Apple Inc.", market: "NASDAQ", category: "科技" }],
    });
    runtime.askPi.mockResolvedValue({ text: JSON.stringify({ quotes: [{ symbol: "AAPL", price: 227.57 }] }), mode: "pi-local-host", audits: [] });

    await expect(useLabStore.getState().refreshLiveData()).resolves.toBe(true);
    expect(runtime.askPi.mock.calls[0][0]).toContain("美股实时行情快照");
    expect(runtime.askPi.mock.calls[0][0]).not.toContain("A股实时行情快照");
  });

  it("keeps upstream data errors friendly and free of gateway details", async () => {
    useLabStore.setState({
      integrationStatus: { credentialConfigured: true, settings: { modelId: "model-a" } },
      userStateLoaded: true,
      watchlist: [{ symbol: "600519", name: "贵州茅台", market: "沪深", category: "白酒" }],
    });
    runtime.askPi.mockRejectedValue(new Error("HTTP 503 https://secret-gateway.example/api/v1 timeout"));

    await expect(useLabStore.getState().refreshLiveData()).resolves.toBe(false);
    expect(useLabStore.getState().liveDataError).toBe("贵州茅台：数据响应较慢，系统会稍后自动重试");
    expect(useLabStore.getState().liveDataError).not.toContain("secret-gateway");
  });

  it("persists portfolio positions with normalized numbers", async () => {
    const saved = await useLabStore.getState().savePortfolioPosition({ symbol: " aapl ", name: "Apple", market: "US", quantity: "2", averageCost: "100" });
    expect(saved).toMatchObject({ symbol: "AAPL", quantity: 2, averageCost: 100 });
    expect(useLabStore.getState().portfolioPositions).toHaveLength(1);
    await expect(useLabStore.getState().removePortfolioPosition(saved.id)).resolves.toBe(true);
    expect(useLabStore.getState().portfolioPositions).toHaveLength(0);
  });

  it("normalizes a custom watchlist group when adding a symbol", async () => {
    const saved = await useLabStore.getState().addWatchlist({ symbol: "tsla", name: "Tesla", market: "NASDAQ", group: "成长观察" });
    expect(saved).toMatchObject({ symbol: "TSLA", group: "成长观察" });
    expect(useLabStore.getState().watchlist.at(-1)).toMatchObject({ symbol: "TSLA", group: "成长观察" });
  });

  it("imports watchlist items atomically and skips existing symbols", async () => {
    const result = await useLabStore.getState().importWatchlistItems([
      { symbol: "600519", name: "贵州茅台", market: "A股" },
      { symbol: "TSLA", name: "Tesla", market: "美股", group: "海外" },
    ]);
    expect(result).toEqual({ added: 1, skipped: 1 });
    expect(useLabStore.getState().watchlist.at(-1)).toMatchObject({ symbol: "TSLA", group: "海外" });
  });

  it("records portfolio plan actions and keeps the plan edge auditable", async () => {
    const saved = await useLabStore.getState().savePortfolioPosition({ symbol: "AAPL", name: "Apple", market: "US", quantity: 2, averageCost: 100, takeProfitPrice: 125, planThesis: "盈利增长", planHorizon: "swing" });
    expect(saved).toMatchObject({ planStatus: "active", planHorizon: "swing", planActions: [{ type: "created" }] });
    const executed = await useLabStore.getState().updatePortfolioPlanStatus(saved.id, "executed");
    expect(executed).toMatchObject({ planStatus: "executed", planActions: [{ type: "executed" }, { type: "created" }] });
    const reopened = await useLabStore.getState().updatePortfolioPlanStatus(saved.id, "active");
    expect(reopened.planStatus).toBe("active");
    expect(reopened.planActions.slice(0, 2).map((action) => action.type)).toEqual(["reopened", "executed"]);
  });

  it("replaces portable user data and clears real-data caches", async () => {
    useLabStore.setState({
      ...initialLabState,
      userStateLoaded: true,
      selectedSymbol: "600519",
      liveQuotes: { "600519": { price: 1200 } },
    });
    await expect(useLabStore.getState().replaceUserState({
      watchlist: [{ symbol: "AAPL", name: "Apple", market: "NASDAQ", category: "科技" }],
      monitorRules: [{ id: "r1", symbol: "AAPL", strategyId: "price_change", threshold: 5, intervalSeconds: 300, enabled: true }],
      notifications: [],
      portfolioPositions: [],
    })).resolves.toBe(true);
    expect(useLabStore.getState()).toMatchObject({ selectedSymbol: "AAPL", liveQuotes: {}, watchlist: [{ symbol: "AAPL" }] });
    expect(useLabStore.getState().rules[0]).toMatchObject({ symbol: "AAPL", strategyId: "price_change" });
  });

  it("clears stale quotes when the configured data channel changes", () => {
    useLabStore.setState({
      integrationStatus: { credentialConfigured: true, settings: { modelId: "model-a", modelGatewayBaseUrl: "https://one.example", capabilityBaseUrl: "https://data.example" } },
      liveQuotes: { AAPL: { price: 100 } },
      liveDataLastRefreshAt: "2026-08-28T08:00:00.000Z",
      quoteDetailsLoaded: { AAPL: true },
      quoteSeriesLoaded: { AAPL: { 日K: true } },
    });
    useLabStore.getState().setIntegrationStatus({ credentialConfigured: true, settings: { modelId: "model-a", modelGatewayBaseUrl: "https://two.example", capabilityBaseUrl: "https://data.example" } });
    expect(useLabStore.getState()).toMatchObject({ liveQuotes: {}, liveDataLastRefreshAt: null, quoteDetailsLoaded: {}, quoteSeriesLoaded: {} });
  });

  it("ignores an in-flight quote response from an old data channel", async () => {
    let resolveQuote;
    useLabStore.setState({
      integrationStatus: { credentialConfigured: true, settings: { modelId: "model-a", modelGatewayBaseUrl: "https://one.example" } },
      userStateLoaded: true,
      watchlist: [{ symbol: "600519", name: "贵州茅台", market: "沪深", category: "白酒" }],
    });
    runtime.askPi.mockImplementation(() => new Promise((resolve) => { resolveQuote = resolve; }));
    const pending = useLabStore.getState().refreshLiveData();
    await Promise.resolve();
    useLabStore.getState().setIntegrationStatus({ credentialConfigured: true, settings: { modelId: "model-a", modelGatewayBaseUrl: "https://two.example" } });
    resolveQuote({ text: JSON.stringify({ quotes: [{ symbol: "600519", price: 1297.4 }] }), mode: "pi-local-host", audits: [] });

    await expect(pending).resolves.toBe(false);
    expect(useLabStore.getState()).toMatchObject({ liveQuotes: {}, liveDataLoading: false });
  });

  it("runs due monitor checks in the local Web Host when real data is configured", async () => {
    useLabStore.setState({
      integrationStatus: { credentialConfigured: true, settings: { modelId: "model-a" } },
      userStateLoaded: true,
      rules: [{ id: "rule-1", symbol: "600519", strategyId: "price_change", threshold: 3, intervalSeconds: 300, enabled: true, lastCheckedAt: null }],
      watchlist: [{ symbol: "600519", name: "贵州茅台", market: "沪深", category: "白酒" }],
    });
    runtime.askPi.mockResolvedValue({ text: JSON.stringify({ triggered: false, title: "贵州茅台 · 价格异动", summary: "真实数据检查完成", severity: "info", asOf: "2026-08-29 10:00:00" }), mode: "pi-local-host", audits: [] });

    await expect(useLabStore.getState().runDueMonitorChecks()).resolves.toBe(true);
    expect(runtime.askPi).toHaveBeenCalledOnce();
    expect(useLabStore.getState().rules[0].lastCheckedAt).toBeTruthy();
    expect(useLabStore.getState().notifications).toHaveLength(0);
  });

  it("treats an invalid monitor timestamp as due instead of silently skipping it", async () => {
    useLabStore.setState({
      integrationStatus: { credentialConfigured: true, settings: { modelId: "model-a" } },
      userStateLoaded: true,
      rules: [{ id: "rule-1", symbol: "600519", strategyId: "news_risk", threshold: 1, intervalSeconds: 300, enabled: true, lastCheckedAt: "not-a-date" }],
      watchlist: [{ symbol: "600519", name: "贵州茅台", market: "沪深", category: "白酒" }],
    });
    runtime.askPi.mockResolvedValue({ text: JSON.stringify({ triggered: false, title: "贵州茅台 · 公告与舆情", summary: "检查完成", severity: "info" }), mode: "pi-local-host", audits: [] });

    await expect(useLabStore.getState().runDueMonitorChecks()).resolves.toBe(true);
    expect(runtime.askPi).toHaveBeenCalledOnce();
  });

  it("evaluates a cached price quote directly for local monitor checks", async () => {
    useLabStore.setState({
      integrationStatus: { credentialConfigured: true, settings: { modelId: "model-a" } },
      userStateLoaded: true,
      rules: [{ id: "rule-1", symbol: "600519", strategyId: "price_change", threshold: 3, intervalSeconds: 300, enabled: true, lastCheckedAt: null }],
      watchlist: [{ symbol: "600519", name: "贵州茅台", market: "沪深", category: "白酒" }],
    });
    runtime.queryCachedData.mockResolvedValue({ data: { quotes: [{ symbol: "600519", price: 1310, changePercent: 4.2, asOf: "2026-08-29 10:00:00", source: "真实行情源" }] }, cacheHit: true, mode: "standalone-dev-host", audits: [] });

    await expect(useLabStore.getState().runMonitorCheck("rule-1")).resolves.toBe(true);
    expect(runtime.askPi).not.toHaveBeenCalled();
    expect(runtime.queryCachedData).toHaveBeenCalledOnce();
    expect(useLabStore.getState().notifications[0]).toMatchObject({ severity: "warning", source: "data-service" });
    expect(useLabStore.getState().notifications[0].body).toContain("+4.20%");
  });

  it("evaluates a cached corporate event directly without a model round trip", async () => {
    useLabStore.setState({
      integrationStatus: { credentialConfigured: true, settings: { modelId: "model-a" } },
      userStateLoaded: true,
      rules: [{ id: "rule-event", symbol: "600519", strategyId: "news_risk", conditions: [{ type: "core_event", operator: "gte", value: 1 }], intervalSeconds: 300, enabled: true, lastCheckedAt: null }],
      watchlist: [{ symbol: "600519", name: "贵州茅台", market: "沪深", category: "白酒" }],
    });
    runtime.queryCachedData.mockResolvedValue({ data: { events: [{ date: "2026-09-01", title: "股东会" }], eventCount: 1, asOf: "2026-08-29", source: "真实事件源" }, mode: "qveris-cap", audits: [{ operation: "cap-call", capability: "EVENT.CALENDAR.CORP" }] });

    await expect(useLabStore.getState().runMonitorCheck("rule-event")).resolves.toBe(true);
    expect(runtime.queryCachedData).toHaveBeenCalledWith({ kind: "core_event", symbol: "600519.SH" }, { timeoutMs: 60_000 });
    expect(runtime.askPi).not.toHaveBeenCalled();
    expect(useLabStore.getState().monitorHistory[0]).toMatchObject({ outcome: "triggered", triggered: true, conditionResults: [true], asOf: "2026-08-29" });
  });

  it("loads real company events for the watchlist with truthful empty results", async () => {
    const watchlist = [
      { symbol: "600519", name: "贵州茅台", market: "沪深", category: "白酒" },
      { symbol: "AAPL", name: "Apple Inc.", market: "NASDAQ", category: "科技" },
    ];
    useLabStore.setState({
      integrationStatus: { credentialConfigured: true, settings: { modelId: "model-a" } },
      userStateLoaded: true,
      watchlist,
    });
    runtime.queryCachedData.mockImplementation(async ({ kind, symbol }) => {
      expect(kind).toBe("core_event");
      if (symbol === "600519.SH") {
        return { data: { events: [{ date: "2026-09-01", event_type: "分红", description: "分红登记日" }], source: "真实事件源" }, mode: "qveris-cap", audits: [] };
      }
      return { data: { events: [], source: "真实事件源" }, mode: "qveris-cap", audits: [] };
    });

    await expect(useLabStore.getState().refreshEvents()).resolves.toBe(true);
    expect(runtime.askPi).not.toHaveBeenCalled();
    expect(runtime.queryCachedData).toHaveBeenCalledTimes(2);
    expect(useLabStore.getState()).toMatchObject({ eventDataLoaded: true, eventDataReceivedCount: 2, eventDataTotalCount: 2, eventDataError: "" });
    expect(useLabStore.getState().events).toHaveLength(1);
    expect(useLabStore.getState().events[0]).toMatchObject({ symbol: "600519", type: "分红", title: "分红登记日", source: "真实事件源", capability: "EVENT.CALENDAR.CORP", provider: "qveris_finance" });
  });

  it("does not turn an unavailable event response into a false signal", async () => {
    useLabStore.setState({
      integrationStatus: { credentialConfigured: true, settings: { modelId: "model-a" } },
      userStateLoaded: true,
      rules: [{ id: "rule-event-empty", symbol: "600519", strategyId: "news_risk", conditions: [{ type: "core_event", operator: "gte", value: 1 }], intervalSeconds: 300, enabled: true, lastCheckedAt: null }],
      watchlist: [{ symbol: "600519", name: "贵州茅台", market: "沪深", category: "白酒" }],
    });
    runtime.queryCachedData.mockResolvedValue({ data: { events: [], eventCount: null, dataStatus: "empty", asOf: null, source: "真实事件源" }, mode: "qveris-cap", audits: [] });
    runtime.askPi.mockResolvedValue({ text: JSON.stringify({ triggered: null, summary: "暂时无法核实", severity: "info" }), mode: "pi-local-host", audits: [] });

    await expect(useLabStore.getState().runMonitorCheck("rule-event-empty")).resolves.toBe(true);
    expect(runtime.askPi).toHaveBeenCalledOnce();
    expect(useLabStore.getState().monitorHistory[0]).toMatchObject({ outcome: "unknown", triggered: null });
  });

  it("evaluates cached capital flow and sentiment fields as real monitor inputs", async () => {
    useLabStore.setState({
      integrationStatus: { credentialConfigured: true, settings: { modelId: "model-a" } },
      userStateLoaded: true,
      rules: [{ id: "rule-flow-sentiment", symbol: "600519", strategyId: "news_risk", conditions: [{ type: "capital_flow", operator: "gte", value: 100 }, { type: "sentiment", operator: "eq", value: "negative" }], logic: "OR", intervalSeconds: 300, enabled: true, lastCheckedAt: null }],
      watchlist: [{ symbol: "600519", name: "贵州茅台", market: "沪深", category: "白酒" }],
    });
    runtime.queryCachedData.mockImplementation(async ({ kind }) => kind === "capital_flow"
      ? { data: { capitalFlow: [{ date: "2026-08-29", mainNetInflow: 120 }], mainNetInflow: 120, asOf: "2026-08-29", source: "真实资金流" }, mode: "qveris-cap", audits: [] }
      : { data: { news: [{ title: "风险提示" }], sentiment: "negative", asOf: "2026-08-29", source: "真实舆情" }, mode: "qveris-cap", audits: [] });

    await expect(useLabStore.getState().runMonitorCheck("rule-flow-sentiment")).resolves.toBe(true);
    expect(runtime.askPi).not.toHaveBeenCalled();
    expect(runtime.queryCachedData).toHaveBeenCalledTimes(2);
    expect(useLabStore.getState().monitorHistory[0].conditionResults).toEqual([true, true]);
  });

  it("notifies on a trigger edge instead of repeating the same alert every poll", async () => {
    useLabStore.setState({
      integrationStatus: { credentialConfigured: true, settings: { modelId: "model-a" } },
      userStateLoaded: true,
      rules: [{ id: "rule-1", symbol: "600519", strategyId: "price_change", threshold: 3, intervalSeconds: 300, enabled: true, lastCheckedAt: null }],
      watchlist: [{ symbol: "600519", name: "贵州茅台", market: "沪深", category: "白酒" }],
    });
    const quote = (changePercent) => ({ data: { quotes: [{ symbol: "600519", price: 1300, changePercent, asOf: "2026-08-29 10:00:00", source: "真实行情源" }] }, cacheHit: true, mode: "standalone-dev-host", audits: [] });
    runtime.queryCachedData.mockResolvedValueOnce(quote(4.2)).mockResolvedValueOnce(quote(4.2)).mockResolvedValueOnce(quote(1.2)).mockResolvedValueOnce(quote(4.5));

    await expect(useLabStore.getState().runMonitorCheck("rule-1")).resolves.toBe(true);
    await expect(useLabStore.getState().runMonitorCheck("rule-1")).resolves.toBe(true);
    expect(useLabStore.getState().notifications).toHaveLength(1);
    expect(useLabStore.getState().rules[0].lastSignalTriggered).toBe(true);

    await expect(useLabStore.getState().runMonitorCheck("rule-1")).resolves.toBe(true);
    expect(useLabStore.getState().notifications).toHaveLength(1);
    expect(useLabStore.getState().rules[0].lastSignalTriggered).toBe(false);

    await expect(useLabStore.getState().runMonitorCheck("rule-1")).resolves.toBe(true);
    expect(useLabStore.getState().notifications).toHaveLength(2);
  });

  it("keeps an auditable monitor timeline for triggered checks", async () => {
    useLabStore.setState({
      integrationStatus: { credentialConfigured: true, settings: { modelId: "model-a" } },
      userStateLoaded: true,
      rules: [{ id: "rule-1", symbol: "600519", strategyId: "price_change", threshold: 3, intervalSeconds: 300, enabled: true, lastCheckedAt: null }],
      watchlist: [{ symbol: "600519", name: "贵州茅台", market: "沪深", category: "白酒" }],
    });
    runtime.queryCachedData.mockResolvedValue({ data: { quotes: [{ symbol: "600519", price: 1310, changePercent: 4.2, asOf: "2026-08-29 10:00:00", source: "真实行情源" }] }, cacheHit: true, mode: "standalone-dev-host", audits: [{ operation: "cached-call", outcome: "success", toolId: "qveris_finance.mkt_l1_rt" }] });

    await expect(useLabStore.getState().runMonitorCheck("rule-1")).resolves.toBe(true);
    expect(useLabStore.getState().monitorHistory[0]).toMatchObject({ ruleId: "rule-1", symbol: "600519", outcome: "triggered", triggered: true, source: "data-service", asOf: "2026-08-29 10:00:00", conditionResults: [true] });
    expect(useLabStore.getState().monitorHistory[0].audits[0]).toMatchObject({ operation: "cached-call", toolId: "qveris_finance.mkt_l1_rt" });
  });

  it("allows a failed quote detail request to be retried manually", async () => {
    useLabStore.setState({
      integrationStatus: { credentialConfigured: true, settings: { modelId: "model-a" } },
      userStateLoaded: true,
      liveDataLastRefreshAt: "2026-08-28T08:00:00.000Z",
      watchlist: [{ symbol: "600519", name: "贵州茅台", market: "沪深", category: "白酒" }],
    });
    runtime.askPi.mockRejectedValueOnce(new Error("上游暂不可用")).mockResolvedValueOnce({ text: JSON.stringify({ companyDescription: "真实简介" }), mode: "pi-local-host", audits: [] });
    await expect(useLabStore.getState().refreshQuoteDetails("600519")).resolves.toBe(false);
    expect(useLabStore.getState().quoteDetailsLoaded["600519"]).toBe(true);
    await expect(useLabStore.getState().retryQuoteDetails("600519")).resolves.toBe(true);
    expect(useLabStore.getState().liveQuotes["600519"].companyDescription).toBe("真实简介");
    expect(runtime.askPi).toHaveBeenCalledTimes(2);
  });

  it("hydrates detailed chart and company fields without inventing missing values", async () => {
    useLabStore.setState({
      integrationStatus: { credentialConfigured: true, settings: { modelId: "model-a" } },
      userStateLoaded: true,
      watchlist: [{ symbol: "600519", name: "贵州茅台", market: "沪深", category: "白酒" }],
    });
    runtime.askPi.mockResolvedValue({
      text: JSON.stringify({ quote: { symbol: "600519", price: 1297.4, changePercent: 0.39, previousClose: 1292.3, source: "caidazi" }, seriesByRange: { "日K": [{ time: "2026-08-28", open: 1289, high: 1297.89, low: 1288, close: 1297.4 }] }, fundamentals: { revenue: null, roe: 28.4 }, companyDescription: "真实简介" }),
      mode: "pi-local-host",
      audits: [],
    });

    await expect(useLabStore.getState().refreshQuoteDetails("600519")).resolves.toBe(true);
    expect(useLabStore.getState().liveQuotes["600519"]).toMatchObject({ price: 1297.4, change: 0.39, previousClose: 1292.3, companyDescription: "真实简介" });
    expect(useLabStore.getState().liveQuotes["600519"].seriesByRange["日K"]).toHaveLength(1);
  });

  it("loads one real chart range on demand and keeps empty ranges empty", async () => {
    useLabStore.setState({
      integrationStatus: { credentialConfigured: true, settings: { modelId: "model-a" } },
      userStateLoaded: true,
      liveDataLastRefreshAt: "2026-08-28T08:00:00.000Z",
      quoteDetailsLoaded: { "600519": true },
      watchlist: [{ symbol: "600519", name: "贵州茅台", market: "沪深", category: "白酒" }],
    });
    runtime.askPi.mockResolvedValue({
      text: JSON.stringify({ series: [{ time: "2026-08-28", open: 1289, high: 1297.89, low: 1288, close: 1297.4, volume: 1612600 }] }),
      mode: "pi-local-host",
      audits: [{ operation: "search" }, { operation: "inspect" }, { operation: "call" }],
    });

    await expect(useLabStore.getState().refreshQuoteSeries("600519", "日K")).resolves.toBe(true);
    expect(runtime.askPi).toHaveBeenCalledOnce();
    expect(useLabStore.getState().liveQuotes["600519"].seriesByRange["日K"]).toHaveLength(1);
    expect(useLabStore.getState().quoteSeriesLoaded["600519"]["日K"]).toBe(true);
  });

  it("replaces partial output with an error instead of appending another message", async () => {
    runtime.askPi.mockImplementation(async (_prompt, { onProgress }) => {
      onProgress({ text: "未完成内容" });
      throw new Error("模型进程退出");
    });

    await expect(useLabStore.getState().sendMessage("触发错误")).resolves.toBe(false);
    const messages = useLabStore.getState().messages;
    expect(messages.at(-1)).toMatchObject({ role: "assistant", text: "这次分析暂时没有完成，稍后可以重试。", mode: "error", streaming: false });
    expect(messages.filter((message) => message.role === "assistant")).toHaveLength(2);
  });

  it("does not send an unconfigured local-host prompt over the network", async () => {
    useLabStore.setState({ integrationStatus: { credentialConfigured: false, settings: { modelId: "" } } });

    await expect(useLabStore.getState().sendMessage("分析 AAPL")).resolves.toBe(false);
    expect(runtime.askPi).not.toHaveBeenCalled();
    expect(useLabStore.getState().messages.at(-1)).toMatchObject({
      role: "assistant",
      text: "数据服务凭据需要重新确认，请到设置中检查配置",
      mode: "error",
      streaming: false,
    });
  });

  it("cancels an active analysis and replaces its partial output in place", async () => {
    let rejectAnalysis;
    runtime.askPi.mockImplementation((_prompt, { onProgress }) => {
      onProgress({ text: "尚未完成的分析" });
      return new Promise((_resolve, reject) => { rejectAnalysis = reject; });
    });
    runtime.abortPi.mockResolvedValue(true);

    const sent = useLabStore.getState().sendMessage("取消这次分析");
    const pendingId = useLabStore.getState().messages.at(-1).id;
    await expect(useLabStore.getState().cancelMessage()).resolves.toBe(true);
    expect(useLabStore.getState().runtimeMode).toBe("cancelling");

    const cancelled = new Error("本轮分析已取消");
    cancelled.code = "PI_ABORTED";
    rejectAnalysis(cancelled);
    await expect(sent).resolves.toBe(false);
    expect(useLabStore.getState().runtimeMode).toBe("cancelled");
    expect(useLabStore.getState().messages.at(-1)).toMatchObject({ id: pendingId, text: "已取消本轮分析。", mode: "cancelled", streaming: false });
  });

  it("restores the running state when Pi rejects a cancellation request", async () => {
    runtime.askPi.mockImplementation(() => new Promise(() => {}));
    runtime.abortPi.mockRejectedValue(new Error("Agent is not streaming"));
    void useLabStore.getState().sendMessage("继续运行");

    await expect(useLabStore.getState().cancelMessage()).resolves.toBe(false);
    expect(useLabStore.getState().runtimeMode).toBe("running");
  });

  it("does not overwrite a result that settles while cancellation is pending", async () => {
    let finishAnalysis;
    let rejectAbort;
    runtime.askPi.mockImplementation(() => new Promise((resolve) => { finishAnalysis = resolve; }));
    runtime.abortPi.mockImplementation(() => new Promise((_resolve, reject) => { rejectAbort = reject; }));
    const sent = useLabStore.getState().sendMessage("竞态分析");
    const cancellation = useLabStore.getState().cancelMessage();

    finishAnalysis({ text: "已在取消前完成", mode: "pi-rpc", audits: [] });
    await expect(sent).resolves.toBe(true);
    rejectAbort(new Error("Agent is not streaming"));
    await expect(cancellation).resolves.toBe(false);
    expect(useLabStore.getState().runtimeMode).toBe("pi-rpc");
    expect(useLabStore.getState().messages.at(-1)).toMatchObject({ text: "已在取消前完成", streaming: false });
  });

  it("prevents analysis while Runtime settings are being applied", async () => {
    expect(useLabStore.getState().beginRuntimeConfiguration()).toBe(true);
    expect(useLabStore.getState().runtimeConfiguring).toBe(true);

    await expect(useLabStore.getState().sendMessage("不应发出的请求")).resolves.toBe(false);
    expect(runtime.askPi).not.toHaveBeenCalled();
    expect(useLabStore.getState().messages).toHaveLength(initialLabState.messages.length);

    useLabStore.getState().endRuntimeConfiguration();
    expect(useLabStore.getState().runtimeConfiguring).toBe(false);
  });

  it("atomically accepts only one synchronous send", async () => {
    runtime.askPi.mockImplementation(() => new Promise(() => {}));

    const first = useLabStore.getState().sendMessage("第一条分析");
    const second = useLabStore.getState().sendMessage("第二条分析");

    await expect(second).resolves.toBe(false);
    expect(runtime.askPi).toHaveBeenCalledOnce();
    expect(useLabStore.getState().messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(useLabStore.getState().messages.at(-2).text).toBe("第一条分析");
    void first;
  });

  it("atomically accepts only one synchronous cancellation", async () => {
    runtime.askPi.mockImplementation(() => new Promise(() => {}));
    runtime.abortPi.mockImplementation(() => new Promise(() => {}));
    void useLabStore.getState().sendMessage("等待停止");

    const first = useLabStore.getState().cancelMessage();
    const second = useLabStore.getState().cancelMessage();

    await expect(second).resolves.toBe(false);
    expect(runtime.abortPi).toHaveBeenCalledOnce();
    expect(useLabStore.getState().runtimeMode).toBe("cancelling");
    void first;
  });

  it("blocks a new analysis until a delayed cancellation command settles", async () => {
    let finishAnalysis;
    let finishAbort;
    runtime.askPi
      .mockImplementationOnce(() => new Promise((resolve) => { finishAnalysis = resolve; }))
      .mockResolvedValueOnce({ text: "下一轮完成", mode: "pi-rpc", audits: [] });
    runtime.abortPi.mockImplementation(() => new Promise((resolve) => { finishAbort = resolve; }));

    const sent = useLabStore.getState().sendMessage("第一轮分析");
    const cancellation = useLabStore.getState().cancelMessage();
    finishAnalysis({ text: "取消前已完成", mode: "pi-rpc", audits: [] });
    await expect(sent).resolves.toBe(true);
    expect(useLabStore.getState()).toMatchObject({ runtimeMode: "pi-rpc", runtimeCancelPending: true });
    await expect(useLabStore.getState().sendMessage("不应抢跑")).resolves.toBe(false);
    expect(runtime.askPi).toHaveBeenCalledOnce();

    finishAbort(true);
    await expect(cancellation).resolves.toBe(true);
    expect(useLabStore.getState().runtimeCancelPending).toBe(false);
    await expect(useLabStore.getState().sendMessage("下一轮分析")).resolves.toBe(true);
    expect(runtime.askPi).toHaveBeenCalledTimes(2);
  });

  it.each(["running", "cancelling"])("refuses to apply Runtime settings while mode is %s", (runtimeMode) => {
    useLabStore.setState({ runtimeMode });

    expect(useLabStore.getState().beginRuntimeConfiguration()).toBe(false);
    expect(useLabStore.getState().runtimeConfiguring).toBe(false);
  });
});
