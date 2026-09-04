import { describe, expect, it } from "vitest";
import { activeResearchFilterCount, filterResearchItems, sortResearchItems } from "./research.js";

describe("research sorting", () => {
  it("sorts valuation fields with missing values last and stable ties", () => {
    const items = [{ symbol: "A", name: "Alpha" }, { symbol: "B", name: "Beta" }, { symbol: "C", name: "Gamma" }, { symbol: "D", name: "Delta" }];
    const quotes = { A: { pe: 12 }, B: { pe: 8 }, C: { pe: null }, D: { pe: 8 } };
    expect(sortResearchItems(items, quotes, "pe", "asc").map((item) => item.symbol)).toEqual(["B", "D", "A", "C"]);
    expect(sortResearchItems(items, quotes, "pe", "desc").map((item) => item.symbol)).toEqual(["A", "B", "D", "C"]);
    expect(sortResearchItems(items, quotes, "default").map((item) => item.symbol)).toEqual(["A", "B", "C", "D"]);
  });
});

describe("research numeric filters", () => {
  const items = [{ symbol: "A" }, { symbol: "B" }, { symbol: "C" }, { symbol: "D" }];
  const quotes = {
    A: { change: 5, pe: 12, pb: 1.4, volume: 100 },
    B: { change: -2, pe: 8, pb: 0.9, volume: 240 },
    C: { change: 1, pe: null, pb: 2.1, volume: 80 },
    D: { change: 7, pe: 18, pb: 1.1, volume: null },
  };

  it("combines bounds and excludes missing values when a bound is configured", () => {
    expect(filterResearchItems(items, quotes, { minChange: "0", maxPe: "15", minVolume: "90" }).map((item) => item.symbol)).toEqual(["A"]);
    expect(filterResearchItems(items, quotes, { maxPb: "1.5" }).map((item) => item.symbol)).toEqual(["A", "B", "D"]);
  });

  it("keeps all items for empty or invalid bounds and counts active filters", () => {
    expect(filterResearchItems(items, quotes, { minChange: "  ", maxPe: "not-a-number" })).toHaveLength(4);
    expect(activeResearchFilterCount({ minChange: "2", maxPe: "", maxPb: "1.5" })).toBe(2);
  });

  it("matches filters and sorting across provider exchange suffixes", () => {
    const crossMarketItems = [{ symbol: "600519.SS", name: "贵州茅台" }, { symbol: "AAPL.US", name: "Apple" }];
    const crossMarketQuotes = { "600519": { price: 125, change: 2, pe: 20, pb: 3, volume: 10 }, AAPL: { price: 200, change: -1, pe: 30, pb: 5, volume: 20 } };
    expect(filterResearchItems(crossMarketItems, crossMarketQuotes, { minChange: "1" })).toEqual([crossMarketItems[0]]);
    expect(sortResearchItems(crossMarketItems, crossMarketQuotes, "price", "desc")).toEqual([crossMarketItems[1], crossMarketItems[0]]);
  });
});
