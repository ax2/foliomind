import { describe, expect, it } from "vitest";
import { normalizePortfolioPosition, parsePortfolioImport, portfolioAlertChecks, portfolioAllocationRows, portfolioMetrics, portfolioPerformanceSeries, portfolioPlanProgress, portfolioReportCsv, portfolioReportRows, portfolioRiskMetrics, portfolioRiskReturns, sortPortfolioRows } from "./portfolio.js";

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

  it("rejects zero and negative prices as invalid real quotes", () => {
    const positions = [{ id: "p1", symbol: "AAPL", name: "Apple", quantity: 2, averageCost: 100 }];
    expect(portfolioMetrics(positions, { AAPL: { price: 0 } }).rows[0]).toMatchObject({ currentPrice: null, marketValue: null, hasQuote: false });
    expect(portfolioMetrics(positions, { AAPL: { price: -10 } }).rows[0]).toMatchObject({ currentPrice: null, marketValue: null, hasQuote: false });
    expect(portfolioAlertChecks({ ...positions[0], takeProfitPrice: 125, stopLossPrice: 80 }, { price: 0 }).alerts).toHaveLength(0);
  });

  it("builds allocation rows from real market values and excludes unpriced positions", () => {
    const positions = [
      { id: "p1", symbol: "AAPL", name: "Apple", quantity: 2, averageCost: 100 },
      { id: "p2", symbol: "MSFT", name: "Microsoft", quantity: 1, averageCost: 200 },
    ];
    const rows = portfolioAllocationRows(positions, { AAPL: { price: 200 }, MSFT: {} });
    expect(rows).toMatchObject([{ symbol: "AAPL", marketValue: 400, weight: 100 }]);
    expect(rows).toHaveLength(1);
  });

  it("builds a dated performance series from real review snapshots", () => {
    const series = portfolioPerformanceSeries([
      { id: "old", tradingDate: "2026-08-30", createdAt: "2026-08-30T08:00:00Z", totalPnlPercent: 1.2, totalMarketValue: 1000, pricedCount: 1, totalCount: 1 },
      { id: "same-day-stale", tradingDate: "2026-08-31", createdAt: "2026-08-31T08:00:00Z", totalPnlPercent: 2, totalMarketValue: 1100 },
      { id: "same-day-latest", tradingDate: "2026-08-31", createdAt: "2026-08-31T09:00:00Z", totalPnlPercent: 2.5, totalMarketValue: 1120, pricedCount: 1, totalCount: 1 },
      { id: "invalid", tradingDate: "2026-09-01", createdAt: "not-a-date", totalPnlPercent: 4 },
      { id: "missing-pnl", tradingDate: "2026-09-02", createdAt: "2026-09-02T08:00:00Z", totalPnlPercent: null },
    ]);
    expect(series).toHaveLength(2);
    expect(series.map((point) => point.id)).toEqual(["old", "same-day-latest"]);
    expect(series.at(-1)).toMatchObject({ tradingDate: "2026-08-31", totalPnlPercent: 2.5, totalMarketValue: 1120 });
    expect(portfolioPerformanceSeries(series, 1).map((point) => point.id)).toEqual(["same-day-latest"]);
  });

  it("sorts portfolio rows by real values with missing values last", () => {
    const rows = [{ symbol: "A", marketValue: 200, pnl: -4 }, { symbol: "B", marketValue: null, pnl: null }, { symbol: "C", marketValue: 400, pnl: 8 }, { symbol: "D", marketValue: 200, pnl: 3 }];
    expect(sortPortfolioRows(rows, "marketValue", "desc").map((row) => row.symbol)).toEqual(["C", "A", "D", "B"]);
    expect(sortPortfolioRows(rows, "pnl", "asc").map((row) => row.symbol)).toEqual(["A", "D", "C", "B"]);
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

  it("computes sample risk metrics only from real overlapping history", () => {
    const series = (prices) => prices.map((close, index) => ({ time: `2026-08-${String(25 + index).padStart(2, "0")}`, close }));
    const positions = [
      { id: "p1", symbol: "AAPL", name: "Apple", quantity: 1, averageCost: 100 },
      { id: "p2", symbol: "MSFT", name: "Microsoft", quantity: 1, averageCost: 200 },
    ];
    const quotes = { AAPL: { price: 104, series: series([100, 101, 103, 102, 104]) }, MSFT: { price: 208, seriesByRange: { "日K": series([200, 202, 206, 204, 208]) } } };
    const returns = portfolioRiskReturns(quotes.AAPL);
    expect(returns.size).toBe(4);
    expect([...returns.values()][0]).toBeCloseTo(1, 6);
    const result = portfolioRiskMetrics(positions, quotes);
    expect(result.historicalCount).toBe(2);
    expect(result.historicalSampleCount).toBe(4);
    expect(result.historicalCoverage).toBe(100);
    expect(result.correlationPairs).toBe(1);
    expect(result.averageCorrelation).toBeCloseTo(1, 6);
    expect(result.weightedVolatility).toBeGreaterThan(0);
    expect(result.hasEnoughDataForRiskModel).toBe(true);
    expect(result.signals.map((signal) => signal.title)).toContain("历史风险指标已计算");
  });

  it("leaves historical risk metrics empty when history is too short or cannot overlap", () => {
    const makeSeries = (start, offset = 0) => [0, 1, 2].map((value) => ({ time: `2026-08-${String(start + value).padStart(2, "0")}`, close: 100 + offset + value }));
    const positions = [
      { id: "p1", symbol: "AAPL", name: "Apple", quantity: 1, averageCost: 100 },
      { id: "p2", symbol: "MSFT", name: "Microsoft", quantity: 1, averageCost: 200 },
    ];
    const result = portfolioRiskMetrics(positions, { AAPL: { price: 102, series: makeSeries(25) }, MSFT: { price: 202, series: makeSeries(30, 100) } });
    expect(result.weightedVolatility).toBeNull();
    expect(result.averageCorrelation).toBeNull();
    expect(result.correlationPairs).toBe(0);
    expect(result.hasEnoughDataForRiskModel).toBe(false);
    expect(result.signals.map((signal) => signal.title)).not.toContain("历史风险指标已计算");
  });

  it("exports a truthful report with blanks for unpriced positions", () => {
    const positions = [{ id: "p1", symbol: "AAPL", name: "Apple, Inc.", market: "US", quantity: 2, averageCost: 100, takeProfitPrice: 125 }, { id: "p2", symbol: "MSFT", name: "Microsoft", market: "US", quantity: 1, averageCost: 200 }];
    expect(portfolioReportRows(positions, { AAPL: { price: 125, asOf: "2026-08-29", source: "CAP" } })[1]).toMatchObject({ currentPrice: null, marketValue: null, quoteSource: "" });
    const csv = portfolioReportCsv(positions, { AAPL: { price: 125, asOf: "2026-08-29", source: "CAP" } });
    expect(csv).toContain('"Apple, Inc."');
    expect(csv).toContain("MSFT,Microsoft,US,1,200,");
    expect(csv).toContain("Apple, Inc.");
  });

  it("parses portfolio exports without importing runtime quote fields", () => {
    const parsed = parsePortfolioImport("代码,名称,市场,数量,平均成本,计划状态,现价,市值\nAAPL,Apple,NASDAQ,2,100,已执行,125,250\nMSFT,Microsoft,NASDAQ,0,200,执行中,300,300\nAAPL,Duplicate,NASDAQ,1,90,执行中,90,90\n");
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]).toMatchObject({ symbol: "AAPL", name: "Duplicate", quantity: 1, averageCost: 90, planStatus: "active" });
    expect(parsed.items[0]).not.toHaveProperty("currentPrice");
    expect(parsed.skipped).toBe(1);
    expect(parsed.errors).toMatchObject([{ line: 3 }]);
  });
});
