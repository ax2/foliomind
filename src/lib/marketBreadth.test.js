import { describe, expect, it } from "vitest";
import { marketBreadth, marketWatchlistSummary } from "./marketBreadth.js";

describe("marketBreadth", () => {
  it("counts only priced real quotes and keeps missing changes out of breadth", () => {
    expect(marketBreadth(
      [{ symbol: "AAA", name: "上涨" }, { symbol: "BBB", name: "下跌" }, { symbol: "CCC", name: "缺失" }],
      { AAA: { price: 10, change: 2.5 }, BBB: { price: 20, change: -1.2 }, CCC: { change: 4 } },
    )).toMatchObject({ totalCount: 3, pricedCount: 2, missingCount: 1, changeCount: 2, upCount: 1, downCount: 1, flatCount: 0, topGainer: { symbol: "AAA", change: 2.5 }, topLoser: { symbol: "BBB", change: -1.2 } });
  });

  it("returns an empty leader state when no quote has a valid price", () => {
    expect(marketBreadth([{ symbol: "AAA" }, { symbol: "BBB" }], { AAA: { price: 0, change: 3 }, BBB: { price: -1, change: -3 } })).toMatchObject({ totalCount: 2, pricedCount: 0, missingCount: 2, changeCount: 0, topGainer: null, topLoser: null });
  });

  it("uses the first symbol when leaders tie, making the summary deterministic", () => {
    const result = marketBreadth([{ symbol: "AAA" }, { symbol: "BBB" }, { symbol: "CCC" }, { symbol: "DDD" }], { AAA: { price: 10, change: 1 }, BBB: { price: 20, change: 1 }, CCC: { price: 30, change: -1 }, DDD: { price: 40, change: -1 } });
    expect(result.topGainer.symbol).toBe("AAA");
    expect(result.topLoser.symbol).toBe("CCC");
  });

  it("excludes explicitly stale quotes without counting them as missing", () => {
    const now = Date.parse("2026-09-02T10:00:00Z");
    expect(marketBreadth(
      [{ symbol: "AAA" }, { symbol: "BBB" }, { symbol: "CCC" }],
      {
        AAA: { price: 10, change: 2, asOf: "2026-09-02T09:55:00Z" },
        BBB: { price: 20, change: -2, asOf: "2026-09-02T09:30:00Z" },
        CCC: { price: 30, change: 1 },
      },
      { now },
    )).toMatchObject({ pricedCount: 2, staleCount: 1, missingCount: 0, upCount: 2, downCount: 0 });
  });

  it("counts a quote returned under a different exchange suffix", () => {
    const result = marketBreadth([{ symbol: "600519.SS", name: "贵州茅台" }], { "600519": { price: 125, change: 1 } });
    expect(result).toMatchObject({ pricedCount: 1, upCount: 1 });
  });
});

describe("marketWatchlistSummary", () => {
  it("summarizes each numeric field from current quotes", () => {
    const result = marketWatchlistSummary(
      [{ symbol: "AAA" }, { symbol: "BBB" }, { symbol: "CCC" }],
      {
        AAA: { price: 10, change: 1, volume: 100, pe: 8 },
        BBB: { price: 20, change: -1, volume: 300, pe: 12 },
        CCC: { price: 30, change: 3, volume: 200 },
      },
    );
    expect(result.eligibleCount).toBe(3);
    expect(result.fields.price).toMatchObject({ count: 3, min: 10, max: 30, average: 20, median: 20 });
    expect(result.fields.change).toMatchObject({ count: 3, min: -1, max: 3, average: 1, median: 1 });
    expect(result.fields.volume).toMatchObject({ count: 3, min: 100, max: 300, average: 200, median: 200 });
    expect(result.fields.pe).toMatchObject({ count: 2, min: 8, max: 12, average: 10, median: 10 });
  });

  it("excludes stale, invalid-price, and missing field values without inventing data", () => {
    const now = Date.parse("2026-09-02T10:00:00Z");
    const result = marketWatchlistSummary(
      [{ symbol: "AAA" }, { symbol: "BBB" }, { symbol: "CCC" }, { symbol: "DDD" }],
      {
        AAA: { price: 10, change: 2, turnoverRate: 1, asOf: "2026-09-02T09:55:00Z" },
        BBB: { price: 20, change: 4, turnoverRate: 3, asOf: "2026-09-02T09:30:00Z" },
        CCC: { price: 0, change: 9, turnoverRate: 5 },
        DDD: { price: 30 },
      },
      { now },
    );
    expect(result).toMatchObject({ eligibleCount: 2, staleCount: 1 });
    expect(result.fields.price).toMatchObject({ count: 2, min: 10, max: 30, average: 20, median: 20 });
    expect(result.fields.change).toMatchObject({ count: 1, min: 2, max: 2, average: 2, median: 2 });
    expect(result.fields.turnoverRate).toMatchObject({ count: 1, min: 1, max: 1, average: 1, median: 1 });
    expect(result.fields.pe).toMatchObject({ count: 0, min: null, max: null, average: null, median: null });
  });
});
