import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.jsx";
import { CopilotPanel } from "./components/CopilotPanel.jsx";
import { EventsView, MarketView, NotificationsView, PortfolioView, ResearchView, installedSkillIdsForBackup } from "./components/SecondaryViews.jsx";
import { WatchlistSidebar } from "./components/WatchlistSidebar.jsx";
import { StockWorkspace } from "./components/StockWorkspace.jsx";
import { initialLabState, useLabStore } from "./store/useLabStore.js";

const originalCancelMessage = useLabStore.getState().cancelMessage;
const originalHydrateUserState = useLabStore.getState().hydrateUserState;
const integrationMocks = vi.hoisted(() => ({
  applyIntegrationSettings: vi.fn(),
  loadIntegrationStatus: vi.fn(),
  queryCapabilityData: vi.fn(),
}));

vi.mock("lightweight-charts", () => ({
  AreaSeries: {},
  HistogramSeries: {},
  LineSeries: {},
  createChart: () => ({
    addSeries: () => ({ setData: vi.fn(), priceScale: () => ({ applyOptions: vi.fn() }) }),
    timeScale: () => ({ fitContent: vi.fn() }),
    remove: vi.fn(),
  }),
}));

vi.mock("./lib/integrations.js", async (importOriginal) => ({
  ...await importOriginal(),
  applyIntegrationSettings: integrationMocks.applyIntegrationSettings,
  loadIntegrationStatus: integrationMocks.loadIntegrationStatus,
  queryCapabilityData: integrationMocks.queryCapabilityData,
}));

// App flow tests exercise the browser preview. Local Host behavior is covered
// by the dedicated user-state and Local Host integration suites.
vi.mock("./lib/localHost.js", async (importOriginal) => ({
  ...await importOriginal(),
  isLocalWebRuntime: () => false,
}));

afterEach(cleanup);

beforeEach(() => {
  integrationMocks.applyIntegrationSettings.mockReset();
  integrationMocks.queryCapabilityData.mockReset();
  integrationMocks.loadIntegrationStatus.mockReset().mockResolvedValue({
    credentialConfigured: false,
    settings: {
      capabilityBaseUrl: "https://qveris.ai/api/v1",
      modelGatewayBaseUrl: "https://aigateway.qveris.ai/v1",
      modelId: "",
      models: [],
    },
    demo: true,
  });
  useLabStore.setState({
    ...initialLabState,
    skillItems: initialLabState.skillItems.map((item) => ({ ...item })),
    messages: initialLabState.messages.map((message) => ({ ...message })),
    rules: initialLabState.rules.map((rule) => ({ ...rule })),
    cancelMessage: originalCancelMessage,
    hydrateUserState: originalHydrateUserState,
  });
});

