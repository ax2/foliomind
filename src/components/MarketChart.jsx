import { useEffect, useMemo, useRef } from "react";
import { AreaSeries, CandlestickSeries, LineSeries, createChart } from "lightweight-charts";
import { DataState } from "./DataState.jsx";

function chartTime(rawTime) {
  if (typeof rawTime === "number" && Number.isFinite(rawTime)) return rawTime > 10_000_000_000 ? Math.floor(rawTime / 1000) : Math.floor(rawTime);
  const text = String(rawTime ?? "").trim();
  if (!text) return null;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const number = Number(text);
    return Number.isFinite(number) ? (number > 10_000_000_000 ? Math.floor(number / 1000) : Math.floor(number)) : null;
  }
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : null;
}

function numericOrNaN(rawValue) {
  if (rawValue == null || rawValue === "") return Number.NaN;
  const value = Number(rawValue);
  return Number.isFinite(value) ? value : Number.NaN;
}

/**
 * Normalize provider series before handing them to lightweight-charts.
 * Providers occasionally return points out of order or repeat a timestamp;
 * lightweight-charts requires strictly ascending, unique times and otherwise
 * throws during render. The last point for a duplicated timestamp wins so a
 * later provider correction is not silently discarded.
 */
export function normalizeSeries(series) {
  const byTime = new Map();
  (Array.isArray(series) ? series : []).forEach((point) => {
    const time = chartTime(point?.time ?? point?.timestamp ?? point?.date);
    const value = numericOrNaN(point?.close ?? point?.price ?? point?.value);
    if (time == null || !Number.isFinite(value)) return;
    byTime.set(time, {
      time,
      value,
      open: numericOrNaN(point?.open),
      high: numericOrNaN(point?.high),
      low: numericOrNaN(point?.low),
      close: numericOrNaN(point?.close ?? point?.value ?? point?.price),
    });
  });
  return [...byTime.values()].sort((left, right) => left.time - right.time);
}

export function MarketChart({ series = [], range = "分时", loading = false, error = "", onRetry, showGrid = true, showMovingAverage = false }) {
  const ref = useRef(null);
  const points = useMemo(() => normalizeSeries(series), [series]);
  const movingAverage = useMemo(() => points.map((point, index) => {
    if (index < 4) return null;
    const window = points.slice(index - 4, index + 1);
    return { time: point.time, value: window.reduce((total, item) => total + item.value, 0) / window.length };
  }).filter(Boolean), [points]);
  useEffect(() => {
    if (!ref.current || points.length < 2) return undefined;
    const chart = createChart(ref.current, {
      autoSize: true,
      height: 280,
      layout: { background: { color: "transparent" }, textColor: "#7b8494", fontFamily: "Inter, PingFang SC, sans-serif", fontSize: 11 },
      grid: { vertLines: { color: showGrid ? "#f0f2f5" : "transparent" }, horzLines: { color: showGrid ? "#f0f2f5" : "transparent" } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.12, bottom: 0.12 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
      crosshair: { vertLine: { color: "#8ebcff", style: 2 }, horzLine: { color: "#8ebcff", style: 2 } },
    });
    const candles = range !== "分时" && range !== "5日" && points.every((point) => [point.open, point.high, point.low, point.close].every(Number.isFinite));
    const seriesView = candles ? chart.addSeries(CandlestickSeries, { upColor: "#18a66a", downColor: "#f04444", borderVisible: false, wickUpColor: "#18a66a", wickDownColor: "#f04444" }) : chart.addSeries(AreaSeries, { lineColor: "#1677ff", topColor: "rgba(22, 119, 255, 0.18)", bottomColor: "rgba(22, 119, 255, 0.01)", lineWidth: 2, priceLineVisible: false });
    seriesView.setData(candles ? points : points.map((point) => ({ time: point.time, value: point.value })));
    if (showMovingAverage && movingAverage.length >= 2) {
      const averageView = chart.addSeries(LineSeries, { color: "#f59e0b", lineWidth: 2, priceLineVisible: false, lastValueVisible: false, title: "MA5" });
      averageView.setData(movingAverage);
    }
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [points, range, showGrid, showMovingAverage, movingAverage]);
  if (loading) return <div className="market-chart chart-empty" aria-label="正在获取真实行情"><DataState compact state="loading" title={`正在获取${range}数据`} description="正在从已配置渠道获取真实行情。" /></div>;
  if (error) return <div className="market-chart chart-empty" aria-label={`${range}数据暂不可用`}><DataState compact state="error" title="该周期暂时没有可用数据" description="系统会稍后自动重试，也可以立即重新获取。" actionLabel={onRetry ? "立即重试" : ""} onAction={onRetry} /></div>;
  if (points.length < 2) return <div className="market-chart chart-empty" aria-label={`暂无真实${range}数据`}><DataState compact state="empty" title={`暂无真实${range}数据`} description="有新数据返回后会自动显示，空白区域不会使用示例走势填充。" /></div>;
  return <div className="market-chart" ref={ref} aria-label={`真实${range}数据图表`} />;
}
