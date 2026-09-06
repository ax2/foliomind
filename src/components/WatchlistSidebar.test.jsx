import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialLabState, useLabStore } from "../store/useLabStore.js";
import { WatchlistSidebar } from "./WatchlistSidebar.jsx";

vi.mock("../lib/localHost.js", async (importOriginal) => ({ ...await importOriginal(), isLocalWebRuntime: () => true }));

afterEach(cleanup);

describe("WatchlistSidebar custom ordering", () => {
  it("does not render default rows before canonical user state is loaded", () => {
    useLabStore.setState({ ...initialLabState, userStateLoaded: false });
    render(<WatchlistSidebar />);

    expect(screen.getByRole("status")).toHaveTextContent("正在读取本地工作区");
    expect(screen.queryByText("贵州茅台")).not.toBeInTheDocument();
  });

  it("filters watchlist rows locally by name, symbol, category, or market", async () => {
    useLabStore.setState({
      ...initialLabState,
      userStateLoaded: true,
      watchlist: [
        { symbol: "A", name: "第一项", market: "自定义", category: "核心" },
        { symbol: "B", name: "第二项", market: "NASDAQ", category: "科技" },
        { symbol: "C", name: "第三项", market: "沪市", category: "消费" },
      ],
    });
    render(<WatchlistSidebar />);

    const search = screen.getByRole("searchbox", { name: "搜索自选" });
    fireEvent.change(search, { target: { value: "科技" } });
    expect(screen.getByText("第二项")).toBeInTheDocument();
    expect(screen.queryByText("第一项")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("已筛选 1/3 个标的");
    expect(screen.getByRole("button", { name: "清除自选搜索" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "清除自选搜索" }));
    expect(screen.getByText("第一项")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "清除自选搜索" })).not.toBeInTheDocument();
  });

  it("exposes accessible move controls and keeps boundaries disabled", async () => {
    useLabStore.setState({
      ...initialLabState,
      selectedSymbol: "B",
      userStateLoaded: true,
      watchlist: [
        { symbol: "A", name: "第一项", market: "自定义", group: "核心" },
        { symbol: "B", name: "第二项", market: "自定义", group: "核心" },
        { symbol: "C", name: "第三项", market: "自定义", group: "核心" },
      ],
    });
    render(<WatchlistSidebar />);

    expect(screen.getByRole("button", { name: "上移A" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "下移C" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "上移B" }));

    await waitFor(() => {
      expect(useLabStore.getState().watchlist.map((item) => item.symbol)).toEqual(["B", "A", "C"]);
      expect(screen.getByRole("button", { name: "上移B" })).toBeDisabled();
    });
    expect(screen.getByRole("button", { name: "下移B" })).not.toBeDisabled();
  });

  it("does not offer reorder actions while a metric sort is active", () => {
    useLabStore.setState({
      ...initialLabState,
      userStateLoaded: true,
      watchlist: [
        { symbol: "A", name: "第一项", market: "自定义", group: "核心" },
        { symbol: "B", name: "第二项", market: "自定义", group: "核心" },
      ],
    });
    render(<WatchlistSidebar />);
    fireEvent.change(screen.getAllByRole("combobox", { name: "自选排序" })[0], { target: { value: "name" } });
    expect(screen.queryByRole("button", { name: "上移A" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "下移B" })).not.toBeInTheDocument();
  });

  it("offers a safe workspace view reset from the tools menu", async () => {
    useLabStore.setState({
      ...initialLabState,
      userStateLoaded: true,
      workspace: { ...initialLabState.workspace, watchlistQuery: "科技", chartRange: "周K" },
      chartRange: "周K",
      watchlist: [{ symbol: "A", name: "第一项", market: "自定义", group: "核心" }],
    });
    render(<WatchlistSidebar />);

    fireEvent.click(screen.getByRole("button", { name: "自选工具" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "重置工作区视图" }));
    await waitFor(() => expect(useLabStore.getState().workspace).toEqual(initialLabState.workspace));
    expect(useLabStore.getState().watchlist).toHaveLength(1);
  });

  it("saves and reapplies a bounded workspace view without changing watchlist data", async () => {
    useLabStore.setState({
      ...initialLabState,
      userStateLoaded: true,
      persistUserState: vi.fn().mockResolvedValue(true),
      workspace: { ...initialLabState.workspace, watchlistQuery: "科技", watchlistSort: "change" },
      watchlist: [{ symbol: "A", name: "第一项", market: "自定义", group: "核心" }],
    });
    render(<WatchlistSidebar />);
    fireEvent.click(screen.getByRole("button", { name: "自选工具" }));
    fireEvent.change(screen.getByRole("textbox", { name: "新视图名称" }), { target: { value: "核心观察" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "应用已保存视图" })).toHaveTextContent("核心观察"));
    fireEvent.change(screen.getByRole("combobox", { name: "自选排序" }), { target: { value: "name" } });
    fireEvent.change(screen.getByRole("combobox", { name: "应用已保存视图" }), { target: { value: useLabStore.getState().workspace.savedViews[0].id } });
    await waitFor(() => expect(useLabStore.getState().workspace.watchlistSort).toBe("change"));
    expect(useLabStore.getState().watchlist).toHaveLength(1);
  });

  it("does not update state when a reset resolves after unmount", async () => {
    let release;
    const resetWorkspacePreferences = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    useLabStore.setState({ ...initialLabState, userStateLoaded: true, resetWorkspacePreferences, watchlist: [{ symbol: "A", name: "第一项", market: "自定义", group: "核心" }] });
    render(<WatchlistSidebar />);
    fireEvent.click(screen.getByRole("button", { name: "自选工具" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "重置工作区视图" }));
    expect(resetWorkspacePreferences).toHaveBeenCalledTimes(1);
    cleanup();
    release();
    await Promise.resolve();
  });
});
