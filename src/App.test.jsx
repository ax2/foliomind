import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.jsx";
import { initialLabState, useLabStore } from "./store/useLabStore.js";

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

afterEach(cleanup);

beforeEach(() => {
  useLabStore.setState({
    ...initialLabState,
    skillItems: initialLabState.skillItems.map((item) => ({ ...item })),
    messages: initialLabState.messages.map((message) => ({ ...message })),
    rules: initialLabState.rules.map((rule) => ({ ...rule })),
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
    expect(screen.getByLabelText("QVeris API Key")).toBeInTheDocument();
    expect(screen.getByLabelText("Gateway Base URL")).toHaveValue("https://aigateway.qveris.ai/v1");
    expect(screen.getByText("未配置")).toBeInTheDocument();
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
});
