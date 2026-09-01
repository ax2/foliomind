import { describe, expect, it } from "vitest";
import { normalizeSeries } from "./MarketChart.jsx";

describe("normalizeSeries", () => {
  it("sorts provider points and keeps the latest duplicate timestamp", () => {
    const result = normalizeSeries([
      { date: "2026-08-30T08:00:00Z", close: 130 },
      { date: "2026-08-28", close: 128 },
      { date: "2026-08-30T08:00:00Z", close: 131 },
      { date: "2026-08-29", close: 129 },
    ]);

    expect(result.map((point) => point.value)).toEqual([128, 129, 131]);
    expect(result.every((point, index) => index === 0 || point.time > result[index - 1].time)).toBe(true);
  });

  it("normalizes epoch milliseconds and rejects unusable timestamps or values", () => {
    const result = normalizeSeries([
      { timestamp: 1788000000000, value: 12.5 },
      { timestamp: "1788000060", value: 13 },
      { timestamp: "not-a-date", value: 99 },
      { timestamp: "1788000120", value: "not-a-number" },
    ]);

    expect(result).toHaveLength(2);
    expect(result.map((point) => point.time)).toEqual([1788000000, 1788000060]);
    expect(result.map((point) => point.value)).toEqual([12.5, 13]);
  });

  it("does not treat missing OHLC values as zero", () => {
    const [point] = normalizeSeries([{ timestamp: 1788000000, close: 12.5, open: null, high: "", low: undefined }]);

    expect(point.value).toBe(12.5);
    expect(point.open).toBeNaN();
    expect(point.high).toBeNaN();
    expect(point.low).toBeNaN();
    expect(point.close).toBe(12.5);
  });
});
