import { describe, expect, it } from "vitest";
import { normalizePortfolioPosition, portfolioAlertChecks, portfolioMetrics, portfolioPlanProgress, portfolioReportCsv, portfolioReportRows, portfolioRiskMetrics } from "./portfolio.js";

describe("portfolio metrics", () => {
  it("normalizes valid positions and rejects invalid values", () => {
    expect(normalizePortfolioPosition({ id: "p1", symbol: " aapl ", name: "Apple", quantity: "2", averageCost: "100", takeProfitPrice: "125", stopLossPrice: "80" })).toMatchObject({ symbol: "AAPL", quantity: 2, averageCost: 100, takeProfitPrice: 125, stopLossPrice: 80, takeProfitTriggered: false, stopLossTriggered: false });
    expect(normalizePortfolioPosition({ symbol: "AAPL", quantity: 0, averageCost: 100 })).toBeNull();
  });

  it("fires edge-triggered take-profit and stop-loss alerts only for real prices", () => {
    const position = { symbol: "AAPL", takeProfitPrice: 125, stopLossPrice: 80, takeProfitTriggered: false, stopLossTriggered: false };
    const takeProfit = portfolioAlertChecks(position, { price: 125, asOf: "2026-08-30T10:00:00Z", source: "CAP" });
    expect(takeProfit.alerts).toMatchObject([{ type: "take-profit", target: 125, currentPrice: 125 }]);
    expect(takeProfit.updates).toMatchObject({ takeProfitTriggered: true, stopLossTriggered: false });
    expect(portfolioAlertChecks({ ...position, takeProfitTriggered: true }, { price: 126 }).alerts).toHaveLength(0);
    expect(portfolioAlertChecks({ ...position, takeProfitTriggered: true }, { price: 120 }).updates.takeProfitTriggered).toBe(false);
    expect(portfolioAlertChecks(position, { price: 79, source: "CAP" }).alerts).toMatchObject([{ type: "stop-loss", severity: "critical" }]);
    expect(portfolioAlertChecks(position, {}).alerts).toHaveLength(0);
  });

  it("normalizes and calculates a transparent trade plan", () => {
    const position = normalizePortfolioPosition({ id: "p1", symbol: "AAPL", name: "Apple", quantity: 2, averageCost: 100, takeProfitPrice: 130, stopLossPrice: 90, planThesis: "盈利增长与估值修复", planHorizon: "swing", planStatus: "active", planActions: [{ id: "a1", type: "created", at: "2026-08-30T00:00:00Z", note: "建立交易计划" }] });
    expect(position).toMatchObject({ planThesis: "盈利增长与估值修复", planHorizon: "swing", planStatus: "active", planActions: [{ type: "created" }] });
    expect(portfolioPlanProgress(position, { price: 100 })).toMatchObject({ hasPlan: true, targetDistancePercent: 30, stopDistancePercent: 10, rewardRisk: 3 });
    expect(portfolioPlanProgress(position, {}).targetDistancePercent).toBeNull();
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

  it("exports a truthful report with blanks for unpriced positions", () => {
    const positions = [{ id: "p1", symbol: "AAPL", name: "Apple, Inc.", market: "US", quantity: 2, averageCost: 100, takeProfitPrice: 125 }, { id: "p2", symbol: "MSFT", name: "Microsoft", market: "US", quantity: 1, averageCost: 200 }];
    expect(portfolioReportRows(positions, { AAPL: { price: 125, asOf: "2026-08-29", source: "CAP" } })[1]).toMatchObject({ currentPrice: null, marketValue: null, quoteSource: "" });
    const csv = portfolioReportCsv(positions, { AAPL: { price: 125, asOf: "2026-08-29", source: "CAP" } });
    expect(csv).toContain('"Apple, Inc."');
    expect(csv).toContain("MSFT,Microsoft,US,1,200,");
    expect(csv).toContain("Apple, Inc.");
  });
});
