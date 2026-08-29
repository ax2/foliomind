import { describe, expect, it } from "vitest";
import { formatAmount, formatPercent, formatPrice, formatQuoteField, formatRefreshTime } from "./quoteFormatting.js";

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

  it("marks old refresh timestamps as potentially stale", () => {
    const now = Date.parse("2026-08-29T10:02:00Z");
    expect(formatRefreshTime("2026-08-29T10:00:00Z", now)).toContain("可能已过期");
    expect(formatRefreshTime("2026-08-29T10:01:30Z", now)).toContain("最近更新");
    expect(formatRefreshTime("", now)).toBe("尚未更新");
  });
});
