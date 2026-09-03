import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { initialLabState, useLabStore } from "../store/useLabStore.js";
import { WatchlistSidebar } from "./WatchlistSidebar.jsx";

afterEach(cleanup);

describe("WatchlistSidebar custom ordering", () => {
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
});
