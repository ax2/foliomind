import { describe, expect, it } from "vitest";
import { normalizePortfolioPosition, portfolioMetrics, portfolioRiskMetrics } from "./portfolio.js";

describe("portfolio metrics", () => {
  it("normalizes valid positions and rejects invalid values", () => {
    expect(normalizePortfolioPosition({ id: "p1", symbol: " aapl ", name: "Apple", quantity: "2", averageCost: "100" })).toMatchObject({ symbol: "AAPL", quantity: 2, averageCost: 100 });
    expect(normalizePortfolioPosition({ symbol: "AAPL", quantity: 0, averageCost: 100 })).toBeNull();
  });

  it("computes P/L only for positions with real quotes", () => {
    const result = portfolioMetrics([
      { id: "p1", symbol: "AAPL", name: "Apple", quantity: 2, averageCost: 100 },
      { id: "p2", symbol: "MSFT", name: "Microsoft", quantity: 1, averageCost: 200 },
    ], { AAPL: { price: 125 } });
    expect(result.totalCost).toBe(400);
    expect(result.totalMarketValue).toBe(250);
    expect(result.totalPnl).toBe(50);
    expect(result.rows[0]).toMatchObject({ marketValue: 250, pnl: 50, pnlPercent: 25, weight: 100 });
    expect(result.rows[1]).toMatchObject({ marketValue: null, pnl: null, weight: null, hasQuote: false });
  });

  it("emits explainable concentration and coverage signals", () => {
    const result = portfolioRiskMetrics([
      { id: "p1", symbol: "AAPL", name: "Apple", quantity: 8, averageCost: 100 },
      { id: "p2", symbol: "MSFT", name: "Microsoft", quantity: 1, averageCost: 200 },
    ], { AAPL: { price: 125 } });
    expect(result.topPosition).toMatchObject({ symbol: "AAPL" });
    expect(result.topWeight).toBe(100);
    expect(result.pricedCoverage).toBe(50);
    expect(result.signals.map((signal) => signal.title)).toEqual(expect.arrayContaining(["单一标的集中度较高", "部分持仓缺少现价"]));
    expect(result.hasEnoughDataForRiskModel).toBe(false);
  });
});
