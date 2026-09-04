import { describe, expect, it } from "vitest";
import { createPortfolioReviewSnapshot } from "./portfolioReview.js";

const positions = [
  { id: "p1", symbol: "AAPL", name: "Apple", market: "NASDAQ", quantity: 2, averageCost: 100 },
  { id: "p2", symbol: "MSFT", name: "Microsoft", market: "NASDAQ", quantity: 1, averageCost: 300 },
];

describe("portfolio close review", () => {
  it("creates a source-backed snapshot without inventing missing prices", () => {
    const review = createPortfolioReviewSnapshot({
      positions,
      liveQuotes: { AAPL: { price: 120, asOf: "2026-08-30T08:00:00Z", source: "provider-a" } },
      events: [{ symbol: "AAPL", name: "Apple", date: "2026-09-02", type: "财报", title: "季度财报", source: "provider-b" }, { symbol: "TSLA", date: "2026-09-01", title: "无关事件" }],
      createdAt: "2026-08-30T10:00:00Z",
    });
    expect(review).toMatchObject({ tradingDate: "2026-08-30", pricedCount: 1, totalCount: 2, totalPnl: 40, totalPnlPercent: 8, sources: ["provider-a"] });
    expect(review.positions).toHaveLength(1);
    expect(review.upcomingEvents).toMatchObject([{ symbol: "AAPL", title: "季度财报" }]);
    expect(JSON.stringify(review)).not.toContain("TSLA");
  });

  it("rejects snapshots without positions or real quotes", () => {
    expect(() => createPortfolioReviewSnapshot({ positions: [], liveQuotes: {} })).toThrow("请先添加持仓");
    expect(() => createPortfolioReviewSnapshot({ positions, liveQuotes: {} })).toThrow("当前没有真实持仓行情");
  });

  it("matches provider exchange suffixes and Shanghai calendar dates", () => {
    const review = createPortfolioReviewSnapshot({
      positions: [{ id: "hk-1", symbol: "0700.HK", name: "Tencent", market: "HKEX", quantity: 1, averageCost: 300 }],
      liveQuotes: { "HKEX:0700": { price: 320, asOf: "2026-08-30T08:00:00Z", source: "provider-hk" } },
      events: [
        { symbol: "0700", date: "2026-09-06T16:30:00Z", title: "香港市场事件" },
        { symbol: "0700.HK", date: "2026-09-07", title: "日期边界事件" },
        { symbol: "0700", date: "2026-09-08", title: "窗口外事件" },
      ],
      createdAt: "2026-08-30T16:30:00Z",
    });
    expect(review.tradingDate).toBe("2026-08-31");
    expect(review.upcomingEvents.map((event) => event.title)).toEqual(["香港市场事件", "日期边界事件"]);
  });
});
