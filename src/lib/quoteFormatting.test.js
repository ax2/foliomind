import { describe, expect, it } from "vitest";
import { changeToneClass, formatAmount, formatPercent, formatPrice, formatQuoteField, formatQuoteFreshness, formatRefreshTime, quoteFreshness } from "./quoteFormatting.js";

describe("quote formatting", () => {
  it("uses market-friendly price and amount units", () => {
    expect(formatPrice(1297.4)).toBe("1,297.40");
    expect(formatPrice(0.1234)).toBe("0.1234");
    expect(formatAmount(1612600, "volume")).toBe("161.26 万股");
    expect(formatAmount(2086000000, "turnover")).toBe("20.86 亿");
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

  it("accepts unix-second and unix-millisecond provider timestamps", () => {
    const now = Date.parse("2026-08-29T10:00:00Z");
    expect(quoteFreshness(String(Math.floor((now - 60_000) / 1000)), now).state).toBe("fresh");
    expect(quoteFreshness(now - 60_000, now).state).toBe("fresh");
  });
});
