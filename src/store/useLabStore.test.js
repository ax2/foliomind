import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ abortPi: vi.fn(), askPi: vi.fn(), queryCachedData: vi.fn(), queryTradingCalendar: vi.fn() }));
const persistence = vi.hoisted(() => ({ loadUserState: vi.fn().mockResolvedValue(null), saveUserState: vi.fn().mockResolvedValue(true) }));

vi.mock("../lib/piRuntime.js", () => ({ ABORTED_CODE: "PI_ABORTED", abortPi: runtime.abortPi, askPi: runtime.askPi, isDesktopRuntime: () => false }));
vi.mock("../lib/localHost.js", () => ({ getDeveloperVariable: (_name, fallback) => fallback === undefined ? 2 : fallback, isLocalWebRuntime: () => true, queryCachedData: runtime.queryCachedData }));
vi.mock("../lib/userState.js", async (importOriginal) => ({ ...(await importOriginal()), loadUserState: persistence.loadUserState, saveUserState: persistence.saveUserState }));
vi.mock("../lib/integrations.js", () => ({ loadIntegrationStatus: vi.fn(), queryCapabilityData: runtime.queryCachedData, queryTradingCalendar: runtime.queryTradingCalendar }));

import { initialLabState, LIVE_QUOTE_FULL_REFRESH_INTERVAL_MS, LIVE_QUOTE_PRIORITY_REFRESH_INTERVAL_MS, shouldFallbackToAgent, useLabStore } from "./useLabStore.js";

const freshAsOf = () => new Date(Date.now() - 60_000).toISOString();

