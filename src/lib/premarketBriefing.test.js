import { describe, expect, it } from "vitest";
import { buildPremarketBriefing, normalizePremarketCommodities, normalizePremarketEvents, normalizePremarketIndices, normalizePremarketMarketNews, normalizePremarketNews } from "./premarketBriefing.js";

describe("premarket briefing", () => {
  it("normalizes nested real CAP news and rejects unsafe links", () => {
    const news = normalizePremarketNews({ data: { news: [{ headline: "真实公告", published_at: "2026-09-04T01:00:00Z", sourceName: "交易所", link: "javascript:alert(1)" }] } }, { symbol: "600519", name: "贵州茅台" });
    expect(news).toEqual([expect.objectContaining({ symbol: "600519", name: "贵州茅台", title: "真实公告", source: "交易所", url: "" })]);
  });

  it("builds holding sections while keeping unsupported sections empty", () => {
    const briefing = buildPremarketBriefing({
      positions: [{ symbol: "0700.HK", name: "腾讯控股" }],
      newsBySymbol: { "0700.HK": { result: { articles: [{ title: "业绩公告", published_at: "2026-09-03T23:00:00Z", source: "港交所" }] } } },
      events: normalizePremarketEvents({ events: [{ symbol: "HKEX:0700", date: "2026-09-07", title: "股东会", source: "港交所" }] }),
      createdAt: "2026-09-04T00:00:00Z",
    });
    expect(briefing.kind).toBe("premarket");
    expect(briefing.sections.holdings.items).toHaveLength(2);
    expect(briefing.sections.industry).toMatchObject({ status: "empty", items: [] });
    expect(briefing.sources).toEqual(["港交所"]);
  });

  it("does not create a briefing without positions", () => {
    expect(() => buildPremarketBriefing({ positions: [] })).toThrow("请先添加持仓");
  });

  it("normalizes verified market context without inventing values", () => {
    expect(normalizePremarketMarketNews({ data: { news: [{ headline: "利率决议", source: "央行", published_at: "2026-09-04" }] } })).toEqual([expect.objectContaining({ title: "利率决议", source: "央行" })]);
    expect(normalizePremarketIndices({ indices: [{ symbol: "SPX", price: 5000, timestamp: "2026-09-04" }] })).toEqual([expect.objectContaining({ title: "SPX", detail: expect.stringContaining("5000") })]);
    expect(normalizePremarketCommodities({ data: [{ commodity_name: "WTI", price: 72, unit: "USD" }] })).toEqual([expect.objectContaining({ title: "WTI", detail: expect.stringContaining("72") })]);
  });

  it("fills context sections only from returned records", () => {
    const briefing = buildPremarketBriefing({ positions: [{ symbol: "600519", name: "贵州茅台" }], industryNews: [{ title: "白酒行业动态", source: "数据服务" }], macroNews: [], overseas: [{ title: "SPX", detail: "5000", source: "数据服务" }] });
    expect(briefing.sections.industry.status).toBe("available");
    expect(briefing.sections.macro.status).toBe("empty");
    expect(briefing.sections.overseas.status).toBe("available");
  });
});
