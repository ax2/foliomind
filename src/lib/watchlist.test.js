import { describe, expect, it } from "vitest";
import { normalizeWatchlistItem, parseWatchlistImport, sortWatchlistItems, watchlistCsv, watchlistGroupForMarket } from "./watchlist.js";

describe("watchlist organization", () => {
  it("keeps explicit groups and migrates legacy market labels", () => {
    expect(normalizeWatchlistItem({ symbol: " aapl ", name: " Apple ", market: "NASDAQ" })).toMatchObject({ symbol: "AAPL", name: "Apple", group: "美股" });
    expect(normalizeWatchlistItem({ symbol: "600519", name: "贵州茅台", market: "沪深", group: "核心持仓" })).toMatchObject({ group: "核心持仓" });
    expect(watchlistGroupForMarket("HKEX")).toBe("港股");
    expect(watchlistGroupForMarket("RUSSELL 2000", "观察")).toBe("观察");
    expect(watchlistGroupForMarket("CUSTOM-USAGE", "观察")).toBe("观察");
  });

  it("sorts numeric quote fields with missing values last and keeps stable ties", () => {
    const items = [{ symbol: "A", name: "Alpha" }, { symbol: "B", name: "Beta" }, { symbol: "C", name: "Gamma" }];
    const quotes = { A: { change: 1.2 }, B: { change: -0.4 } };
    expect(sortWatchlistItems(items, quotes, "change", "desc").map((item) => item.symbol)).toEqual(["A", "B", "C"]);
    expect(sortWatchlistItems(items, quotes, "change", "asc").map((item) => item.symbol)).toEqual(["B", "A", "C"]);
    expect(sortWatchlistItems(items, {}, "custom").map((item) => item.symbol)).toEqual(["A", "B", "C"]);
    expect(sortWatchlistItems(items, { A: { price: 0 }, B: { price: 10 }, C: { price: -2 } }, "price", "asc").map((item) => item.symbol)).toEqual(["B", "A", "C"]);
  });

  it("sorts when provider quotes use another exchange suffix", () => {
    const items = [{ symbol: "600519.SS", name: "贵州茅台" }, { symbol: "AAPL.US", name: "Apple" }];
    const quotes = { "600519": { price: 125, change: 2 }, AAPL: { price: 200, change: -1 } };
    expect(sortWatchlistItems(items, quotes, "price", "desc").map((item) => item.symbol)).toEqual(["AAPL.US", "600519.SS"]);
  });

  it("round-trips the user watchlist without quotes and parses CSV/TXT imports", () => {
    const csv = watchlistCsv([{ symbol: "600519", name: "贵州茅台", market: "A股", category: "白酒", group: "核心" }, { symbol: "AAPL", name: "Apple", market: "美股", group: "海外" }]);
    expect(csv).not.toContain("price");
    const parsedCsv = parseWatchlistImport(csv);
    expect(parsedCsv.items).toMatchObject([{ symbol: "600519", name: "贵州茅台", group: "核心" }, { symbol: "AAPL", name: "Apple", group: "海外" }]);
    const parsedTxt = parseWatchlistImport("NASDAQ:AAPL\nSSE:600519\nSSE:600519\n# comment\n");
    expect(parsedTxt.items).toMatchObject([{ symbol: "AAPL", market: "美股" }, { symbol: "600519", market: "A股" }]);
    expect(parsedTxt.skipped).toBe(1);
  });

  it("reports malformed rows and enforces the import bound", () => {
    const result = parseWatchlistImport("代码,名称\nBAD SPACE,错误\nAAPL,Apple\nMSFT,Microsoft", { maxItems: 1 });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].symbol).toBe("AAPL");
    expect(result.errors).toEqual([{ line: 2, reason: "代码格式无法识别" }, { line: 4, reason: "最多导入 1 个标的" }]);
  });
});
