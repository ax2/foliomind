import { describe, expect, it } from "vitest";
import { marketBreadth } from "./marketBreadth.js";

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
});
