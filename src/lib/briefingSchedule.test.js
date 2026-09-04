import { describe, expect, it } from "vitest";
import { briefingSlot, hasFreshPortfolioQuote, marketCodeForPosition, marketCodesForPositions, normalizeBriefingSchedule, SSE_MARKET_CODE, SZSE_MARKET_CODE } from "./briefingSchedule.js";

describe("portfolio briefing schedule", () => {
  const enabled = { enabled: true, closeTime: "15:35", retryMinutes: 15, calendarDate: "2026-09-01", calendarStatus: "trading" };
  it("uses Shanghai time and requires an authoritative trading calendar", () => {
    expect(briefingSlot({ now: "2026-09-01T07:34:00Z", schedule: enabled, positionCount: 1 }).status).toBe("not-due");
    expect(briefingSlot({ now: "2026-09-01T07:35:00Z", schedule: enabled, positionCount: 1 })).toMatchObject({ status: "due", key: "close:2026-09-01" });
    expect(briefingSlot({ now: "2026-09-02T08:00:00Z", schedule: enabled, positionCount: 1 }).status).toBe("calendar-needed");
    expect(briefingSlot({ now: "2026-09-01T08:00:00Z", schedule: { ...enabled, calendarStatus: "closed" }, positionCount: 1 }).status).toBe("market-closed");
  });
  it("deduplicates completed reviews and throttles failed retries", () => {
    const now = "2026-09-01T08:00:00Z";
    expect(briefingSlot({ now, schedule: enabled, positionCount: 1, reviews: [{ kind: "close", tradingDate: "2026-09-01" }] }).status).toBe("completed");
    expect(briefingSlot({ now, schedule: { ...enabled, lastAttemptAt: "2026-09-01T07:50:00Z" }, positionCount: 1 }).status).toBe("retry-wait");
  });
  it("requires a same-day real quote and sanitizes configuration", () => {
    const positions = [{ symbol: "AAPL" }];
    expect(hasFreshPortfolioQuote({ positions, liveQuotes: { AAPL: { price: 120, asOf: "2026-09-01T02:00:00Z" } }, now: "2026-09-01T08:00:00Z" })).toBe(true);
    expect(hasFreshPortfolioQuote({ positions: [{ symbol: "600519.SS" }], liveQuotes: { 600519: { price: 120, asOf: "2026-09-01T02:00:00Z" } }, now: "2026-09-01T08:00:00Z" })).toBe(true);
    expect(hasFreshPortfolioQuote({ positions, liveQuotes: { AAPL: { price: 120, asOf: "2026-08-31T02:00:00Z" } }, now: "2026-09-01T08:00:00Z" })).toBe(false);
    expect(hasFreshPortfolioQuote({ positions, liveQuotes: { AAPL: { price: 0, asOf: "2026-09-01T02:00:00Z" } }, now: "2026-09-01T08:00:00Z" })).toBe(false);
    expect(normalizeBriefingSchedule({ enabled: true, closeTime: "99:99", retryMinutes: 999 })).toMatchObject({ enabled: true, closeTime: "15:35", retryMinutes: 60, timeZone: "Asia/Shanghai" });
  });
  it("resolves mainland exchange calendars and fails closed for unsupported markets", () => {
    expect(marketCodeForPosition({ market: "沪深", symbol: "600519" })).toBe(SSE_MARKET_CODE);
    expect(marketCodeForPosition({ market: "沪深", symbol: "300750" })).toBe(SZSE_MARKET_CODE);
    expect(marketCodesForPositions([{ market: "沪深", symbol: "600519" }, { market: "沪深", symbol: "300750" }])).toEqual([SSE_MARKET_CODE, SZSE_MARKET_CODE]);
    expect(() => marketCodesForPositions([{ market: "NASDAQ", symbol: "AAPL" }])).toThrow("暂不支持美股交易日历");
    expect(() => marketCodeForPosition({ market: "沪深", symbol: "999999" })).toThrow("确定 A 股交易所");
    expect(() => marketCodeForPosition({ market: "RUSSELL 2000", symbol: "RUT" })).toThrow("暂不支持 RUSSELL 2000");
    expect(() => marketCodeForPosition({ market: "CUSTOM-USAGE", symbol: "123456" })).toThrow("暂不支持 CUSTOM-USAGE");
  });
});
