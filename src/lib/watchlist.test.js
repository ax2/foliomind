import { describe, expect, it } from "vitest";
import { normalizeWatchlistItem, sortWatchlistItems, watchlistGroupForMarket } from "./watchlist.js";

describe("watchlist organization", () => {
  it("keeps explicit groups and migrates legacy market labels", () => {
    expect(normalizeWatchlistItem({ symbol: " aapl ", name: " Apple ", market: "NASDAQ" })).toMatchObject({ symbol: "AAPL", name: "Apple", group: "美股" });
    expect(normalizeWatchlistItem({ symbol: "600519", name: "贵州茅台", market: "沪深", group: "核心持仓" })).toMatchObject({ group: "核心持仓" });
    expect(watchlistGroupForMarket("HKEX")).toBe("港股");
  });

  it("sorts numeric quote fields with missing values last and keeps stable ties", () => {
    const items = [{ symbol: "A", name: "Alpha" }, { symbol: "B", name: "Beta" }, { symbol: "C", name: "Gamma" }];
    const quotes = { A: { change: 1.2 }, B: { change: -0.4 } };
    expect(sortWatchlistItems(items, quotes, "change", "desc").map((item) => item.symbol)).toEqual(["A", "B", "C"]);
    expect(sortWatchlistItems(items, quotes, "change", "asc").map((item) => item.symbol)).toEqual(["B", "A", "C"]);
    expect(sortWatchlistItems(items, {}, "custom").map((item) => item.symbol)).toEqual(["A", "B", "C"]);
  });
});

