import { describe, expect, it } from "vitest";
import { changeToneClass, formatAmount, formatCompactQuoteFreshness, formatPercent, formatPrice, formatQuoteField, formatQuoteFreshness, formatRefreshTime, isValidQuotePrice, marketTimeZone, quoteFreshness } from "./quoteFormatting.js";

describe("quote formatting", () => {
  it("uses market-friendly price and amount units", () => {
    expect(formatPrice(1297.4)).toBe("1,297.40");
    expect(formatPrice(0.1234)).toBe("0.1234");
    expect(formatAmount(1612600, "volume")).toBe("161.26 万股");
    expect(formatAmount(2086000000, "turnover")).toBe("20.86 亿");
  });

  it("accepts only finite positive quote prices", () => {
    expect(isValidQuotePrice(12.3)).toBe(true);
    expect(isValidQuotePrice("12.3")).toBe(true);
    expect(isValidQuotePrice(0)).toBe(false);
    expect(isValidQuotePrice(-1)).toBe(false);
    expect(isValidQuotePrice(" ")).toBe(false);
    expect(isValidQuotePrice(null)).toBe(false);
  });

  it("normalizes signed percentages and ratio-style margins", () => {
    expect(formatPercent(-1.21)).toBe("-1.21%");
    expect(formatQuoteField("turnoverRate", 0.28)).toBe("0.28%");
    expect(formatQuoteField("grossMargin", 0.8895)).toBe("88.95%");
    expect(formatQuoteField("roe", 33.65)).toBe("33.65%");
  });

  it("keeps missing and flat changes visually neutral", () => {
    expect(changeToneClass(1.2)).toBe("up");
    expect(changeToneClass(-1.2)).toBe("down");
    expect(changeToneClass(0)).toBe("");
    expect(changeToneClass(undefined)).toBe("");
    expect(changeToneClass("not-a-number")).toBe("");
  });

  it("marks old refresh timestamps as potentially stale", () => {
    const now = Date.parse("2026-08-29T10:02:00Z");
    expect(formatRefreshTime("2026-08-29T10:00:00Z", now)).toContain("可能已过期");
    expect(formatRefreshTime("2026-08-29T10:01:30Z", now)).toContain("最近更新");
    expect(formatRefreshTime("", now)).toBe("尚未更新");
  });

  it("classifies provider timestamps without claiming unknown data is fresh", () => {
    const now = Date.parse("2026-08-29T10:00:00Z");
    expect(quoteFreshness("2026-08-29T09:55:00Z", now).state).toBe("fresh");
    expect(quoteFreshness("2026-08-29T09:30:00Z", now).state).toBe("stale");
    expect(quoteFreshness("", now).state).toBe("unknown");
    expect(formatQuoteFreshness("", now)).toBe("数据时间未知");
  });

  it("provides compact freshness copy for dense watchlist rows", () => {
    const now = Date.parse("2026-08-29T10:00:00Z");
    expect(formatCompactQuoteFreshness("2026-08-29T09:55:00Z", now)).toMatch(/^新鲜 · \d{2}:\d{2}$/);
    expect(formatCompactQuoteFreshness("2026-08-29T09:30:00Z", now)).toMatch(/^可能延迟 · \d{2}:\d{2}$/);
    expect(formatCompactQuoteFreshness("", now)).toBe("时间未知");
  });

  it("labels known market timestamps in their exchange timezone", () => {
    const now = Date.parse("2026-01-15T15:00:00Z");
    expect(marketTimeZone("NASDAQ")).toMatchObject({ timeZone: "America/New_York", label: "美东时间" });
    expect(formatQuoteFreshness("2026-01-15T14:55:00Z", now, "NASDAQ")).toMatch(/09:55:00.*美东时间/);
    expect(formatQuoteFreshness("2026-07-15T13:55:00Z", Date.parse("2026-07-15T14:00:00Z"), "NASDAQ")).toMatch(/09:55:00.*美东时间/);
    expect(formatCompactQuoteFreshness("2026-01-15T14:55:00Z", now, "HKEX")).toContain("香港时间");
    expect(formatQuoteFreshness("2026-01-15T14:55:00Z", now, "自定义市场")).toContain("时区未知");
  });

  it("accepts unix-second and unix-millisecond provider timestamps", () => {
    const now = Date.parse("2026-08-29T10:00:00Z");
    expect(quoteFreshness(String(Math.floor((now - 60_000) / 1000)), now).state).toBe("fresh");
    expect(quoteFreshness(now - 60_000, now).state).toBe("fresh");
  });
});
