import { describe, expect, it } from "vitest";
import { ANOMALY_ATTRIBUTION_DISCLAIMER, buildAttributionPrompt, normalizeAttribution, normalizeAttributionEvidence, portfolioAttributionContext } from "./anomalyAttribution.js";

describe("anomaly attribution", () => {
  const anomaly = { id: "quote-1-price", symbol: "600519", name: "贵州茅台", type: "price", value: 8.2, threshold: 4, asOf: "2026-08-31T08:00:00Z", source: "QVeris" };

  it("builds bounded real evidence and preserves source metadata", () => {
    const evidence = normalizeAttributionEvidence({
      quote: { price: 1_234.5, change: 8.2, volumeRatio: 3.1, asOf: "2026-08-31T08:00:00Z", source: "CAP" },
      news: [{ title: "公司发布公告", summary: "真实公告摘要", source: "交易所", url: "https://example.com/a", published_at: "2026-08-30T02:00:00Z" }],
      events: [{ event_type: "财报", description: "即将披露", date: "2026-09-01", source: "公司事件" }],
      capitalFlow: [{ main_net: 1200000, date: "2026-08-30", source: "资金流" }],
    });
    expect(evidence).toHaveLength(4);
    expect(evidence[1]).toMatchObject({ id: "news-1", title: "公司发布公告", url: "https://example.com/a" });
    expect(evidence[3].summary).toContain("+1,200,000");
    expect(normalizeAttributionEvidence({ news: [{ title: "不安全链接", url: "javascript:alert(1)", source: "未知" }] })[0].url).toBe("");
  });

  it("drops model drivers that do not reference a returned source", () => {
    const evidence = normalizeAttributionEvidence({ quote: { price: 100, change: 8, asOf: "2026-08-31", source: "CAP" }, news: [{ title: "已验证新闻", source: "媒体", published_at: "2026-08-30" }] });
    const result = normalizeAttribution({
      fact: "涨幅超过阈值",
      drivers: [{ text: "有证据的原因", evidenceIndex: [1] }, { text: "模型猜测", evidenceIndex: [] }],
      portfolioRelation: "不在持仓中",
      watchNext: ["核验公告"],
      asOf: "2026-08-31",
    }, { anomaly, evidence, portfolio: { summary: "不在持仓中" } });
    expect(result.drivers).toHaveLength(1);
    expect(result.drivers[0].references[0]).toMatchObject({ title: "已验证新闻", source: "媒体" });
    expect(result.disclaimer).toBe(ANOMALY_ATTRIBUTION_DISCLAIMER);
  });

  it("accepts tool-returned sources and keeps portfolio context numeric", () => {
    const portfolio = portfolioAttributionContext({ symbol: "600519", quantity: 10, averageCost: 100 }, { price: 120 });
    const result = normalizeAttribution({
      fact: "事实",
      drivers: [{ text: "工具来源", sourceIndex: [0] }],
      sources: [{ title: "公司公告", source: "交易所", url: "https://example.com/event", asOf: "2026-08-31" }],
      portfolioRelation: "持仓相关",
    }, { anomaly, evidence: [], portfolio });
    expect(result.drivers[0].references[0].url).toBe("https://example.com/event");
    expect(portfolio).toMatchObject({ hasPosition: true, unrealizedPnl: 200, summary: expect.stringContaining("+200.00") });
  });

  it("requires evidence in the generated prompt", () => {
    const prompt = buildAttributionPrompt({ anomaly, evidence: [{ id: "quote", title: "真实行情", summary: "最新价 100", source: "CAP" }], portfolio: { hasPosition: false } });
    expect(prompt).toContain("evidenceIndex");
    expect(prompt).toContain("不得补造新闻");
    expect(prompt).toContain("foliomind_data");
  });
});