describe("FolioMind core flows", () => {
  it("shows a recoverable notice when canonical user state cannot be read", async () => {
    const retryHydration = vi.fn().mockResolvedValue(true);
    useLabStore.setState({ userStateLoaded: false, userStateError: "本地数据暂时无法读取；请检查本地 Host 后重试", userStateLoading: false, hydrateUserState: retryHydration });

    render(<App />);
    expect(screen.getByRole("alert")).toHaveTextContent("本地数据暂时无法读取");
    fireEvent.click(screen.getByRole("button", { name: "重新读取本地数据" }));
    expect(retryHydration).toHaveBeenCalled();
  });

  it("does not call an unhydrated data connection browser preview", () => {
    useLabStore.setState({
      ...initialLabState,
      userStateLoaded: true,
      integrationStatus: null,
      integrationStatusLoading: true,
      integrationStatusError: "",
    });
    render(<StockWorkspace />);
    expect(screen.getAllByText("正在读取数据连接").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("正在读取本地 Host 配置，不会使用示例行情")).toBeInTheDocument();
    expect(screen.queryByText("预览模式")).not.toBeInTheDocument();
  });

  it("guides first-run setup without inventing a quote or background alert", () => {
    useLabStore.setState({
      ...initialLabState,
      userStateLoaded: true,
      integrationStatusLoading: false,
      integrationStatusError: "",
      integrationStatus: { credentialConfigured: false, settings: { modelId: "" }, demo: true },
      liveQuotes: {},
      rules: [],
    });
    render(<StockWorkspace />);
    expect(screen.getByRole("region", { name: "开始使用 FolioMind" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "先连接数据，再开始研究" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "开始使用 FolioMind" }).querySelectorAll("button")).toHaveLength(2);
    expect(screen.getByText(/不会用演示数据代替/)).toBeInTheDocument();
  });

  it("switches watchlist symbols and chart ranges", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /宁德时代/ }));
    expect(screen.getByRole("heading", { name: /宁德时代/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "5日" }));
    expect(screen.getByRole("button", { name: "5日" })).toHaveClass("active");
  });

  it("makes stock header actions functional", async () => {
    render(<App />);
    expect(screen.getByRole("button", { name: "取消收藏" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "取消收藏" }));
    await waitFor(() => expect(useLabStore.getState().watchlist.some((item) => item.symbol === "600519")).toBe(false));
    useLabStore.setState({ selectedSymbol: "600519" });
    const addButton = await screen.findByRole("button", { name: "收藏" });
    expect(addButton).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(addButton);
    await waitFor(() => expect(useLabStore.getState().watchlist.some((item) => item.symbol === "600519")).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "更多" }));
    expect(screen.getByRole("menu", { name: "更多操作" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "打开盯盘" }));
    expect(screen.getByRole("heading", { name: "个股盯盘" })).toBeInTheDocument();
    useLabStore.setState({ activeView: "watchlist", selectedSymbol: "600519" });
    expect(await screen.findByRole("button", { name: "图表设置" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "图表设置" }));
    expect(screen.getByRole("group", { name: "图表设置" })).toBeInTheDocument();
    const movingAverage = screen.getByRole("checkbox", { name: "显示 MA5" });
    expect(movingAverage).not.toBeChecked();
    fireEvent.click(movingAverage);
    expect(movingAverage).toBeChecked();
  });

  it("offers editable quick prompts in the copilot composer", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "快捷指令" }));
    expect(screen.getByRole("menu", { name: "快捷指令" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "最新行情" }));
    expect(screen.getByRole("textbox", { name: "分析问题" })).toHaveValue("查询当前标的的最新真实行情、数据截至时间和来源。");
    expect(screen.queryByRole("menu", { name: "快捷指令" })).not.toBeInTheDocument();
  });

  it("explains why chat waits while the real quote batch is refreshing", () => {
    useLabStore.setState({ liveDataLoading: true });
    render(<CopilotPanel standalone />);
    const composer = screen.getByRole("textbox", { name: "分析问题" });
    expect(composer).toBeDisabled();
    expect(composer).toHaveAttribute("placeholder", "正在更新行情，完成后可发起分析…");
    expect(screen.getByRole("button", { name: "等待行情更新" })).toBeDisabled();
  });

  it("organizes the watchlist by group and keeps empty real quotes honest", () => {
    render(<WatchlistSidebar />);
    expect(screen.getByRole("region", { name: "A 股自选" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "美股自选" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "自选分组" }), { target: { value: "美股" } });
    expect(screen.getByText("Apple Inc.")).toBeInTheDocument();
    expect(screen.queryByText("贵州茅台")).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "自选排序" }), { target: { value: "change" } });
    expect(screen.getByRole("button", { name: "切换为降序" })).toBeInTheDocument();
  });

  it("imports a watchlist file through the sidebar tools", async () => {
    render(<WatchlistSidebar />);
    fireEvent.click(screen.getByRole("button", { name: "自选工具" }));
    expect(screen.getByRole("menuitem", { name: /导入 CSV/ })).toBeInTheDocument();
    const file = new File(["代码,名称,市场,分类,分组\n000001,平安银行,A股,银行,核心"], "watchlist.csv", { type: "text/csv" });
    fireEvent.change(screen.getByLabelText("导入自选文件"), { target: { files: [file] } });
    await waitFor(() => expect(useLabStore.getState().watchlist.some((item) => item.symbol === "000001")).toBe(true));
    expect(await screen.findByRole("status")).toHaveTextContent(/已导入 1 个标的/);
  });

  it("opens the real-data research screener with an honest empty state", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "筛选" }));
    expect(screen.getByRole("heading", { name: "研究筛选" })).toBeInTheDocument();
    expect(screen.getByText("连接真实数据后开始")).toBeInTheDocument();
    expect(screen.getByText(/不会使用示例行情填充/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "搜索标的" })).toBeInTheDocument();
  });

  it("lets users customize market columns without inventing missing values", () => {
    window.localStorage.removeItem("foliomind.market-columns.v1");
    useLabStore.setState({ activeView: "market", integrationStatus: { credentialConfigured: false, settings: { modelId: "" }, demo: true } });
    render(<MarketView />);
    expect(screen.getByText("市盈率", { selector: ".table-head span" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "列设置" }));
    expect(screen.getByRole("group", { name: "自选行情列设置" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "市盈率" }));
    expect(screen.queryByText("市盈率", { selector: ".table-head span" })).not.toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    expect(JSON.parse(window.localStorage.getItem("foliomind.market-columns.v1"))).not.toContain("pe");
  });

  it("renders returned real quotes in the market table", () => {
    window.localStorage.removeItem("foliomind.market-columns.v1");
    useLabStore.setState({
      activeView: "market",
      integrationStatus: { credentialConfigured: true, settings: { modelId: "" }, demo: false },
      watchlist: [{ symbol: "600519", name: "贵州茅台", market: "沪深" }],
      liveQuotes: { "600519": { price: 1297.4, change: 1.25, pe: 27.6, pb: 8.2, asOf: "2026-08-31T08:00:00Z" } },
    });
    const { container } = render(<MarketView />);
    const row = container.querySelector(".market-table .table-row");
    expect(row).toHaveTextContent("1,297.40");
    expect(row).toHaveTextContent("+1.25%");
    expect(row).toHaveTextContent("27.6");
    expect(row).toHaveTextContent("8.2");
  });

  it("keeps a market overview quote neutral when change is missing and opens its detail", () => {
    useLabStore.setState({
      activeView: "market",
      selectedSymbol: "",
      integrationStatus: { credentialConfigured: true, settings: { modelId: "" }, demo: false },
      watchlist: [{ symbol: "600519", name: "贵州茅台", market: "沪深" }],
      liveQuotes: { "600519": { price: 1297.4, asOf: "2026-08-31T08:00:00Z" } },
    });
    const { container } = render(<MarketView />);
    const card = container.querySelector(".index-board-item");
    expect(card).toHaveAttribute("role", "button");
    expect(card).not.toHaveClass("up");
    expect(card).not.toHaveClass("down");
    expect(card).toHaveTextContent("—");
    fireEvent.keyDown(card, { key: "Tab" });
    expect(useLabStore.getState()).toMatchObject({ activeView: "market", selectedSymbol: "" });
    fireEvent.click(card);
    expect(useLabStore.getState()).toMatchObject({ activeView: "watchlist", selectedSymbol: "600519" });
    useLabStore.setState({ activeView: "market", selectedSymbol: "" });
    fireEvent.keyDown(card, { key: "Enter" });
    expect(useLabStore.getState()).toMatchObject({ activeView: "watchlist", selectedSymbol: "600519" });
    useLabStore.setState({ activeView: "market", selectedSymbol: "" });
    fireEvent.keyDown(card, { key: " " });
    expect(useLabStore.getState()).toMatchObject({ activeView: "watchlist", selectedSymbol: "600519" });
  });

  it("opens a market table symbol with mouse and keyboard", () => {
    useLabStore.setState({ activeView: "market", selectedSymbol: "", integrationStatus: { credentialConfigured: true, settings: { modelId: "" }, demo: false }, watchlist: [{ symbol: "600519", name: "贵州茅台", market: "沪深" }], liveQuotes: { "600519": { price: 1297.4 } } });
    const { container } = render(<MarketView />);
    const row = container.querySelector(".market-table-row");
    expect(row).toHaveAttribute("role", "button");
    fireEvent.keyDown(row, { key: "ArrowDown" });
    expect(useLabStore.getState()).toMatchObject({ activeView: "market", selectedSymbol: "" });
    fireEvent.click(row);
    expect(useLabStore.getState()).toMatchObject({ activeView: "watchlist", selectedSymbol: "600519" });
    useLabStore.setState({ activeView: "market", selectedSymbol: "" });
    fireEvent.keyDown(row, { key: "Enter" });
    expect(useLabStore.getState()).toMatchObject({ activeView: "watchlist", selectedSymbol: "600519" });
    useLabStore.setState({ activeView: "market", selectedSymbol: "" });
    fireEvent.keyDown(row, { key: " " });
    expect(useLabStore.getState()).toMatchObject({ activeView: "watchlist", selectedSymbol: "600519" });
  });

  it("does not classify missing changes as advancing in the research filter", () => {
    useLabStore.setState({
      activeView: "research",
      integrationStatus: { credentialConfigured: true, settings: { modelId: "" }, demo: false },
      watchlist: [
        { symbol: "UP", name: "上涨标的", market: "沪深" },
        { symbol: "MISSING", name: "待更新", market: "沪深" },
        { symbol: "DOWN", name: "下跌标的", market: "沪深" },
      ],
      liveQuotes: {
        UP: { price: 10, change: 2.1 },
        MISSING: { price: 20 },
        DOWN: { price: 30, change: -1.4 },
      },
    });
    render(<ResearchView />);
    fireEvent.click(screen.getByRole("button", { name: "上涨" }));
    const table = screen.getByRole("region", { name: "真实行情筛选结果" });
    expect(table).toHaveTextContent("上涨标的");
    expect(table).not.toHaveTextContent("待更新");
    expect(table).not.toHaveTextContent("下跌标的");
  });

  it("opens a research result with mouse and keyboard", () => {
    useLabStore.setState({ activeView: "research", selectedSymbol: "", integrationStatus: { credentialConfigured: true, settings: { modelId: "" }, demo: false }, watchlist: [{ symbol: "600519", name: "贵州茅台", market: "沪深" }], liveQuotes: { "600519": { price: 1297.4, change: 1.25 } } });
    const { container } = render(<ResearchView />);
    const row = container.querySelector(".research-row");
    expect(row).toHaveAttribute("role", "button");
    fireEvent.keyDown(row, { key: "Escape" });
    expect(useLabStore.getState()).toMatchObject({ activeView: "research", selectedSymbol: "" });
    fireEvent.click(row);
    expect(useLabStore.getState()).toMatchObject({ activeView: "watchlist", selectedSymbol: "600519" });
    useLabStore.setState({ activeView: "research", selectedSymbol: "" });
    fireEvent.keyDown(row, { key: "Enter" });
    expect(useLabStore.getState()).toMatchObject({ activeView: "watchlist", selectedSymbol: "600519" });
    useLabStore.setState({ activeView: "research", selectedSymbol: "" });
    fireEvent.keyDown(row, { key: " " });
    expect(useLabStore.getState()).toMatchObject({ activeView: "watchlist", selectedSymbol: "600519" });
  });

  it("keeps a flat real quote visually neutral in the watchlist", () => {
    useLabStore.setState({
      integrationStatus: { credentialConfigured: true, settings: { modelId: "" }, demo: false },
      watchlist: [{ symbol: "FLAT", name: "平盘标的", market: "沪深" }],
      selectedSymbol: "FLAT",
      liveQuotes: { FLAT: { price: 10, change: 0 } },
    });
    const { container } = render(<WatchlistSidebar />);
    const quote = container.querySelector(".watch-row .quote");
    expect(quote).not.toHaveClass("up");
    expect(quote).not.toHaveClass("down");
  });

  it("saves and restores named market views without changing the data contract", () => {
    window.localStorage.removeItem("foliomind.market-columns.v1");
    window.localStorage.removeItem("foliomind.market-views.v1");
    useLabStore.setState({ activeView: "market", integrationStatus: { credentialConfigured: false, settings: { modelId: "" }, demo: true } });
    render(<MarketView />);
    fireEvent.click(screen.getByRole("button", { name: "列设置" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "市盈率" }));
    fireEvent.click(screen.getByRole("button", { name: "保存视图" }));
    fireEvent.change(screen.getByRole("textbox", { name: "视图名称" }), { target: { value: "我的交易盘面" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(screen.getByText("已保存“我的交易盘面”视图", { selector: ".market-view-notice" })).toBeInTheDocument();
    const selector = screen.getByRole("combobox", { name: "行情视图" });
    expect(selector.value).toMatch(/^custom-/);
    fireEvent.change(selector, { target: { value: "valuation" } });
    expect(screen.getByText("市盈率", { selector: ".table-head span" })).toBeInTheDocument();
    fireEvent.change(selector, { target: { value: selector.options[selector.options.length - 1].value } });
    expect(screen.queryByText("市盈率", { selector: ".table-head span" })).not.toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem("foliomind.market-views.v1"))).toHaveLength(1);
  });

  it("ignores malformed named market views and keeps built-in presets available", () => {
    window.localStorage.removeItem("foliomind.market-columns.v1");
    window.localStorage.setItem("foliomind.market-views.v1", JSON.stringify([
      { id: "custom-invalid", name: "坏视图", columns: ["unknown-field"] },
      { id: "custom-valid", name: "合法视图", columns: ["price"] },
    ]));
    useLabStore.setState({ activeView: "market", integrationStatus: { credentialConfigured: false, settings: { modelId: "" }, demo: true } });
    render(<MarketView />);
    const options = screen.getByRole("combobox", { name: "行情视图" }).querySelectorAll("option");
    expect([...options].map((option) => option.textContent)).toEqual(["核心估值", "交易盘面", "完整字段", "合法视图"]);
  });

  it("shows a source-backed anomaly explanation without changing the quote card", () => {
    window.localStorage.removeItem("foliomind.market-columns.v1");
    const asOf = new Date(Date.now() - 60_000).toISOString();
    useLabStore.setState({
      activeView: "market",
      integrationStatus: { credentialConfigured: true, settings: { modelId: "model-a" }, demo: false },
      watchlist: [{ symbol: "600519", name: "贵州茅台", market: "沪深", category: "白酒" }],
      liveQuotes: { "600519": { price: 1_300, change: 8.2, volumeRatio: 3.1, asOf, source: "真实 CAP" } },
      anomalyAttributions: { "600519:price": { fact: "涨幅超过阈值", portfolioRelation: "不在持仓中", drivers: [{ text: "已验证公告", references: [{ id: "news-1", title: "公司公告", source: "交易所", url: "https://example.com/news" }] }], watchNext: ["核验公告原文"], asOf: "2026-08-31", evidenceCount: 2, disclaimer: "解读仅基于已返回的真实数据，不构成投资建议或交易指令。" } },
    });
    render(<MarketView />);
    expect(screen.getAllByRole("button", { name: "AI 解读" })).toHaveLength(1);
    expect(screen.getByText("涨幅超过阈值")).toBeInTheDocument();
  });

  it("summarizes watchlist breadth from priced real quotes only", () => {
    useLabStore.setState({
      activeView: "market",
      integrationStatus: { credentialConfigured: true, settings: { modelId: "model-a" }, demo: false },
      watchlist: [{ symbol: "AAA", name: "上涨标的", market: "沪深" }, { symbol: "BBB", name: "下跌标的", market: "沪深" }, { symbol: "CCC", name: "待更新", market: "沪深" }],
      liveQuotes: { AAA: { price: 10, change: 3.4, asOf: new Date(Date.now() - 60_000).toISOString(), source: "真实 CAP" }, BBB: { price: 20, change: -1.2, asOf: new Date(Date.now() - 60_000).toISOString(), source: "真实 CAP" }, CCC: { change: 8 } },
    });
    render(<MarketView />);
    const breadth = screen.getByRole("region", { name: "自选市场宽度" });
    expect(breadth).toHaveTextContent("2/3 有行情");
    expect(breadth).toHaveTextContent("上涨");
    expect(breadth).toHaveTextContent("下跌");
    expect(breadth).toHaveTextContent("3.40%");
    expect(breadth).toHaveTextContent("另有 1 个标的暂未返回有效价格");
  });

  it("does not treat zero or negative prices as returned real quotes", () => {
    useLabStore.setState({
      activeView: "market",
      integrationStatus: { credentialConfigured: true, settings: { modelId: "model-a" }, demo: false },
      watchlist: [{ symbol: "ZERO", name: "零值行情", market: "沪深" }, { symbol: "NEG", name: "负值行情", market: "沪深" }, { symbol: "VALID", name: "有效行情", market: "沪深" }],
      liveQuotes: { ZERO: { price: 0, change: 2 }, NEG: { price: -1, change: -2 }, VALID: { price: 10, change: 1, asOf: new Date(Date.now() - 60_000).toISOString(), source: "真实 CAP" } },
    });
    render(<MarketView />);
    const breadth = screen.getByRole("region", { name: "自选市场宽度" });
    expect(breadth).toHaveTextContent("1/3 有行情");
    expect(breadth).toHaveTextContent("另有 2 个标的暂未返回有效价格");
  });

  it("shows field-level watchlist summary statistics from current real quotes", () => {
    window.localStorage.removeItem("foliomind.market-columns.v1");
    useLabStore.setState({
      activeView: "market",
      integrationStatus: { credentialConfigured: true, settings: { modelId: "model-a" }, demo: false },
      watchlist: [{ symbol: "AAA", name: "甲", market: "沪深" }, { symbol: "BBB", name: "乙", market: "沪深" }, { symbol: "CCC", name: "丙", market: "沪深" }],
      liveQuotes: {
        AAA: { price: 10, change: 1, volume: 100, pe: 8, asOf: new Date(Date.now() - 60_000).toISOString() },
        BBB: { price: 20, change: -1, volume: 300, pe: 12, asOf: new Date(Date.now() - 60_000).toISOString() },
        CCC: { price: 30, change: 3, volume: 200, asOf: new Date(Date.now() - 60_000).toISOString() },
      },
    });
    render(<MarketView />);
    const summary = screen.getByRole("region", { name: "自选汇总统计" });
    expect(summary).toHaveTextContent("3/3 个标的");
    expect(summary).toHaveTextContent("最新价");
    expect(summary).toHaveTextContent("最小");
    expect(summary).toHaveTextContent("平均");
    expect(summary).toHaveTextContent("中位");
    expect(summary).toHaveTextContent("最大");
    expect(summary).toHaveTextContent("10.00");
    expect(summary).toHaveTextContent("20.00");
    expect(summary).toHaveTextContent("30.00");
    expect(summary).toHaveTextContent("8.00");
  });

  it("retries the events request after the background quote refresh settles", async () => {
    const refreshEvents = vi.fn().mockResolvedValue(false);
    useLabStore.setState({
      activeView: "events",
      integrationStatus: { credentialConfigured: true, settings: { modelId: "model-a" } },
      eventDataLoaded: false,
      eventDataLoading: false,
      liveDataLoading: true,
      refreshEvents,
    });
    render(<EventsView />);
    expect(refreshEvents).not.toHaveBeenCalled();
    act(() => useLabStore.setState({ liveDataLoading: false }));
    await waitFor(() => expect(refreshEvents).toHaveBeenCalledOnce());
  });

  it("filters notifications and links a message back to its symbol", () => {
    useLabStore.setState({
      activeView: "notifications",
      notifications: [
        { id: "n-monitor", kind: "monitor", symbol: "300750", name: "宁德时代", title: "宁德时代 · 突破提醒", body: "真实数据触发条件", severity: "warning", createdAt: "2026-08-30T08:00:00Z", read: false, source: "data-service" },
        { id: "n-portfolio", kind: "portfolio-alert", symbol: "600519", name: "贵州茅台", title: "贵州茅台 · 止盈价已到达", body: "当前真实价格", severity: "critical", createdAt: "2026-08-30T07:00:00Z", read: true, source: "data-service" },
      ],
    });
    render(<NotificationsView />);
    expect(screen.getByLabelText("1 条未读消息")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "未读" }));
    expect(screen.getByText("宁德时代 · 突破提醒")).toBeInTheDocument();
    expect(screen.queryByText("贵州茅台 · 止盈价已到达")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看标的" }));
    expect(useLabStore.getState().selectedSymbol).toBe("300750");
    expect(useLabStore.getState().activeView).toBe("watchlist");
    expect(useLabStore.getState().notifications[0].read).toBe(true);
  });

  it("opens Skills and toggles install state", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /^技能$/ }));
    expect(screen.getByRole("heading", { name: "Skill 市场" })).toBeInTheDocument();
    const install = screen.getAllByRole("button", { name: "安装" })[0];
    fireEvent.click(install);
    await waitFor(() => expect(screen.getAllByRole("button", { name: "已安装" }).length).toBeGreaterThan(2));
  });

  it("filters Skills by name and reports an empty result", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /^技能$/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "搜索 Skills" }), { target: { value: "组合风险" } });
    expect(screen.getByRole("heading", { name: "组合风险" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "宏观日历" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "搜索 Skills" }), { target: { value: "不存在的能力" } });
    expect(screen.getByRole("status")).toHaveTextContent("没有匹配");
  });

  it("creates and toggles a monitor rule", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /盯盘/ }));
    fireEvent.click(screen.getByRole("button", { name: /新建盯盘/ }));
    expect(screen.getByText("触发条件")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "条件1类型" })).toHaveValue("price_change");
    expect(screen.getByRole("combobox", { name: "条件组合逻辑" })).toHaveValue("AND");
  });

  it("creates a dynamic watchlist monitor rule", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /盯盘/ }));
    fireEvent.click(screen.getByRole("button", { name: /新建盯盘/ }));
    fireEvent.change(screen.getByRole("combobox", { name: "监控范围" }), { target: { value: "watchlist" } });
    expect(screen.getByText(/将检查当前自选中的 8 个标的/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "保存并启用" }));
    await waitFor(() => expect(useLabStore.getState().rules.some((rule) => rule.scope === "watchlist" && rule.symbol === "*")).toBe(true));
    expect(screen.getByText(/整个自选（动态）/)).toBeInTheDocument();
  });

  it("builds an OR rule from multiple real-data conditions", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /盯盘/ }));
    fireEvent.click(screen.getByRole("button", { name: /新建盯盘/ }));
    fireEvent.click(screen.getByRole("button", { name: "添加条件" }));
    fireEvent.change(screen.getByRole("combobox", { name: "条件组合逻辑" }), { target: { value: "OR" } });
    fireEvent.change(screen.getByRole("combobox", { name: "条件2类型" }), { target: { value: "volume_spike" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "条件2数值" }), { target: { value: "2.5" } });
    fireEvent.click(screen.getByRole("button", { name: "保存并启用" }));
    await waitFor(() => expect(useLabStore.getState().rules.at(-1)).toMatchObject({ logic: "OR", conditions: [{ type: "price_change" }, { type: "volume_spike", value: 2.5 }] }));
    expect(screen.getAllByText(/涨跌幅/).length).toBeGreaterThan(0);
  });

  it("adds a portfolio position and keeps missing live quotes empty", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "组合" }));
    expect(screen.getByRole("heading", { name: "投资组合" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "添加第一笔持仓" }));
    fireEvent.change(screen.getByLabelText("持仓数量"), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText("平均成本"), { target: { value: "100" } });
    fireEvent.click(screen.getByRole("button", { name: "保存持仓" }));
    expect(await screen.findByText("1 个持仓")).toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    expect(screen.getAllByText("等待真实行情").length).toBeGreaterThan(0);
  });

  it("renders portfolio performance only from two real review snapshots", () => {
    useLabStore.setState({
      ...initialLabState,
      userStateLoaded: true,
      integrationStatus: { credentialConfigured: true, settings: { modelId: "" }, demo: false },
      portfolioPositions: [{ id: "p1", symbol: "AAPL", name: "Apple", market: "NASDAQ", quantity: 2, averageCost: 100 }],
      portfolioReviews: [
        { id: "r1", tradingDate: "2026-08-30", createdAt: "2026-08-30T08:00:00Z", totalPnlPercent: 1.2, totalMarketValue: 202 },
        { id: "r2", tradingDate: "2026-08-31", createdAt: "2026-08-31T08:00:00Z", totalPnlPercent: 3.4, totalMarketValue: 206 },
      ],
    });
    render(<PortfolioView />);
    expect(screen.getByRole("heading", { name: "组合表现趋势" })).toBeInTheDocument();
    expect(screen.getByText("2 个有效快照")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /组合盈亏比例从/ })).toBeInTheDocument();
    expect(screen.getByText("盈亏比例百分点")).toBeInTheDocument();
  });

  it("records a trade plan and lets the user mark it executed", async () => {
    window.localStorage.clear();
    render(<App />);
    await waitFor(() => expect(useLabStore.getState().userStateLoaded).toBe(true));
    act(() => useLabStore.setState({ portfolioPositions: [] }));
    fireEvent.click(screen.getByRole("button", { name: "组合" }));
    fireEvent.click(screen.getByRole("button", { name: "添加第一笔持仓" }));
    fireEvent.change(screen.getByLabelText("持仓数量"), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText("平均成本"), { target: { value: "100" } });
    fireEvent.change(screen.getByLabelText("止盈价"), { target: { value: "125" } });
    fireEvent.change(screen.getByLabelText("止损价"), { target: { value: "90" } });
    fireEvent.change(screen.getByLabelText("买入逻辑"), { target: { value: "盈利增长" } });
    fireEvent.change(screen.getByLabelText("计划周期"), { target: { value: "swing" } });
    fireEvent.click(screen.getByRole("button", { name: "保存持仓" }));
    await waitFor(() => expect(useLabStore.getState().portfolioPositions[0]).toMatchObject({ planThesis: "盈利增长", planStatus: "active" }));
    fireEvent.click(screen.getByRole("button", { name: /标记.*计划已执行/ }));
    await waitFor(() => expect(useLabStore.getState().portfolioPositions[0]).toMatchObject({ planStatus: "executed" }));
    expect(screen.getAllByText(/已执行/).length).toBeGreaterThan(0);
  });

  it("creates and expands a source-backed portfolio close review", async () => {
    render(<App />);
    await waitFor(() => expect(useLabStore.getState().userStateLoaded).toBe(true));
    act(() => useLabStore.setState({
      portfolioPositions: [{ id: "p1", symbol: "AAPL", name: "Apple", market: "NASDAQ", quantity: 2, averageCost: 100, planActions: [] }],
      liveQuotes: { AAPL: { price: 120, asOf: "2026-08-30T08:00:00Z", source: "provider" } },
      events: [],
    }));
    fireEvent.click(screen.getByRole("button", { name: "组合" }));
    fireEvent.click(screen.getByRole("button", { name: "生成复盘" }));
    expect(await screen.findByText(/仅使用 1\/1 个持仓的真实行情/)).toBeInTheDocument();
    fireEvent.click(document.querySelector(".portfolio-review-card summary"));
    expect(screen.getByText("来源：provider · 本复盘仅整理已返回的真实数据，不构成投资建议或交易指令。")).toBeInTheDocument();
  });

  it("does not show sample monitor signals without a real data connection", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /盯盘/ }));
    expect(screen.getByText("连接真实数据后开始")).toBeInTheDocument();
    expect(screen.queryByText(/预览线索/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "核实并分析" })).not.toBeInTheDocument();
  });

  it("shows real integration controls without claiming a missing credential is configured", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    expect(await screen.findByRole("heading", { name: "设置" })).toBeInTheDocument();
    expect(await screen.findByText("浏览器预览")).toBeInTheDocument();
    expect(screen.getByLabelText("数据服务 API Key")).toBeInTheDocument();
    expect(screen.getByLabelText("Gateway Base URL")).toHaveValue("https://aigateway.qveris.ai/v1");
    expect(screen.getByText("未配置")).toBeInTheDocument();
  });

  it("tests the saved data connection through a real CAP without requiring a model", async () => {
    integrationMocks.loadIntegrationStatus.mockResolvedValue({
      credentialConfigured: true,
      keyPrefix: "cap_demo…",
      settings: {
        capabilityBaseUrl: "https://qveris.ai/api/v1",
        modelGatewayBaseUrl: "https://aigateway.qveris.ai/v1",
        dataChannel: "qveris-cap",
        dataProvider: "qveris_finance",
        modelId: "",
        models: [],
      },
      demo: false,
      environment: "local-host",
    });
    integrationMocks.queryCapabilityData.mockResolvedValue({
      data: { quotes: [{ symbol: "600519", price: 1297.4, source: "真实 CAP", timestamp: "2026-08-31T08:00:00Z" }] },
      source: "qveris_finance",
      mode: "qveris-cap",
    });

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    const testButton = await screen.findByRole("button", { name: "测试数据连接" });
    expect(testButton).toBeEnabled();
    fireEvent.click(testButton);
    expect(await screen.findByText(/连接成功 · 600519 已返回真实行情/)).toBeInTheDocument();
    expect(integrationMocks.queryCapabilityData).toHaveBeenCalledWith({ kind: "quote", symbol: "600519" });
  });

  it("keeps only installed Skill IDs for settings backup export", () => {
    expect(installedSkillIdsForBackup([
      { id: "fundamental", installed: true },
      { id: "news", installed: false },
      { id: "monitor", installed: true },
    ])).toEqual(["fundamental", "monitor"]);
  });

  it("does not treat an empty CAP response as a successful connection", async () => {
    integrationMocks.loadIntegrationStatus.mockResolvedValue({
      credentialConfigured: true,
      settings: {
        capabilityBaseUrl: "https://qveris.ai/api/v1",
        modelGatewayBaseUrl: "https://aigateway.qveris.ai/v1",
        modelId: "",
        models: [],
      },
      demo: false,
      environment: "local-host",
    });
    integrationMocks.queryCapabilityData.mockResolvedValue({ data: { quotes: [] }, mode: "qveris-cap" });

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    const testButton = await screen.findByRole("button", { name: "测试数据连接" });
    fireEvent.click(testButton);
    expect(await screen.findByText("暂时没有可用数据，系统会稍后再查", { exact: true })).toBeInTheDocument();
    expect(screen.queryByText(/连接成功 ·/)).not.toBeInTheDocument();
  });

  it("does not show preview quotes while the local Host status is loading", async () => {
    integrationMocks.loadIntegrationStatus.mockResolvedValue({
      credentialConfigured: true,
      settings: {
        capabilityBaseUrl: "https://qveris.ai/api/v1",
        modelGatewayBaseUrl: "https://aigateway.qveris.ai/v1",
        modelId: "model-a",
        models: [{ id: "model-a", name: "Model A" }],
      },
      demo: false,
      environment: "local-host",
    });

    render(<App />);
    expect(screen.queryByText("1568.88")).not.toBeInTheDocument();
    expect(await screen.findByText("实时行情已启用 · 重点15秒 / 全量3分钟")).toBeInTheDocument();
    expect(screen.queryByText("1568.88")).not.toBeInTheDocument();
  });

  it("shows the source and freshness of a real quote in the stock workspace", async () => {
    integrationMocks.loadIntegrationStatus.mockResolvedValue({
      credentialConfigured: true,
      settings: {
        capabilityBaseUrl: "https://qveris.ai/api/v1",
        modelGatewayBaseUrl: "https://aigateway.qveris.ai/v1",
        dataChannel: "qveris-cap",
        dataProvider: "qveris_finance",
        modelId: "model-a",
        models: [{ id: "model-a", name: "Model A" }],
      },
      demo: false,
      environment: "local-host",
    });
    useLabStore.setState({ userStateLoaded: true, refreshLiveData: vi.fn().mockResolvedValue(true), liveQuotes: { "600519": { price: 1297.4, change: 0.4, asOf: new Date().toISOString(), source: "ths_ifind" } } });

    render(<App />);
    const healthStrip = await screen.findByRole("region", { name: "行情数据状态" });
    expect(healthStrip).toHaveTextContent("真实行情");
    expect(healthStrip).toHaveTextContent("qveris_finance");
    expect(healthStrip).toHaveTextContent("MKT.L1.RT");
    expect(healthStrip).toHaveTextContent("刷新");
  });

  it("switches the real event calendar between list and month views", async () => {
    integrationMocks.loadIntegrationStatus.mockResolvedValue({
      credentialConfigured: true,
      settings: {
        capabilityBaseUrl: "https://qveris.ai/api/v1",
        modelGatewayBaseUrl: "https://aigateway.qveris.ai/v1",
        modelId: "model-a",
        models: [{ id: "model-a", name: "Model A" }],
      },
      demo: false,
      environment: "local-host",
    });
    const eventDate = new Date();
    eventDate.setDate(eventDate.getDate() + 5);
    const dateKey = `${eventDate.getFullYear()}-${String(eventDate.getMonth() + 1).padStart(2, "0")}-${String(eventDate.getDate()).padStart(2, "0")}`;
    useLabStore.setState({ userStateLoaded: true, eventDataLoaded: true, eventDataReceivedCount: 1, eventDataTotalCount: 1, events: [{ id: "event-1", date: dateKey, symbol: "600519", name: "贵州茅台", type: "财报", title: "业绩披露", detail: "真实事件", source: "真实事件源" }] });

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "事件" }));
    expect(await screen.findByRole("heading", { name: "事件日历" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /月视图/ }));
    expect(screen.getByRole("region", { name: "真实公司事件月视图" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /个事件|\d{4}-\d{2}-\d{2}/ }).length).toBeGreaterThanOrEqual(42);
    expect(screen.getByRole("button", { name: new RegExp(`${dateKey}，1 个事件`) })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "下一个月" }));
    expect(screen.getByRole("button", { name: "上一个月" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /列表/ }));
    expect(screen.getByRole("region", { name: "真实公司事件列表" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看贵州茅台详情" }));
    expect(useLabStore.getState()).toMatchObject({ activeView: "watchlist", selectedSymbol: "600519" });
  });

  it("filters the real event calendar to portfolio holdings", async () => {
    integrationMocks.loadIntegrationStatus.mockResolvedValue({
      credentialConfigured: true,
      settings: {
        capabilityBaseUrl: "https://qveris.ai/api/v1",
        modelGatewayBaseUrl: "https://aigateway.qveris.ai/v1",
        modelId: "model-a",
        models: [{ id: "model-a", name: "Model A" }],
      },
      demo: false,
      environment: "local-host",
    });
    const eventDate = new Date();
    eventDate.setDate(eventDate.getDate() + 5);
    const dateKey = `${eventDate.getFullYear()}-${String(eventDate.getMonth() + 1).padStart(2, "0")}-${String(eventDate.getDate()).padStart(2, "0")}`;
    useLabStore.setState({
      userStateLoaded: true,
      eventDataLoaded: true,
      eventDataReceivedCount: 2,
      eventDataTotalCount: 2,
      portfolioPositions: [{ id: "position-1", symbol: "600519", name: "贵州茅台", market: "沪深", quantity: 10, averageCost: 100 }],
      events: [
        { id: "event-1", date: dateKey, symbol: "600519", name: "贵州茅台", category: "白酒", type: "财报", title: "持仓事件", detail: "真实事件", source: "真实事件源" },
        { id: "event-2", date: dateKey, symbol: "300750", name: "宁德时代", category: "新能源", type: "财报", title: "非持仓事件", detail: "真实事件", source: "真实事件源" },
      ],
    });
    render(<EventsView />);
    expect(await screen.findByText("持仓事件")).toBeInTheDocument();
    expect(screen.getByText("非持仓事件")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "事件行业" }), { target: { value: "白酒" } });
    expect(screen.getByText("持仓事件")).toBeInTheDocument();
    expect(screen.queryByText("非持仓事件")).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "事件行业" }), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "只看持仓" }));
    expect(screen.getByText("持仓事件")).toBeInTheDocument();
    expect(screen.queryByText("非持仓事件")).not.toBeInTheDocument();
  });

  it("pauses background quote polling and refreshes when the page returns", async () => {
    const refreshLiveData = vi.fn().mockResolvedValue(true);
    integrationMocks.loadIntegrationStatus.mockResolvedValue({
      credentialConfigured: true,
      settings: {
        capabilityBaseUrl: "https://qveris.ai/api/v1",
        modelGatewayBaseUrl: "https://aigateway.qveris.ai/v1",
        modelId: "model-a",
        models: [{ id: "model-a", name: "Model A" }],
      },
      demo: false,
      environment: "local-host",
    });
    useLabStore.setState({ userStateLoaded: true, selectedSymbol: "600519", portfolioPositions: [], rules: [], refreshLiveData });
    const previousVisibilityState = document.visibilityState;
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    try {
      render(<App />);
      await waitFor(() => expect(integrationMocks.loadIntegrationStatus).toHaveBeenCalled());
      expect(refreshLiveData).not.toHaveBeenCalled();

      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      act(() => document.dispatchEvent(new Event("visibilitychange")));
      await waitFor(() => expect(refreshLiveData).toHaveBeenCalledWith({ symbols: expect.arrayContaining(["600519"]) }));
    } finally {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: previousVisibilityState });
    }
  });

  it("requires a fresh model sync after changing the gateway", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    expect(await screen.findByText("浏览器预览")).toBeInTheDocument();
    const gateway = await screen.findByLabelText("Gateway Base URL");
    fireEvent.change(gateway, { target: { value: "https://gateway.example.com/v1" } });
    expect(screen.getByText("网关地址已变化，请先同步模型")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存并应用" })).toBeDisabled();
  });

  it("reports a desktop settings load failure and recovers on retry", async () => {
    integrationMocks.loadIntegrationStatus
      .mockRejectedValueOnce(new Error("系统凭据库暂时不可用"))
      .mockResolvedValueOnce({
        credentialConfigured: true,
        settings: {
          capabilityBaseUrl: "https://qveris.ai/api/v1",
          modelGatewayBaseUrl: "https://aigateway.qveris.ai/v1",
          modelId: "model-a",
          models: [{ id: "model-a", name: "Model A" }],
        },
        demo: false,
      });

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("数据服务凭据需要重新确认，请到设置中检查配置");
    expect(screen.getByText("加载失败")).toBeInTheDocument();
    expect(screen.getByText("状态未知")).toBeInTheDocument();
    expect(screen.queryByText("浏览器预览")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Gateway Base URL")).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "重试加载" }));
    expect(await screen.findByText("桌面端")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.getByLabelText("Gateway Base URL")).toBeEnabled();
    expect(screen.getByLabelText("默认模型")).toHaveValue("model-a");
    expect(integrationMocks.loadIntegrationStatus).toHaveBeenCalledTimes(2);
  });

  it("blocks analysis while Runtime settings are being applied", async () => {
    let finishApply;
    integrationMocks.loadIntegrationStatus.mockResolvedValue({
      credentialConfigured: true,
      settings: {
        capabilityBaseUrl: "https://qveris.ai/api/v1",
        modelGatewayBaseUrl: "https://aigateway.qveris.ai/v1",
        modelId: "model-a",
        models: [{ id: "model-a", name: "Model A" }],
      },
      demo: false,
    });
    integrationMocks.applyIntegrationSettings.mockImplementation(() => new Promise((resolve) => { finishApply = resolve; }));

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    expect(await screen.findByText("桌面端")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "保存并应用" }));
    expect(useLabStore.getState().runtimeConfiguring).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "对话" }));
    expect(screen.getByLabelText("分析问题")).toBeDisabled();
    expect(screen.getByLabelText("分析问题")).toHaveAttribute("placeholder", "正在应用设置，暂不能发起分析…");
    expect(screen.getByRole("button", { name: "正在应用设置" })).toBeDisabled();
    expect(screen.getByText("应用设置中")).toBeInTheDocument();

    await act(async () => {
      finishApply({
        capabilityBaseUrl: "https://qveris.ai/api/v1",
        modelGatewayBaseUrl: "https://aigateway.qveris.ai/v1",
        modelId: "model-a",
        models: [{ id: "model-a", name: "Model A" }],
      });
    });
    await waitFor(() => expect(screen.getByLabelText("分析问题")).toBeEnabled());
    expect(useLabStore.getState().runtimeConfiguring).toBe(false);
  });

  it("releases the Runtime configuration lock when applying settings fails", async () => {
    integrationMocks.loadIntegrationStatus.mockResolvedValue({
      credentialConfigured: true,
      settings: {
        capabilityBaseUrl: "https://qveris.ai/api/v1",
        modelGatewayBaseUrl: "https://aigateway.qveris.ai/v1",
        modelId: "model-a",
        models: [{ id: "model-a", name: "Model A" }],
      },
      demo: false,
    });
    integrationMocks.applyIntegrationSettings.mockRejectedValue(new Error("Runtime 重启失败"));

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    expect(await screen.findByText("桌面端")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "保存并应用" }));

    expect(await screen.findByText("设置暂时无法保存，请稍后重试", { exact: true })).toBeInTheDocument();
    await waitFor(() => expect(useLabStore.getState().runtimeConfiguring).toBe(false));
    expect(screen.getByRole("button", { name: "保存并应用" })).toBeEnabled();
  });

  it("keeps a settings apply failure visible after leaving Settings", async () => {
    let rejectApply;
    integrationMocks.loadIntegrationStatus.mockResolvedValue({
      credentialConfigured: true,
      settings: {
        capabilityBaseUrl: "https://qveris.ai/api/v1",
        modelGatewayBaseUrl: "https://aigateway.qveris.ai/v1",
        modelId: "model-a",
        models: [{ id: "model-a", name: "Model A" }],
      },
      demo: false,
    });
    integrationMocks.applyIntegrationSettings.mockImplementation(() => new Promise((_resolve, reject) => { rejectApply = reject; }));

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    expect(await screen.findByText("桌面端")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "保存并应用" }));
    fireEvent.click(screen.getByRole("button", { name: "对话" }));

    await act(async () => {
      rejectApply(new Error("新模型网关不可用"));
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("设置暂时无法保存，请稍后重试");
    fireEvent.click(screen.getByRole("button", { name: "关闭通知" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each(["running", "cancelling"])("does not apply settings while Runtime mode is %s", async (runtimeMode) => {
    useLabStore.setState({ runtimeMode });
    integrationMocks.loadIntegrationStatus.mockResolvedValue({
      credentialConfigured: true,
      settings: {
        capabilityBaseUrl: "https://qveris.ai/api/v1",
        modelGatewayBaseUrl: "https://aigateway.qveris.ai/v1",
        modelId: "model-a",
        models: [{ id: "model-a", name: "Model A" }],
      },
      demo: false,
    });

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    expect(await screen.findByText("请等待当前分析结束后再应用设置")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存并应用" })).toBeDisabled();
    expect(integrationMocks.applyIntegrationSettings).not.toHaveBeenCalled();
  });

  it("refreshes the selected quote directly instead of routing through chat", async () => {
    integrationMocks.loadIntegrationStatus.mockResolvedValue({
      credentialConfigured: true,
      settings: {
        capabilityBaseUrl: "https://qveris.ai/api/v1",
        modelGatewayBaseUrl: "https://aigateway.qveris.ai/v1",
        modelId: "model-a",
        models: [{ id: "model-a", name: "Model A" }],
      },
      demo: false,
      environment: "local-host",
    });
    const refreshSelectedQuote = vi.fn().mockResolvedValue(true);
    useLabStore.setState({ userStateLoaded: true, refreshLiveData: vi.fn().mockResolvedValue(true), refreshSelectedQuote });
    render(<App />);
    await screen.findByText("实时行情已启用 · 重点15秒 / 全量3分钟");
    fireEvent.click(screen.getByRole("button", { name: "获取实时数据" }));
    expect(refreshSelectedQuote).toHaveBeenCalledWith("600519");
    expect(screen.getByRole("button", { name: "交给 Agent 查询" })).toBeInTheDocument();
  });

  it("announces an in-progress assistant response", () => {
    useLabStore.setState((state) => ({
      messages: [...state.messages, { id: "streaming", role: "assistant", text: "正在生成第一段", streaming: true }],
      runtimeMode: "running",
    }));
    render(<App />);
    expect(screen.getByText("正在分析").closest(".assistant-message")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("正在生成第一段")).toBeInTheDocument();
  });

  it("offers an accessible stop control while an analysis is running", () => {
    const cancelMessage = vi.fn();
    useLabStore.setState({ runtimeMode: "running", cancelMessage });
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "停止分析" }));
    expect(cancelMessage).toHaveBeenCalledOnce();
    expect(screen.getByLabelText("分析问题")).toBeDisabled();
    expect(screen.getByText("分析中")).toBeInTheDocument();
  });

  it("prevents repeated cancellation while the abort command is pending", () => {
    useLabStore.setState({ runtimeMode: "cancelling" });
    render(<App />);
    expect(screen.getByRole("button", { name: "正在取消" })).toBeDisabled();
    expect(screen.getByText("取消中")).toBeInTheDocument();
    expect(screen.getByLabelText("分析问题")).toHaveAttribute("placeholder", "正在停止本轮分析…");
  });

  it("keeps the composer locked until a late cancellation command settles", () => {
    useLabStore.setState({ runtimeMode: "pi-rpc", runtimeCancelPending: true });
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "对话" }));
    expect(screen.getByRole("button", { name: "正在完成取消" })).toBeDisabled();
    expect(screen.getByLabelText("分析问题")).toBeDisabled();
    expect(screen.getByText("完成取消中")).toBeInTheDocument();
    expect(screen.getByLabelText("分析问题")).toHaveAttribute("placeholder", "正在完成取消请求…");
  });

  it("disables Runtime settings while a late cancellation command is pending", async () => {
    useLabStore.setState({ runtimeMode: "pi-rpc", runtimeCancelPending: true });
    integrationMocks.loadIntegrationStatus.mockResolvedValue({
      credentialConfigured: true,
      settings: {
        capabilityBaseUrl: "https://qveris.ai/api/v1",
        modelGatewayBaseUrl: "https://aigateway.qveris.ai/v1",
        modelId: "model-a",
        models: [{ id: "model-a", name: "Model A" }],
      },
      demo: false,
    });
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    expect(await screen.findByText("桌面端")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存并应用" })).toBeDisabled();
    expect(screen.getByLabelText("Gateway Base URL")).toBeDisabled();
    expect(screen.getByText("请等待当前分析结束后再应用设置")).toBeInTheDocument();
  });
});
