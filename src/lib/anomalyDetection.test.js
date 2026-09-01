import { describe, expect, it } from "vitest";
import { anomalyLabel, detectMarketAnomalies } from "./anomalyDetection.js";

const watchlist = [{ symbol: "600519", name: "贵州茅台", market: "A股" }, { symbol: "AAPL", name: "Apple", market: "美股" }];

describe("market anomaly detection", () => {
  it("only emits anomalies when real quote fields are present", () => {
    const asOf = new Date(Date.now() - 60_000).toISOString();
    expect(detectMarketAnomalies(watchlist, {
      "600519": { price: 100, change: 4.2, volumeRatio: 3.1, asOf, source: "provider" },
      AAPL: { price: 200, change: null },
    })).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "600519:price", severity: "warning", value: 4.2 }),
      expect.objectContaining({ id: "600519:volume", severity: "warning", value: 3.1 }),
    ]));
    expect(detectMarketAnomalies(watchlist, { AAPL: { price: 200, change: null, volumeRatio: null } })).toEqual([]);
  });

  it("sorts critical anomalies first and keeps thresholds explainable", () => {
    const result = detectMarketAnomalies(watchlist, {
      "600519": { price: 100, change: 9 },
      AAPL: { price: 200, change: 2, volumeRatio: 6 },
    });
    expect(result[0]).toMatchObject({ id: "600519:price", severity: "critical", threshold: 4 });
    expect(result[1]).toMatchObject({ id: "AAPL:volume", severity: "critical", threshold: 2.5 });
    expect(anomalyLabel(result[0])).toBe("上涨 9.00%");
  });

  it("does not fabricate values for invalid thresholds", () => {
    expect(detectMarketAnomalies(watchlist, { "600519": { price: 100, change: 20 } }, { priceThreshold: 0 })).toEqual([]);
  });

  it("does not turn an old quote into a current anomaly", () => {
    expect(detectMarketAnomalies(watchlist, {
      "600519": { price: 100, change: 9, volumeRatio: 4, asOf: "2026-09-01T09:00:00Z" },
    }, { now: Date.parse("2026-09-02T10:00:00Z") })).toEqual([]);
  });
});
