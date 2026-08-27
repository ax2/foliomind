import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.jsx";
import { useLabStore } from "./store/useLabStore.js";

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
  useLabStore.setState({ activeView: "watchlist", selectedSymbol: "600519", chartRange: "分时" });
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

  it("creates and toggles a monitor rule", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /盯盘/ }));
    fireEvent.click(screen.getByRole("button", { name: /新建盯盘/ }));
    expect(screen.getByText("成交量异常监控")).toBeInTheDocument();
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
});
