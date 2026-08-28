import { describe, expect, it } from "vitest";
import { formatAmount, formatPercent, formatPrice, formatQuoteField } from "./quoteFormatting.js";

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
});
