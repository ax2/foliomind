import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const chartMock = vi.hoisted(() => ({
  addSeries: vi.fn(),
  subscribeCrosshairMove: vi.fn(),
  unsubscribeCrosshairMove: vi.fn(),
  timeScale: vi.fn(() => ({ fitContent: vi.fn() })),
  remove: vi.fn(),
}));

vi.mock("lightweight-charts", () => ({
  AreaSeries: "area",
  CandlestickSeries: "candlestick",
  LineSeries: "line",
  createChart: vi.fn(() => chartMock),
}));

import { MarketChart, movingAverage, normalizeSeries } from "./MarketChart.jsx";

beforeEach(() => {
  vi.clearAllMocks();
  chartMock.addSeries.mockImplementation(() => ({ setData: vi.fn() }));
});

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

  it("calculates only complete moving-average windows from real points", () => {
    const points = normalizeSeries([
      { timestamp: 1788000000, close: 10 },
      { timestamp: 1788000060, close: 12 },
      { timestamp: 1788000120, close: 14 },
      { timestamp: 1788000180, close: 16 },
      { timestamp: 1788000240, close: 18 },
      { timestamp: 1788000300, close: 20 },
    ]);

    expect(movingAverage(points, 5).map((point) => point.value)).toEqual([14, 16]);
    expect(movingAverage(points, 20)).toEqual([]);
    expect(movingAverage(points, 0)).toEqual([]);
  });

  it("shows an exact exchange-aware tooltip when the crosshair moves", () => {
    render(<MarketChart market="NASDAQ" series={[
      { timestamp: "2026-01-15T14:55:00Z", close: 12 },
      { timestamp: "2026-01-15T14:56:00Z", close: 12.5 },
      { timestamp: "2026-01-15T14:57:00Z", close: 13 },
      { timestamp: "2026-01-15T14:58:00Z", close: 13.5 },
      { timestamp: "2026-01-15T14:59:00Z", close: 14 },
      { timestamp: "2026-01-15T15:00:00Z", close: 14.5 },
    ]} showMovingAverage />);
    const onCrosshairMove = chartMock.subscribeCrosshairMove.mock.calls[0][0];
    const priceSeries = chartMock.addSeries.mock.results[0].value;
    const averageSeries = chartMock.addSeries.mock.results[1].value;
    act(() => onCrosshairMove({
      point: { x: 80, y: 40 },
      time: 1768488900,
      seriesData: new Map([[priceSeries, { value: 14 }], [averageSeries, { value: 13 }]]),
    }));
    expect(screen.getByRole("status", { name: "图表数据明细" })).toHaveTextContent("美东时间");
    expect(screen.getByText("14.00")).toBeInTheDocument();
    expect(screen.getByText("13.00")).toBeInTheDocument();
  });
});
