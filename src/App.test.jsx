import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.jsx";
import { initialLabState, useLabStore } from "./store/useLabStore.js";

const originalCancelMessage = useLabStore.getState().cancelMessage;
const integrationMocks = vi.hoisted(() => ({ loadIntegrationStatus: vi.fn() }));

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
  loadIntegrationStatus: integrationMocks.loadIntegrationStatus,
}));

afterEach(cleanup);

beforeEach(() => {
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
  });
});

describe("FolioMind core flows", () => {
  it("switches watchlist symbols and chart ranges", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /宁德时代/ }));
    expect(screen.getByRole("heading", { name: /宁德时代/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "5日" }));
    expect(screen.getByRole("button", { name: "5日" })).toHaveClass("active");
  });

  it("opens Skills and toggles install state", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /^技能$/ }));
    expect(screen.getByRole("heading", { name: "Skill 市场" })).toBeInTheDocument();
    const install = screen.getAllByRole("button", { name: "安装" })[0];
    fireEvent.click(install);
    expect(screen.getAllByRole("button", { name: "已安装" }).length).toBeGreaterThan(2);
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
    expect(screen.getByText("成交量异常监控")).toBeInTheDocument();
  });

  it("routes a sample monitor signal to QVeris verification", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /盯盘/ }));
    fireEvent.click(screen.getAllByRole("button", { name: "核实并分析" })[0]);
    expect(await screen.findByText(/待核实线索/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "对话" })).toHaveAttribute("aria-current", "page");
  });

  it("shows real integration controls without claiming a missing credential is configured", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    expect(await screen.findByRole("heading", { name: "设置" })).toBeInTheDocument();
    expect(await screen.findByText("浏览器预览")).toBeInTheDocument();
    expect(screen.getByLabelText("QVeris API Key")).toBeInTheDocument();
    expect(screen.getByLabelText("Gateway Base URL")).toHaveValue("https://aigateway.qveris.ai/v1");
    expect(screen.getByText("未配置")).toBeInTheDocument();
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
    expect(await screen.findByRole("alert")).toHaveTextContent("设置加载失败：系统凭据库暂时不可用");
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

  it("routes a live-data request through the agent conversation", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "用 QVeris 获取实时数据" }));
    expect(await screen.findByText(/qveris-finance-research Skill/)).toBeInTheDocument();
    expect(screen.getAllByText("分析摘要").length).toBeGreaterThan(0);
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
});