describe("lab store streaming lifecycle", () => {
  beforeEach(async () => {
    runtime.askPi.mockReset();
    runtime.abortPi.mockReset();
    runtime.queryCachedData.mockReset();
    runtime.queryTradingCalendar.mockReset();
    persistence.loadUserState.mockReset().mockResolvedValue(null);
    persistence.saveUserState.mockReset().mockResolvedValue(true);
    runtime.queryTradingCalendar.mockResolvedValue({ queriedDate: "2026-09-01", isTradingDay: true, source: "cn_financial_pro", toolId: "cn_financial_pro.trade_dates.v1" });
    useLabStore.setState({
      ...initialLabState,
      messages: initialLabState.messages.map((message) => ({ ...message })),
    });
    await useLabStore.getState().hydrateUserState();
  });

  it("only allows explicit capability misses to enter the Agent discovery path", () => {
    expect(shouldFallbackToAgent(Object.assign(new Error("缓存未命中"), { code: "TOOL_CACHE_MISS", status: 404 }))).toBe(true);
    expect(shouldFallbackToAgent(Object.assign(new Error("能力不存在"), { code: "CAPABILITY_NOT_FOUND", status: 404 }))).toBe(true);
    expect(shouldFallbackToAgent(Object.assign(new Error("金融数据凭据无效"), { status: 401 }))).toBe(false);
    expect(shouldFallbackToAgent(Object.assign(new Error("请求较多"), { status: 429 }))).toBe(false);
    expect(shouldFallbackToAgent(new Error("金融数据渠道暂时不可用"))).toBe(false);
  });

  it("keeps user state unloaded and exposes a retry after a Host read failure", async () => {
    const error = new Error("Host unavailable");
    persistence.loadUserState.mockRejectedValueOnce(error).mockResolvedValueOnce({ revision: 8, watchlist: [{ symbol: "AAPL", name: "Apple", market: "NASDAQ" }] });

    await expect(useLabStore.getState().hydrateUserState()).resolves.toBe(false);
    expect(useLabStore.getState()).toMatchObject({ userStateLoaded: false, userStateLoading: false, userStateError: "本地数据暂时无法读取；请检查本地 Host 后重试" });

    await expect(useLabStore.getState().hydrateUserState()).resolves.toBe(true);
    expect(useLabStore.getState()).toMatchObject({ userStateLoaded: true, userStateLoading: false, userStateError: "", watchlist: [{ symbol: "AAPL", name: "Apple", market: "NASDAQ" }] });
  });

  it("anchors the selected workspace to the hydrated watchlist", async () => {
    useLabStore.setState({ selectedSymbol: "600519", watchlist: initialLabState.watchlist });
    persistence.loadUserState.mockResolvedValueOnce({ revision: 12, watchlist: [
      { symbol: "AAPL", name: "Apple", market: "NASDAQ" },
      { symbol: "MSFT", name: "Microsoft", market: "NASDAQ" },
    ] });

    await expect(useLabStore.getState().hydrateUserState()).resolves.toBe(true);
    expect(useLabStore.getState()).toMatchObject({ selectedSymbol: "AAPL", watchlist: [{ symbol: "AAPL" }, { symbol: "MSFT" }] });
  });

  it("keeps a user-selected symbol when it survives hydration", async () => {
    useLabStore.setState({ selectedSymbol: "MSFT", watchlist: initialLabState.watchlist });
    persistence.loadUserState.mockResolvedValueOnce({ revision: 13, watchlist: [
      { symbol: "AAPL", name: "Apple", market: "NASDAQ" },
      { symbol: "MSFT", name: "Microsoft", market: "NASDAQ" },
    ] });

    await expect(useLabStore.getState().hydrateUserState()).resolves.toBe(true);
    expect(useLabStore.getState().selectedSymbol).toBe("MSFT");
  });

  it("resolves exchange-suffixed navigation to the saved watchlist symbol", () => {
    useLabStore.setState({ watchlist: [{ symbol: "600519", name: "贵州茅台", market: "A股" }] });
    useLabStore.getState().selectSymbol("SSE:600519");
    expect(useLabStore.getState()).toMatchObject({ selectedSymbol: "600519", activeView: "watchlist" });
  });

  it("starts with an explicit integration hydration state", () => {
    useLabStore.setState({ ...initialLabState });
    expect(useLabStore.getState()).toMatchObject({ integrationStatus: null, integrationStatusLoading: true, integrationStatusError: "" });
  });

  it("preserves edits made while a slow Host snapshot is loading", async () => {
    let release;
    persistence.loadUserState.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const hydration = useLabStore.getState().hydrateUserState();
    expect(useLabStore.getState().hydrateUserState()).toBe(hydration);
    useLabStore.setState({ watchlist: [{ symbol: "LOCAL", name: "本地编辑", market: "自定义" }] });
    release({ revision: 9, watchlist: [{ symbol: "REMOTE", name: "远端状态", market: "自定义" }] });

    await expect(hydration).resolves.toBe(true);
    expect(useLabStore.getState().watchlist.map((item) => item.symbol)).toEqual(expect.arrayContaining(["LOCAL", "REMOTE"]));
  });

  it("persists Skill installation changes and rolls back when saving fails", async () => {
    persistence.saveUserState.mockClear();
    expect(useLabStore.getState().skillItems.find((item) => item.id === "news").installed).toBe(false);

    await expect(useLabStore.getState().toggleSkill("news")).resolves.toBe(true);
    expect(useLabStore.getState().skillItems.find((item) => item.id === "news").installed).toBe(true);
    expect(persistence.saveUserState).toHaveBeenCalledWith(expect.objectContaining({ installedSkillIds: expect.arrayContaining(["news"]) }), expect.any(Object));

    persistence.saveUserState.mockRejectedValueOnce(new Error("disk full"));
    await expect(useLabStore.getState().toggleSkill("news")).rejects.toThrow("disk full");
    expect(useLabStore.getState().skillItems.find((item) => item.id === "news").installed).toBe(true);
  });

  it("reads the latest store state when a queued persistence write starts", async () => {
    let captured;
    persistence.saveUserState.mockImplementationOnce(async (state) => {
      captured = state;
      return { ...state, revision: state.revision + 1 };
    });

    const pending = useLabStore.getState().persistUserState();
    const added = { symbol: "TEST", name: "并发测试", market: "自定义", group: "测试" };
    useLabStore.setState((state) => ({ watchlist: [...state.watchlist, added] }));
    await pending;

    expect(captured.watchlist).toEqual(expect.arrayContaining([expect.objectContaining({ symbol: "TEST" })]));
  });

  it("moves a watchlist item within its group and persists the custom order", async () => {
    persistence.saveUserState.mockClear();
    useLabStore.setState({ watchlist: [
      { symbol: "A", name: "第一项", market: "自定义", group: "核心" },
      { symbol: "B", name: "第二项", market: "自定义", group: "核心" },
      { symbol: "C", name: "另一组", market: "自定义", group: "观察" },
      { symbol: "D", name: "第三项", market: "自定义", group: "核心" },
    ] });

    await expect(useLabStore.getState().moveWatchlistItem("D", "up")).resolves.toBe(true);
    expect(useLabStore.getState().watchlist.map((item) => item.symbol)).toEqual(["A", "D", "C", "B"]);
    expect(persistence.saveUserState).toHaveBeenCalledWith(expect.objectContaining({ watchlist: [
      expect.objectContaining({ symbol: "A" }), expect.objectContaining({ symbol: "D" }), expect.objectContaining({ symbol: "C" }), expect.objectContaining({ symbol: "B" }),
    ] }), expect.any(Object));
    await expect(useLabStore.getState().moveWatchlistItem("A", "up")).resolves.toBe(false);
    await expect(useLabStore.getState().moveWatchlistItem("D", "sideways")).resolves.toBe(false);
  });

  it("rolls back a watchlist reorder when canonical persistence fails", async () => {
    const error = new Error("disk full");
    useLabStore.setState({ watchlist: [
      { symbol: "A", name: "第一项", market: "自定义", group: "核心" },
      { symbol: "B", name: "第二项", market: "自定义", group: "核心" },
    ] });
    persistence.saveUserState.mockRejectedValueOnce(error);

    await expect(useLabStore.getState().moveWatchlistItem("B", "up")).rejects.toBe(error);
    expect(useLabStore.getState().watchlist.map((item) => item.symbol)).toEqual(["A", "B"]);
  });

  it("edits a monitor rule, preserves its audit timeline, and resets the trigger edge", async () => {
    const history = [{ id: "check-1", ruleId: "rule-1", outcome: "triggered", checkedAt: "2026-08-31T08:00:00Z" }];
    useLabStore.setState({
      rules: [{ id: "rule-1", symbol: "600519", strategyId: "price_change", conditions: [{ type: "price_change", operator: "abs_gte", value: 3 }], logic: "AND", intervalSeconds: 300, enabled: true, lastCheckedAt: "2026-08-31T08:00:00Z", lastTriggeredAt: "2026-08-31T08:00:00Z", lastSignalTriggered: true, lastSignalBySymbol: { "600519": true } }],
      monitorHistory: history,
    });

    const updated = await useLabStore.getState().updateRule("rule-1", { conditions: [{ type: "price_change", operator: "abs_gte", value: 5 }], intervalSeconds: 600 });

    expect(updated).toMatchObject({ intervalSeconds: 600, lastCheckedAt: null, lastTriggeredAt: null, lastSignalTriggered: null, lastSignalBySymbol: {} });
    expect(useLabStore.getState().rules[0].conditions[0].value).toBe(5);
    expect(useLabStore.getState().monitorHistory).toEqual(history);
    expect(persistence.saveUserState).toHaveBeenCalledWith(expect.objectContaining({ monitorRules: expect.arrayContaining([expect.objectContaining({ id: "rule-1", intervalSeconds: 600 })]) }), expect.any(Object));
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

  it("can refresh CAP market data with an API key before a model is selected", async () => {
    useLabStore.setState({
      integrationStatus: { credentialConfigured: true, settings: { modelId: "" } },
      userStateLoaded: true,
      watchlist: [{ symbol: "600519", name: "贵州茅台", market: "沪深", category: "白酒" }],
    });
    runtime.queryCachedData.mockResolvedValue({
      data: { quotes: [{ symbol: "600519", price: 1297.4, changePercent: 0.39, asOf: "2026-08-28 15:17:32", source: "真实 CAP" }] },
      mode: "qveris-cap",
      cacheHit: true,
      audits: [],
    });

    await expect(useLabStore.getState().refreshLiveData()).resolves.toBe(true);
    expect(runtime.queryCachedData).toHaveBeenCalledOnce();
    expect(runtime.askPi).not.toHaveBeenCalled();
    expect(useLabStore.getState().liveQuotes["600519"]).toMatchObject({ price: 1297.4, source: "真实 CAP" });
  });

  it("normalizes desktop-style nested quote envelopes and missing provider symbols", async () => {
    useLabStore.setState({
      integrationStatus: { credentialConfigured: true, settings: { modelId: "" } },
      userStateLoaded: true,
      watchlist: [{ symbol: "600519", name: "贵州茅台", market: "沪深", category: "白酒" }],
    });
    runtime.queryCachedData.mockResolvedValue({
      data: { payload: { quotes: [{ last_price: "1297.4", pct_change: 0.39, timestamp: "2026-09-05T07:30:00Z" }] } },
      mode: "qveris-cap",
      cacheHit: false,
      audits: [],
    });

    await expect(useLabStore.getState().refreshLiveData()).resolves.toBe(true);
    expect(useLabStore.getState().liveQuotes["600519"]).toMatchObject({ price: 1297.4, change: 0.39, asOf: "2026-09-05T07:30:00Z" });
  });

  it("records honest quote sweep progress for slow real-data updates", async () => {
    const watchlist = [
      { symbol: "600519", name: "贵州茅台", market: "沪深" },
      { symbol: "AAPL", name: "Apple", market: "NASDAQ" },
    ];
    useLabStore.setState({ integrationStatus: { credentialConfigured: true, settings: { modelId: "" } }, userStateLoaded: true, watchlist });
    runtime.queryCachedData.mockImplementation(async ({ symbol }) => ({ data: { quotes: [{ symbol, price: 100, asOf: "2026-09-05T09:00:00Z", source: "真实 CAP" }] }, mode: "qveris-cap", audits: [] }));

    const pending = useLabStore.getState().refreshLiveData();
    expect(useLabStore.getState()).toMatchObject({ liveDataLoading: true, liveDataCompletedCount: 0, liveDataReceivedCount: 0, liveDataTotalCount: 2 });
    await expect(pending).resolves.toBe(true);
    expect(useLabStore.getState()).toMatchObject({ liveDataLoading: false, liveDataCompletedCount: 2, liveDataReceivedCount: 2, liveDataTotalCount: 2 });
    expect(useLabStore.getState().liveDataStartedAt).toEqual(expect.any(String));
  });

  it("cancels a slow full quote sweep without leaving the store busy", async () => {
    let startedResolve;
    let requestSignal;
    const started = new Promise((resolve) => { startedResolve = resolve; });
    useLabStore.setState({
      integrationStatus: { credentialConfigured: true, settings: { modelId: "" } },
      userStateLoaded: true,
      watchlist: [{ symbol: "600519", name: "贵州茅台", market: "沪深", category: "白酒" }],
    });
    runtime.queryCachedData.mockImplementation((_input, options = {}) => {
      requestSignal = options.signal;
      startedResolve();
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError", code: "ABORT_ERR" })), { once: true });
      });
    });

    const pending = useLabStore.getState().refreshLiveData();
    await started;
    expect(useLabStore.getState().liveDataLoading).toBe(true);
    expect(useLabStore.getState().cancelLiveDataRefresh()).toBe(true);
    expect(requestSignal.aborted).toBe(true);
    expect(useLabStore.getState()).toMatchObject({ liveDataLoading: false, liveDataError: "已停止本轮行情更新，可稍后重试" });
    await expect(pending).resolves.toBe(false);
  });

  it("does not invoke the Agent again after a direct CAP authentication failure", async () => {
    useLabStore.setState({
      integrationStatus: { credentialConfigured: true, settings: { modelId: "model-a" } },
      userStateLoaded: true,
      watchlist: [{ symbol: "600519", name: "贵州茅台", market: "沪深", category: "白酒" }],
    });
    runtime.queryCachedData.mockRejectedValueOnce(Object.assign(new Error("金融数据凭据无效"), { status: 401, code: "UPSTREAM_AUTH" }));

    await expect(useLabStore.getState().refreshLiveData()).resolves.toBe(false);
    expect(runtime.askPi).not.toHaveBeenCalled();
    expect(useLabStore.getState().liveDataError).toContain("凭据");
  });

  it("rejects empty prices and preserves missing change fields as empty", async () => {
    useLabStore.setState({
      integrationStatus: { credentialConfigured: true, settings: { modelId: "" } },
      userStateLoaded: true,
      watchlist: [{ symbol: "600519", name: "贵州茅台", market: "沪深", category: "白酒" }],
    });
    runtime.queryCachedData.mockResolvedValueOnce({
      data: { quotes: [{ symbol: "600519", price: 1300, changePercent: null, changeAmount: null, source: "真实 CAP" }] },
      mode: "qveris-cap",
      cacheHit: true,
      audits: [],
    });

    await expect(useLabStore.getState().refreshLiveData()).resolves.toBe(true);
    expect(useLabStore.getState().liveQuotes["600519"]).toMatchObject({ price: 1300, change: null, changeAmount: null });

    runtime.queryCachedData.mockResolvedValueOnce({
      data: { quotes: [{ symbol: "600519", price: null, changePercent: 0, source: "错误响应" }] },
      mode: "qveris-cap",
      cacheHit: true,
      audits: [],
    });
    await expect(useLabStore.getState().refreshLiveData()).resolves.toBe(false);
    expect(useLabStore.getState().liveDataError).toContain("数据暂时未返回");
  });

  it("builds an auditable anomaly explanation from real CAP evidence", async () => {
    const anomaly = { id: "600519-price", symbol: "600519", name: "贵州茅台", type: "price", value: 8.2, threshold: 4, asOf: "2026-08-31", source: "真实行情源" };
    useLabStore.setState({
      integrationStatus: { credentialConfigured: true, settings: { modelId: "model-a" } },
      userStateLoaded: true,
      liveQuotes: { "600519": { price: 1_300, change: 8.2, volumeRatio: 3.4, asOf: "2026-08-31", source: "真实行情源" } },
      portfolioPositions: [{ id: "p1", symbol: "600519", name: "贵州茅台", quantity: 2, averageCost: 1_000 }],
    });
    runtime.queryCachedData.mockImplementation(async ({ kind }) => ({ data: kind === "sentiment"
      ? { news: [{ title: "已验证新闻", summary: "公告摘要", source: "交易所", url: "https://example.com/news", published_at: "2026-08-31" }] }
      : kind === "core_event"
        ? { events: [{ title: "财报披露", date: "2026-09-01", source: "公司事件" }] }
        : { capitalFlow: [{ mainNetInflow: 2_000_000, date: "2026-08-31", source: "资金流" }] }, audits: [{ operation: "cap-call", outcome: "success" }] }));
    runtime.askPi.mockResolvedValue({ text: JSON.stringify({ fact: "涨幅超过阈值", drivers: [{ text: "公告是可核验背景", evidenceIndex: [1] }], portfolioRelation: "持仓浮盈", watchNext: ["核验公告原文"], asOf: "2026-08-31" }), mode: "pi-local-host", audits: [{ operation: "chat-completions", outcome: "success" }] });

    await expect(useLabStore.getState().explainAnomaly(anomaly)).resolves.toBe(true);
    const result = useLabStore.getState().anomalyAttributions[anomaly.id];
    expect(runtime.queryCachedData).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ fact: "涨幅超过阈值", evidenceCount: 4, portfolioRelation: "持仓浮盈" });
    expect(result.drivers[0].references[0]).toMatchObject({ title: "已验证新闻", url: "https://example.com/news" });
    expect(result.audits).toHaveLength(4);
  });

  it("keeps anomaly attribution empty when no real quote or evidence exists", async () => {
    const anomaly = { id: "AAPL-volume", symbol: "AAPL", name: "Apple", type: "volume", value: 3, threshold: 2.5, asOf: "2026-08-31" };
    useLabStore.setState({ integrationStatus: { credentialConfigured: true, settings: { modelId: "model-a" } }, userStateLoaded: true, liveQuotes: {} });
    runtime.queryCachedData.mockResolvedValue({ data: { news: [], events: [], capitalFlow: [] } });

    await expect(useLabStore.getState().explainAnomaly(anomaly)).resolves.toBe(false);
    expect(runtime.askPi).not.toHaveBeenCalled();
    expect(useLabStore.getState().anomalyAttributionError[anomaly.id]).toContain("没有足够");
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
    expect(runtime.queryCachedData).toHaveBeenCalledWith({ kind: "quote", symbol: "600519.SH", range: "" }, expect.objectContaining({ timeoutMs: 60_000, signal: expect.any(AbortSignal) }));
    expect(useLabStore.getState().liveQuotes).toMatchObject({ "600519": { price: 1297.4 }, AAPL: { price: 200 } });
    expect(useLabStore.getState().liveDataLoading).toBe(false);
  });

  it("can refresh a searchable symbol before it is added to the watchlist", async () => {
    useLabStore.setState({
      integrationStatus: { credentialConfigured: true, settings: { modelId: "" } },
      userStateLoaded: true,
      watchlist: [{ symbol: "AAPL", name: "Apple Inc.", market: "NASDAQ", category: "科技" }],
      selectedSymbol: "600519",
    });
    runtime.queryCachedData.mockResolvedValue({
      data: { quotes: [{ symbol: "600519.SH", price: 1297.4, changePercent: 0.39, asOf: "2026-08-30 10:00:00", source: "真实 CAP" }] },
      cacheHit: true,
      mode: "qveris-cap",
      audits: [],
    });

    await expect(useLabStore.getState().refreshSelectedQuote("600519")).resolves.toBe(true);
    expect(runtime.queryCachedData).toHaveBeenCalledWith({ kind: "quote", symbol: "600519.SH", range: "" }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(useLabStore.getState().liveQuotes["600519"]).toMatchObject({ price: 1297.4, source: "真实 CAP" });
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
    runtime.askPi.mockResolvedValue({ text: JSON.stringify({ quotes: [{ symbol: "600519", price: 1200, asOf: freshAsOf(), source: "真实 CAP" }] }), mode: "pi-local-host", audits: [] });

    await expect(useLabStore.getState().refreshLiveData()).resolves.toBe(true);
    expect(useLabStore.getState().portfolioPositions[0].takeProfitTriggered).toBe(true);
    expect(useLabStore.getState().notifications).toHaveLength(1);
    expect(useLabStore.getState().notifications[0]).toMatchObject({ kind: "portfolio-alert", severity: "warning", source: "data-service" });
    expect(useLabStore.getState().notifications[0].body).toContain("不构成投资建议");

    await expect(useLabStore.getState().refreshLiveData()).resolves.toBe(true);
    expect(useLabStore.getState().notifications).toHaveLength(1);
  });

  it("joins exchange-suffixed portfolio alerts to provider quote keys", async () => {
    useLabStore.setState({
      integrationStatus: { credentialConfigured: true, settings: { modelId: "model-a" } },
      userStateLoaded: true,
      watchlist: [{ symbol: "600519.SS", name: "贵州茅台", market: "沪深", category: "白酒" }],
      portfolioPositions: [{ id: "p1", symbol: "600519.SS", name: "贵州茅台", market: "沪深", quantity: 1, averageCost: 1000, takeProfitPrice: 1200, stopLossPrice: 800, takeProfitTriggered: false, stopLossTriggered: false }],
    });
    runtime.askPi.mockResolvedValue({ text: JSON.stringify({ quotes: [{ symbol: "600519", price: 1200, asOf: freshAsOf(), source: "真实 CAP" }] }), mode: "pi-local-host", audits: [] });

    await expect(useLabStore.getState().refreshLiveData()).resolves.toBe(true);
    expect(useLabStore.getState().portfolioPositions[0].takeProfitTriggered).toBe(true);
    expect(useLabStore.getState().notifications[0]).toMatchObject({ symbol: "600519.SS", kind: "portfolio-alert" });
  });

  it("does not deliver a portfolio alert when its canonical save fails", async () => {
    useLabStore.setState({
      integrationStatus: { credentialConfigured: true, settings: { modelId: "model-a" } },
      userStateLoaded: true,
      watchlist: [{ symbol: "600519", name: "贵州茅台", market: "沪深", category: "白酒" }],
      portfolioPositions: [{ id: "p1", symbol: "600519", name: "贵州茅台", market: "沪深", quantity: 1, averageCost: 1000, takeProfitPrice: 1200, stopLossPrice: 800, takeProfitTriggered: false, stopLossTriggered: false }],
    });
    runtime.askPi.mockResolvedValue({ text: JSON.stringify({ quotes: [{ symbol: "600519", price: 1200, asOf: "2026-08-30 10:00:00", source: "真实 CAP" }] }), mode: "pi-local-host", audits: [] });
    persistence.saveUserState.mockRejectedValueOnce(new Error("disk full"));

    await expect(useLabStore.getState().refreshLiveData()).resolves.toBe(true);
    expect(useLabStore.getState().portfolioPositions[0].takeProfitTriggered).toBe(false);
    expect(useLabStore.getState().notifications).toHaveLength(0);
    expect(useLabStore.getState().liveQuotes["600519"]).toMatchObject({ price: 1200 });
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

  it("builds a premarket brief from real news and events without inventing unsupported sections", async () => {
    useLabStore.setState({
      integrationStatus: { credentialConfigured: true, settings: { dataProvider: "qveris_finance" } },
      portfolioPositions: [{ id: "p1", symbol: "600519", name: "贵州茅台", market: "沪深", quantity: 1, averageCost: 1000 }],
      events: [],
    });
    runtime.queryCachedData.mockImplementation(async ({ kind }) => kind === "sentiment"
      ? { data: { news: [{ title: "真实新闻", published_at: "2026-09-04T01:00:00Z", source: "数据服务" }] } }
      : { data: { events: [{ date: "2026-09-05", title: "分红日", source: "交易所" }] } });
    await expect(useLabStore.getState().generatePremarketBriefing(new Date("2026-09-04T02:00:00Z"))).resolves.toBe(true);
    expect(useLabStore.getState().premarketBriefing).toMatchObject({ kind: "premarket", sections: { industry: { status: "empty" }, macro: { status: "empty" }, overseas: { status: "empty" } } });
    expect(useLabStore.getState().premarketBriefing.sections.holdings.items).toHaveLength(2);
  });

  it("cancels an in-flight premarket brief without committing late CAP results", async () => {
    useLabStore.setState({ integrationStatus: { credentialConfigured: true }, portfolioPositions: [{ id: "p1", symbol: "600519", name: "贵州茅台", market: "沪深", quantity: 1, averageCost: 1000 }] });
    const releases = [];
    runtime.queryCachedData.mockImplementation(() => new Promise((resolve) => { releases.push(() => resolve({ data: { news: [{ title: "迟到结果" }] } })); }));
    const pending = useLabStore.getState().generatePremarketBriefing();
    expect(useLabStore.getState().premarketBriefingLoading).toBe(true);
    expect(useLabStore.getState().cancelPremarketBriefing()).toBe(true);
    releases.forEach((resolve) => resolve());
    await expect(pending).resolves.toBe(false);
    expect(useLabStore.getState().premarketBriefing).toBeNull();
    expect(useLabStore.getState().premarketBriefingLoading).toBe(false);
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
    expect(runtime.queryTradingCalendar).toHaveBeenCalledWith("2026-09-01");
    await expect(useLabStore.getState().runDuePortfolioReview(new Date("2026-09-01T08:10:00Z"))).resolves.toBe("completed");
    expect(useLabStore.getState().portfolioReviews).toHaveLength(1);
  });

  it("does not create a scheduled review when the real exchange calendar is closed", async () => {
    runtime.queryTradingCalendar.mockResolvedValue({ queriedDate: "2026-09-01", isTradingDay: false, source: "cn_financial_pro", toolId: "cn_financial_pro.trade_dates.v1" });
    useLabStore.setState({
      portfolioPositions: [{ id: "p1", symbol: "600519", name: "贵州茅台", market: "沪深", quantity: 1, averageCost: 1000 }],
      liveQuotes: { "600519": { price: 1200, asOf: "2026-09-01T07:20:00Z", source: "真实 CAP" } },
      briefingSchedule: { ...initialLabState.briefingSchedule, enabled: true, closeTime: "15:35" },
    });
    await expect(useLabStore.getState().runDuePortfolioReview(new Date("2026-09-01T08:00:00Z"))).resolves.toBe("market-closed");
    expect(useLabStore.getState().portfolioReviews).toEqual([]);
    expect(useLabStore.getState().briefingSchedule).toMatchObject({ calendarDate: "2026-09-01", calendarStatus: "closed", lastResult: "market-closed" });
  });

  it("checks every exchange represented in a mainland mixed portfolio", async () => {
    useLabStore.setState({
      portfolioPositions: [
        { id: "p1", symbol: "600519", name: "贵州茅台", market: "沪深", quantity: 1, averageCost: 1000 },
        { id: "p2", symbol: "300750", name: "宁德时代", market: "沪深", quantity: 1, averageCost: 200 },
      ],
      liveQuotes: {
        "600519": { price: 1200, asOf: "2026-09-01T07:20:00Z", source: "真实 CAP" },
        "300750": { price: 300, asOf: "2026-09-01T07:20:00Z", source: "真实 CAP" },
      },
      events: [],
      briefingSchedule: { ...initialLabState.briefingSchedule, enabled: true, closeTime: "15:35" },
    });
    await expect(useLabStore.getState().runDuePortfolioReview(new Date("2026-09-01T08:00:00Z"))).resolves.toBe("success");
    expect(runtime.queryTradingCalendar).toHaveBeenNthCalledWith(1, "2026-09-01");
    expect(runtime.queryTradingCalendar).toHaveBeenNthCalledWith(2, "2026-09-01", "212100");
  });

  it("refreshes multiple watchlist quotes with the local four-request concurrency limit", async () => {
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
    expect(maxActive).toBe(4);
    expect(Object.keys(useLabStore.getState().liveQuotes)).toHaveLength(4);
  });

  it("refreshes every item in a large watchlist without silently dropping symbols", async () => {
    const watchlist = Array.from({ length: 200 }, (_, index) => ({
      symbol: `6${String(index).padStart(5, "0")}`,
      name: `测试标的 ${index + 1}`,
      market: "沪深",
      category: "回归测试",
    }));
    useLabStore.setState({ integrationStatus: { credentialConfigured: true, settings: { modelId: "model-a" } }, userStateLoaded: true, watchlist });
    const requestedSymbols = [];
    runtime.queryCachedData.mockImplementation(async ({ symbol }) => {
      requestedSymbols.push(symbol);
      return { data: { quotes: [{ symbol, price: 100, asOf: "2026-09-03T09:00:00Z", source: "真实 CAP" }] }, mode: "qveris-cap", audits: [] };
    });

    await expect(useLabStore.getState().refreshLiveData()).resolves.toBe(true);

    expect(requestedSymbols).toHaveLength(watchlist.length);
    expect(new Set(requestedSymbols).size).toBe(watchlist.length);
    expect(Object.keys(useLabStore.getState().liveQuotes)).toHaveLength(watchlist.length);
    expect(useLabStore.getState().liveDataError).toBe("");
  });

  it("supports a priority quote refresh without sweeping the full watchlist", async () => {
    const watchlist = [
      { symbol: "600519", name: "贵州茅台", market: "沪深" },
      { symbol: "300750", name: "宁德时代", market: "深市" },
      { symbol: "AAPL", name: "Apple", market: "NASDAQ" },
    ];
    useLabStore.setState({ integrationStatus: { credentialConfigured: true, settings: { modelId: "model-a" } }, userStateLoaded: true, watchlist });
    runtime.queryCachedData.mockImplementation(async ({ symbol }) => ({ data: { quotes: [{ symbol, price: 100, asOf: "2026-09-02T09:00:00Z", source: "真实 CAP" }] }, mode: "qveris-cap", audits: [] }));

    await expect(useLabStore.getState().refreshLiveData({ symbols: ["600519", "AAPL"] })).resolves.toBe(true);
    expect(runtime.queryCachedData).toHaveBeenCalledTimes(2);
    expect(runtime.queryCachedData.mock.calls.map(([input]) => input.symbol).sort()).toEqual(["600519.SH", "AAPL"].sort());
    expect(useLabStore.getState().liveQuotes).toMatchObject({ "600519": { price: 100 }, AAPL: { price: 100 } });
    expect(useLabStore.getState().liveQuotes["300750"]).toBeUndefined();
  });

  it("keeps the documented two-tier quote polling intervals", () => {
    expect(LIVE_QUOTE_PRIORITY_REFRESH_INTERVAL_MS).toBe(15_000);
    expect(LIVE_QUOTE_FULL_REFRESH_INTERVAL_MS).toBe(180_000);
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

  it("does not route an explicit unknown market through an A-share symbol suffix", async () => {
    useLabStore.setState({
      integrationStatus: { credentialConfigured: true, settings: { modelId: "model-a" } },
      userStateLoaded: true,
      watchlist: [{ symbol: "123456", name: "自定义标的", market: "RUSSELL 2000" }],
    });
    runtime.askPi.mockResolvedValue({ text: JSON.stringify({ quotes: [{ symbol: "123456", price: 10 }] }), mode: "pi-local-host", audits: [] });

    await expect(useLabStore.getState().refreshLiveData()).resolves.toBe(true);
    expect(runtime.askPi.mock.calls[0][0]).toContain("未知市场实时行情快照");
    expect(runtime.askPi.mock.calls[0][0]).toContain("参数 symbol 必须使用 123456");
    expect(runtime.askPi.mock.calls[0][0]).not.toContain("123456.SH");
    expect(runtime.askPi.mock.calls[0][0]).not.toContain("123456.SZ");
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

  it("imports portfolio positions atomically and updates duplicate symbols", async () => {
    const existing = { id: "p1", symbol: "AAPL", name: "Apple", market: "NASDAQ", quantity: 1, averageCost: 90 };
    useLabStore.setState({ portfolioPositions: [existing] });
    const imported = await useLabStore.getState().importPortfolioItems([
      { symbol: "AAPL", name: "Apple Inc.", market: "NASDAQ", quantity: 2, averageCost: 100 },
      { symbol: "MSFT", name: "Microsoft", market: "NASDAQ", quantity: 1, averageCost: 300 },
    ]);
    expect(imported).toHaveLength(2);
    expect(useLabStore.getState().portfolioPositions).toMatchObject([
      { id: "p1", symbol: "AAPL", quantity: 2, averageCost: 100 },
      { symbol: "MSFT", quantity: 1, averageCost: 300 },
    ]);
  });

  it("rolls back portfolio imports when canonical persistence fails", async () => {
    const previous = [{ id: "p1", symbol: "AAPL", name: "Apple", market: "NASDAQ", quantity: 1, averageCost: 90 }];
    const error = new Error("disk full");
    useLabStore.setState({ portfolioPositions: previous });
    persistence.saveUserState.mockRejectedValueOnce(error);
    await expect(useLabStore.getState().importPortfolioItems([{ symbol: "MSFT", name: "Microsoft", market: "NASDAQ", quantity: 1, averageCost: 300 }])).rejects.toBe(error);
    expect(useLabStore.getState().portfolioPositions).toEqual(previous);
  });

  it("surfaces persistence failures and deduplicates a retry save", async () => {
    const error = new Error("Host unavailable");
    persistence.saveUserState.mockClear();
    persistence.saveUserState.mockRejectedValueOnce(error).mockResolvedValueOnce({
      revision: 2,
      watchlist: [{ symbol: "TSLA", name: "Tesla", market: "NASDAQ", category: "自选" }],
      monitorRules: [],
      notifications: [],
      portfolioPositions: [],
      monitorHistory: [],
      portfolioReviews: [],
    });

    await expect(useLabStore.getState().addWatchlist({ symbol: "TSLA", name: "Tesla", market: "NASDAQ" })).rejects.toBe(error);
    expect(useLabStore.getState().settingsNotice).toMatchObject({ type: "error", action: "retry" });

    const firstRetry = useLabStore.getState().retryPersistedUserState();
    const secondRetry = useLabStore.getState().retryPersistedUserState();
    await expect(Promise.all([firstRetry, secondRetry])).resolves.toEqual([true, false]);
    expect(persistence.saveUserState).toHaveBeenCalledTimes(2);
    expect(useLabStore.getState().settingsNotice).toEqual({ type: "success", text: "本地数据已保存" });
  });

  it("rolls back a newly added watchlist item when the canonical save fails", async () => {
    const previous = useLabStore.getState().watchlist;
    const error = new Error("disk full");
    persistence.saveUserState.mockRejectedValueOnce(error);

    await expect(useLabStore.getState().addWatchlist({ symbol: "TSLA", name: "Tesla", market: "NASDAQ" })).rejects.toBe(error);
    expect(useLabStore.getState().watchlist).toEqual(previous);
  });

  it("rolls back imported watchlist rows without removing a concurrent edit", async () => {
    const previous = useLabStore.getState().watchlist;
    const error = new Error("Host unavailable");
    persistence.saveUserState.mockImplementationOnce(async () => {
      useLabStore.setState((state) => ({ watchlist: [...state.watchlist, { symbol: "TSLA", name: "Tesla (edited)", market: "NASDAQ", category: "自选" }] }));
      throw error;
    });

    await expect(useLabStore.getState().importWatchlistItems([{ symbol: "TSLA", name: "Tesla", market: "NASDAQ" }])).rejects.toBe(error);
    expect(useLabStore.getState().watchlist).toEqual([...previous, { symbol: "TSLA", name: "Tesla (edited)", market: "NASDAQ", category: "自选" }]);
  });

  it("rolls back portfolio and monitor-rule additions when persistence fails", async () => {
    const error = new Error("disk full");
    persistence.saveUserState.mockRejectedValueOnce(error);
    await expect(useLabStore.getState().savePortfolioPosition({ symbol: "AAPL", name: "Apple", market: "NASDAQ", quantity: 2, averageCost: 100 })).rejects.toBe(error);
    expect(useLabStore.getState().portfolioPositions).toEqual([]);

    useLabStore.setState({ rules: [] });
    persistence.saveUserState.mockRejectedValueOnce(error);
    await expect(useLabStore.getState().addRule({ symbol: "600519", strategyId: "price_change" })).rejects.toBe(error);
    expect(useLabStore.getState().rules).toEqual([]);
  });

  it("rolls back briefing schedule edits when persistence fails", async () => {
    const previous = useLabStore.getState().briefingSchedule;
    const error = new Error("Host unavailable");
    persistence.saveUserState.mockRejectedValueOnce(error);

    await expect(useLabStore.getState().updateBriefingSchedule({ closeTime: "15:35" })).rejects.toBe(error);
    expect(useLabStore.getState().briefingSchedule).toEqual(previous);
  });

  it("rolls back optimistic alert mutations when the canonical save fails", async () => {
    const rule = { id: "persist-rule", symbol: "600519", strategyId: "price_change", threshold: 3, intervalSeconds: 300, enabled: true };
    useLabStore.setState({
      rules: [rule],
      notifications: [{ id: "persist-notification", title: "待保存消息", body: "内容", read: false }],
    });
    const error = new Error("disk full");

    persistence.saveUserState.mockRejectedValueOnce(error);
    await expect(useLabStore.getState().toggleRule(rule.id)).rejects.toBe(error);
    expect(useLabStore.getState().rules[0]).toEqual(rule);

    persistence.saveUserState.mockRejectedValueOnce(error);
    await expect(useLabStore.getState().markNotificationRead("persist-notification")).rejects.toBe(error);
    expect(useLabStore.getState().notifications[0].read).toBe(false);
  });

  it("clears only read notifications and persists the remaining inbox", async () => {
    useLabStore.setState({ notifications: [
      { id: "read-1", title: "已读", body: "旧消息", read: true, createdAt: "2026-09-05T01:00:00Z" },
      { id: "unread-1", title: "未读", body: "重要提醒", read: false, createdAt: "2026-09-05T02:00:00Z" },
      { id: "read-2", title: "已读 2", body: "旧消息 2", read: true, createdAt: "2026-09-05T00:00:00Z" },
    ] });
    persistence.saveUserState.mockClear();

    await expect(useLabStore.getState().clearReadNotifications()).resolves.toBe(2);
    expect(useLabStore.getState().notifications.map((item) => item.id)).toEqual(["unread-1"]);
    const savedState = persistence.saveUserState.mock.calls.at(-1)?.[0];
    expect(savedState.notifications).toEqual([expect.objectContaining({ id: "unread-1", read: false })]);
  });

  it("restores read notifications when cleanup persistence fails", async () => {
    const error = new Error("disk full");
    useLabStore.setState({ notifications: [
      { id: "read-1", title: "已读", body: "旧消息", read: true, createdAt: "2026-09-05T01:00:00Z" },
      { id: "unread-1", title: "未读", body: "重要提醒", read: false, createdAt: "2026-09-05T02:00:00Z" },
    ] });
    persistence.saveUserState.mockClear();
    persistence.saveUserState.mockRejectedValueOnce(error);

    await expect(useLabStore.getState().clearReadNotifications()).rejects.toBe(error);
    expect(useLabStore.getState().notifications.map((item) => item.id)).toEqual(["unread-1", "read-1"]);
  });

  it("does not send or retain event reminders that failed to persist", async () => {
    persistence.saveUserState.mockRejectedValueOnce(new Error("Host unavailable"));
    await expect(useLabStore.getState().notifyDueEventReminders([
      { id: "event-1", symbol: "600519", name: "贵州茅台", date: "2099-09-08", type: "财报", title: "财报披露" },
    ], new Date("2099-09-01T00:00:00Z"))).resolves.toBe(0);
    expect(useLabStore.getState().notifications).toEqual([]);
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

  it("clears stale quotes when the provider or channel changes", () => {
    useLabStore.setState({
      integrationStatus: { credentialConfigured: true, settings: { modelId: "model-a", modelGatewayBaseUrl: "https://gateway.example", capabilityBaseUrl: "https://data.example", dataChannel: "qveris-cap", dataProvider: "qveris_finance" } },
      liveQuotes: { AAPL: { price: 100 } },
      liveDataLastRefreshAt: "2026-08-28T08:00:00.000Z",
      quoteDetailsLoaded: { AAPL: true },
      quoteSeriesLoaded: { AAPL: { 日K: true } },
    });

    useLabStore.getState().setIntegrationStatus({ credentialConfigured: true, settings: { modelId: "model-a", modelGatewayBaseUrl: "https://gateway.example", capabilityBaseUrl: "https://data.example", dataChannel: "backup-cap", dataProvider: "backup_finance" } });

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

  it("does not run or persist monitor side effects without a real data connection", async () => {
    persistence.saveUserState.mockClear();
    useLabStore.setState({
      integrationStatus: null,
      userStateLoaded: true,
      rules: [{ id: "preview-rule", symbol: "600519", strategyId: "price_change", threshold: 3, intervalSeconds: 300, enabled: true, lastCheckedAt: null }],
      watchlist: [{ symbol: "600519", name: "贵州茅台", market: "沪深", category: "白酒" }],
    });

    await expect(useLabStore.getState().runMonitorCheck("preview-rule")).resolves.toBe(false);
    expect(runtime.queryCachedData).not.toHaveBeenCalled();
    expect(runtime.askPi).not.toHaveBeenCalled();
    expect(persistence.saveUserState).not.toHaveBeenCalled();
    expect(useLabStore.getState().monitorHistory).toHaveLength(0);
    expect(useLabStore.getState().notifications).toHaveLength(0);
    expect(useLabStore.getState().rules[0].lastCheckedAt).toBeNull();
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
    runtime.queryCachedData.mockResolvedValue({ data: { quotes: [{ symbol: "600519", price: 1310, changePercent: 4.2, asOf: freshAsOf(), source: "真实行情源" }] }, cacheHit: true, mode: "standalone-dev-host", audits: [] });

    await expect(useLabStore.getState().runMonitorCheck("rule-1")).resolves.toBe(true);
    expect(runtime.askPi).not.toHaveBeenCalled();
    expect(runtime.queryCachedData).toHaveBeenCalledOnce();
    expect(useLabStore.getState().notifications[0]).toMatchObject({ severity: "warning", source: "data-service" });
    expect(useLabStore.getState().notifications[0].body).toContain("+4.20%");
  });

  it("does not trigger a monitor alert from stale CAP data", async () => {
    useLabStore.setState({
      integrationStatus: { credentialConfigured: true, settings: { modelId: "model-a" } },
      userStateLoaded: true,
      rules: [{ id: "stale-rule", symbol: "600519", strategyId: "price_change", threshold: 3, intervalSeconds: 300, enabled: true, lastCheckedAt: null }],
      watchlist: [{ symbol: "600519", name: "贵州茅台", market: "沪深", category: "白酒" }],
    });
    runtime.queryCachedData.mockResolvedValue({ data: { quotes: [{ symbol: "600519", price: 1310, changePercent: 4.2, asOf: "2026-08-29T10:00:00Z", source: "真实行情源" }] }, cacheHit: true, mode: "standalone-dev-host", audits: [] });

    await expect(useLabStore.getState().runMonitorCheck("stale-rule")).resolves.toBe(true);
    expect(runtime.askPi).not.toHaveBeenCalled();
    expect(useLabStore.getState().notifications).toHaveLength(0);
    expect(useLabStore.getState().monitorHistory[0]).toMatchObject({ outcome: "unknown", triggered: null });
  });

  it("evaluates a cached corporate event directly without a model round trip", async () => {
    const eventAsOf = freshAsOf();
    useLabStore.setState({
      integrationStatus: { credentialConfigured: true, settings: { modelId: "model-a" } },
      userStateLoaded: true,
      rules: [{ id: "rule-event", symbol: "600519", strategyId: "news_risk", conditions: [{ type: "core_event", operator: "gte", value: 1 }], intervalSeconds: 300, enabled: true, lastCheckedAt: null }],
      watchlist: [{ symbol: "600519", name: "贵州茅台", market: "沪深", category: "白酒" }],
    });
    runtime.queryCachedData.mockResolvedValue({ data: { events: [{ date: "2026-09-01", title: "股东会" }], eventCount: 1, asOf: eventAsOf, source: "真实事件源" }, mode: "qveris-cap", audits: [{ operation: "cap-call", capability: "EVENT.CALENDAR.CORP" }] });

    await expect(useLabStore.getState().runMonitorCheck("rule-event")).resolves.toBe(true);
    expect(runtime.queryCachedData).toHaveBeenCalledWith({ kind: "core_event", symbol: "600519.SH" }, { timeoutMs: 60_000 });
    expect(runtime.askPi).not.toHaveBeenCalled();
    expect(useLabStore.getState().monitorHistory[0]).toMatchObject({ outcome: "triggered", triggered: true, conditionResults: [true], asOf: eventAsOf });
  });

  it("does not fall back to model Search after a monitor CAP authentication failure", async () => {
    useLabStore.setState({
      integrationStatus: { credentialConfigured: true, settings: { modelId: "model-a" } },
      userStateLoaded: true,
      rules: [{ id: "rule-auth", symbol: "600519", strategyId: "price_change", threshold: 3, intervalSeconds: 300, enabled: true, lastCheckedAt: null }],
      watchlist: [{ symbol: "600519", name: "贵州茅台", market: "沪深", category: "白酒" }],
    });
    const error = Object.assign(new Error("上游认证失败"), { status: 401 });
    runtime.queryCachedData.mockRejectedValue(error);

    await expect(useLabStore.getState().runMonitorCheck("rule-auth")).resolves.toBe(false);
    expect(runtime.queryCachedData).toHaveBeenCalledOnce();
    expect(runtime.askPi).not.toHaveBeenCalled();
    expect(useLabStore.getState().monitorHistory[0]).toMatchObject({ outcome: "error", symbol: "600519" });
    expect(useLabStore.getState().notifications[0].body).toContain("数据服务暂时繁忙");
    expect(useLabStore.getState().notifications[0].body).not.toContain("上游认证失败");
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

  it("keeps event source links on safe web protocols", async () => {
    useLabStore.setState({
      integrationStatus: { credentialConfigured: true, settings: { modelId: "" } },
      userStateLoaded: true,
      watchlist: [{ symbol: "600519", name: "贵州茅台", market: "沪深" }],
    });
    runtime.queryCachedData.mockResolvedValue({
      data: {
        events: [
          { date: "2026-09-01", type: "公告", title: "安全来源", url: "  https://example.com/notice  " },
          { date: "2026-09-02", type: "公告", title: "危险来源", url: "javascript:alert(document.domain)" },
          { date: "2026-09-03", type: "公告", title: "数据来源", url: "data:text/html,<script>alert(1)</script>" },
        ],
        source: "真实事件源",
      },
      mode: "qveris-cap",
      audits: [],
    });

    await expect(useLabStore.getState().refreshEvents()).resolves.toBe(true);
    expect(useLabStore.getState().events.map((event) => event.url)).toEqual(["https://example.com/notice", "", ""]);
  });

  it("cancels a slow event refresh without committing late results", async () => {
    let startedResolve;
    let requestSignal;
    const started = new Promise((resolve) => { startedResolve = resolve; });
    useLabStore.setState({
      integrationStatus: { credentialConfigured: true, settings: { modelId: "" } },
      userStateLoaded: true,
      events: [{ id: "existing", symbol: "600519", name: "贵州茅台", date: "2026-09-10", title: "已保存事件" }],
      watchlist: [{ symbol: "600519", name: "贵州茅台", market: "沪深" }],
    });
    runtime.queryCachedData.mockImplementation((_input, options = {}) => {
      requestSignal = options.signal;
      startedResolve();
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError", code: "ABORT_ERR" })), { once: true });
      });
    });

    const pending = useLabStore.getState().refreshEvents();
    await started;
    expect(useLabStore.getState().eventDataLoading).toBe(true);
    expect(useLabStore.getState().cancelEventsRefresh()).toBe(true);
    expect(requestSignal.aborted).toBe(true);
    expect(useLabStore.getState()).toMatchObject({ eventDataLoading: false, eventDataLoaded: true, eventDataError: "已停止本轮事件更新，可稍后重试" });
    expect(useLabStore.getState().events).toHaveLength(1);
    await expect(pending).resolves.toBe(false);
  });

  it("creates idempotent upcoming and same-day event reminders", async () => {
    const event = { id: "event-1", symbol: "600519", name: "贵州茅台", date: "2026-09-08", type: "股东会", title: "临时股东会", source: "真实事件源" };
    await expect(useLabStore.getState().notifyDueEventReminders([event], new Date("2026-09-03T01:00:00Z"))).resolves.toBe(1);
    expect(useLabStore.getState().notifications[0]).toMatchObject({ kind: "event", reminderPhase: "upcoming", eventKey: "600519|2026-09-08|股东会|临时股东会" });
    await expect(useLabStore.getState().notifyDueEventReminders([event], new Date("2026-09-03T02:00:00Z"))).resolves.toBe(0);
    await expect(useLabStore.getState().notifyDueEventReminders([event], new Date("2026-09-08T01:00:00Z"))).resolves.toBe(1);
    expect(useLabStore.getState().notifications.map((item) => item.reminderPhase)).toEqual(["same-day", "upcoming"]);
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
      ? { data: { capitalFlow: [{ date: "2026-08-29", mainNetInflow: 120 }], mainNetInflow: 120, asOf: freshAsOf(), source: "真实资金流" }, mode: "qveris-cap", audits: [] }
      : { data: { news: [{ title: "风险提示" }], sentiment: "negative", asOf: freshAsOf(), source: "真实舆情" }, mode: "qveris-cap", audits: [] });

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
    const quote = (changePercent) => ({ data: { quotes: [{ symbol: "600519", price: 1300, changePercent, asOf: freshAsOf(), source: "真实行情源" }] }, cacheHit: true, mode: "standalone-dev-host", audits: [] });
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

  it("auto-disables a single-trigger rule after its first real trigger", async () => {
    useLabStore.setState({
      integrationStatus: { credentialConfigured: true, settings: { modelId: "model-a" } },
      userStateLoaded: true,
      rules: [{ id: "once-rule", symbol: "600519", strategyId: "price_change", threshold: 3, intervalSeconds: 300, triggerMode: "once", enabled: true, lastCheckedAt: null }],
      watchlist: [{ symbol: "600519", name: "贵州茅台", market: "沪深", category: "白酒" }],
    });
    runtime.queryCachedData.mockResolvedValue({ data: { quotes: [{ symbol: "600519", price: 1300, changePercent: 4.2, asOf: freshAsOf(), source: "真实行情源" }] }, cacheHit: true, mode: "standalone-dev-host", audits: [] });

    await expect(useLabStore.getState().runMonitorCheck("once-rule")).resolves.toBe(true);
    expect(useLabStore.getState().rules[0]).toMatchObject({ triggerMode: "once", enabled: false, lastSignalTriggered: true });
    expect(useLabStore.getState().notifications).toHaveLength(1);
    await expect(useLabStore.getState().runMonitorCheck("once-rule")).resolves.toBe(false);
    expect(runtime.queryCachedData).toHaveBeenCalledTimes(1);
  });

  it("does not query or keep an expired rule enabled", async () => {
    useLabStore.setState({
      integrationStatus: { credentialConfigured: true, settings: { modelId: "model-a" } },
      userStateLoaded: true,
      rules: [{ id: "expired-rule", symbol: "600519", strategyId: "price_change", threshold: 3, intervalSeconds: 300, expiresAt: "2026-09-01T23:59:59.999Z", enabled: true, lastCheckedAt: null }],
      watchlist: [{ symbol: "600519", name: "贵州茅台", market: "沪深", category: "白酒" }],
    });

    await expect(useLabStore.getState().runMonitorCheck("expired-rule")).resolves.toBe(false);
    expect(useLabStore.getState().rules[0].enabled).toBe(false);
    expect(runtime.queryCachedData).not.toHaveBeenCalled();
  });

  it("reconciles expired rules before selecting a due background check", async () => {
    useLabStore.setState({
      integrationStatus: { credentialConfigured: true, settings: { modelId: "model-a" } },
      userStateLoaded: true,
      rules: [
        { id: "expired-rule", symbol: "600519", strategyId: "price_change", threshold: 3, intervalSeconds: 300, expiresAt: "2026-09-01T23:59:59.999Z", enabled: true, lastCheckedAt: null },
        { id: "active-rule", symbol: "300750", strategyId: "price_change", threshold: 3, intervalSeconds: 300, enabled: false, lastCheckedAt: null },
      ],
      watchlist: [{ symbol: "600519", name: "贵州茅台", market: "沪深", category: "白酒" }],
    });

    await expect(useLabStore.getState().runDueMonitorChecks()).resolves.toBe(false);
    expect(useLabStore.getState().rules[0].enabled).toBe(false);
    expect(persistence.saveUserState).toHaveBeenCalled();
    expect(runtime.queryCachedData).not.toHaveBeenCalled();
  });

  it("checks a dynamic watchlist rule independently and de-duplicates each symbol", async () => {
    useLabStore.setState({
      integrationStatus: { credentialConfigured: true, settings: { modelId: "model-a" } },
      userStateLoaded: true,
      rules: [{ id: "watchlist-rule", scope: "watchlist", symbol: "*", strategyId: "price_change", threshold: 3, intervalSeconds: 300, enabled: true, lastCheckedAt: null }],
      watchlist: [
        { symbol: "600519", name: "贵州茅台", market: "沪深", category: "白酒" },
        { symbol: "AAPL", name: "Apple", market: "NASDAQ", category: "科技" },
      ],
    });
    runtime.queryCachedData
      .mockResolvedValueOnce({ data: { quotes: [{ symbol: "600519", price: 1300, changePercent: 4.2, asOf: freshAsOf(), source: "真实行情源" }] }, cacheHit: true, mode: "standalone-dev-host", audits: [] })
      .mockResolvedValueOnce({ data: { quotes: [{ symbol: "AAPL", price: 200, changePercent: 1.2, asOf: freshAsOf(), source: "真实行情源" }] }, cacheHit: true, mode: "standalone-dev-host", audits: [] });

    await expect(useLabStore.getState().runMonitorCheck("watchlist-rule")).resolves.toBe(true);
    expect(runtime.queryCachedData).toHaveBeenCalledTimes(2);
    expect(useLabStore.getState().notifications).toHaveLength(1);
    expect(useLabStore.getState().notifications[0]).toMatchObject({ symbol: "600519" });
    expect(useLabStore.getState().rules[0].lastSignalBySymbol).toEqual({ "600519": true, AAPL: false });
    expect(useLabStore.getState().monitorHistory.map((entry) => entry.symbol)).toEqual(["600519", "AAPL"]);

    runtime.queryCachedData
      .mockResolvedValueOnce({ data: { quotes: [{ symbol: "600519", price: 1300, changePercent: 4.2, asOf: freshAsOf(), source: "真实行情源" }] }, cacheHit: true, mode: "standalone-dev-host", audits: [] })
      .mockResolvedValueOnce({ data: { quotes: [{ symbol: "AAPL", price: 200, changePercent: 1.2, asOf: freshAsOf(), source: "真实行情源" }] }, cacheHit: true, mode: "standalone-dev-host", audits: [] });
    await expect(useLabStore.getState().runMonitorCheck("watchlist-rule")).resolves.toBe(true);
    expect(useLabStore.getState().notifications).toHaveLength(1);
  });

  it("keeps an auditable monitor timeline for triggered checks", async () => {
    useLabStore.setState({
      integrationStatus: { credentialConfigured: true, settings: { modelId: "model-a" } },
      userStateLoaded: true,
      rules: [{ id: "rule-1", symbol: "600519", strategyId: "price_change", threshold: 3, intervalSeconds: 300, enabled: true, lastCheckedAt: null }],
      watchlist: [{ symbol: "600519", name: "贵州茅台", market: "沪深", category: "白酒" }],
    });
    const historyAsOf = freshAsOf();
    runtime.queryCachedData.mockResolvedValue({ data: { quotes: [{ symbol: "600519", price: 1310, changePercent: 4.2, asOf: historyAsOf, source: "真实行情源" }] }, cacheHit: true, mode: "standalone-dev-host", audits: [{ operation: "cached-call", outcome: "success", toolId: "qveris_finance.mkt_l1_rt" }] });

    await expect(useLabStore.getState().runMonitorCheck("rule-1")).resolves.toBe(true);
    expect(useLabStore.getState().monitorHistory[0]).toMatchObject({ ruleId: "rule-1", symbol: "600519", outcome: "triggered", triggered: true, source: "data-service", asOf: historyAsOf, conditionResults: [true] });
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

  it("cancels obsolete quote detail requests when the selected symbol changes", async () => {
    useLabStore.setState({
      integrationStatus: { credentialConfigured: true, settings: { modelId: "model-a" } },
      userStateLoaded: true,
      liveDataLastRefreshAt: "2026-08-28T08:00:00.000Z",
      watchlist: [{ symbol: "600519", name: "贵州茅台", market: "沪深" }, { symbol: "AAPL", name: "Apple", market: "NASDAQ" }],
    });
    const signals = [];
    let resolveLatest;
    runtime.askPi.mockImplementation((_prompt, options = {}) => {
      signals.push(options.signal);
      if (signals.length === 1) return new Promise((_resolve, reject) => options.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError", code: "ABORT_ERR" }))));
      return new Promise((resolve) => { resolveLatest = resolve; });
    });

    const obsolete = useLabStore.getState().refreshQuoteDetails("600519");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const replacement = useLabStore.getState().refreshQuoteDetails("AAPL");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(signals[0]?.aborted).toBe(true);
    resolveLatest({ text: JSON.stringify({ companyDescription: "真实公司简介" }), mode: "pi-local-host", audits: [] });
    await expect(obsolete).resolves.toBe(false);
    expect(useLabStore.getState().quoteDetailsLoading["600519"]).toBe(false);
    await expect(replacement).resolves.toBe(true);
    expect(useLabStore.getState().liveQuotes.AAPL.companyDescription).toBe("真实公司简介");
  });

  it("cancels obsolete chart ranges and releases their loading state", async () => {
    useLabStore.setState({
      integrationStatus: { credentialConfigured: true, settings: { modelId: "model-a" } },
      userStateLoaded: true,
      liveDataLastRefreshAt: "2026-08-28T08:00:00.000Z",
      quoteDetailsLoaded: { "600519": true },
      watchlist: [{ symbol: "600519", name: "贵州茅台", market: "沪深" }],
    });
    const signals = [];
    let resolveLatest;
    runtime.queryCachedData.mockImplementation((_input, options = {}) => {
      signals.push(options.signal);
      if (signals.length === 1) return new Promise((_resolve, reject) => options.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError", code: "ABORT_ERR" }))));
      return new Promise((resolve) => { resolveLatest = resolve; });
    });

    const obsolete = useLabStore.getState().refreshQuoteSeries("600519", "日K");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const replacement = useLabStore.getState().refreshQuoteSeries("600519", "周K");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(signals[0]?.aborted).toBe(true);
    expect(useLabStore.getState().quoteSeriesLoading["600519"]["日K"]).toBe(false);
    resolveLatest({ data: { series: [{ time: "2026-08-28", close: 1297.4 }] }, mode: "pi-local-host", audits: [] });
    await expect(obsolete).resolves.toBe(false);
    await expect(replacement).resolves.toBe(true);
    expect(useLabStore.getState().quoteSeriesLoaded["600519"]["周K"]).toBe(true);
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

  it("normalizes a multi-layer native CAP series envelope", async () => {
    useLabStore.setState({
      integrationStatus: { credentialConfigured: true, settings: { modelId: "" } },
      userStateLoaded: true,
      liveDataLastRefreshAt: "2026-08-28T08:00:00.000Z",
      quoteDetailsLoaded: { "600519": true },
      watchlist: [{ symbol: "600519", name: "贵州茅台", market: "沪深", category: "白酒" }],
    });
    runtime.queryCachedData.mockResolvedValue({
      data: { result: { payload: { data: { bars: [{ date: "2026-09-04", close: 1297.4, volume: 1612600 }] } } } },
      mode: "qveris-cap",
      audits: [],
    });

    await expect(useLabStore.getState().refreshQuoteSeries("600519", "日K")).resolves.toBe(true);
    expect(useLabStore.getState().liveQuotes["600519"].seriesByRange["日K"]).toEqual([
      expect.objectContaining({ date: "2026-09-04", close: 1297.4 }),
    ]);
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
