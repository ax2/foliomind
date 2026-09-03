import { useEffect, useMemo, useRef, useState } from "react";
import { AreaSeries, CandlestickSeries, LineSeries, createChart } from "lightweight-charts";
import { DataState } from "./DataState.jsx";
import { formatPrice, formatQuoteDateTime } from "../lib/quoteFormatting.js";

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

/**
 * Calculate a simple moving average from the already-normalized real series.
 * Returning an empty array for an invalid/insufficient window keeps the chart
 * honest: we never interpolate missing provider points or draw a synthetic
 * indicator before enough observations exist.
 */
export function movingAverage(points, period) {
  const windowSize = Number(period);
  if (!Number.isInteger(windowSize) || windowSize < 2 || !Array.isArray(points) || points.length < windowSize) return [];
  const result = [];
  const window = [];
  let sum = 0;
  for (let index = 0; index < points.length; index += 1) {
    const value = Number(points[index]?.value);
    if (!Number.isFinite(value)) {
      window.length = 0;
      sum = 0;
      continue;
    }
    window.push(value);
    sum += value;
    if (window.length > windowSize) sum -= window.shift();
    if (window.length === windowSize) result.push({ time: points[index].time, value: sum / windowSize });
  }
  return result;
}

export function MarketChart({ series = [], range = "分时", market = "", loading = false, error = "", onRetry, showGrid = true, showMovingAverage = false, showMovingAverage20 = false }) {
  const ref = useRef(null);
  const [hoveredPoint, setHoveredPoint] = useState(null);
  const points = useMemo(() => normalizeSeries(series), [series]);
  const movingAverage5 = useMemo(() => movingAverage(points, 5), [points]);
  const movingAverage20 = useMemo(() => movingAverage(points, 20), [points]);
  useEffect(() => {
    setHoveredPoint(null);
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
    const movingAverageViews = { five: null, twenty: null };
    if (showMovingAverage && movingAverage5.length >= 2) {
      const averageView = chart.addSeries(LineSeries, { color: "#f59e0b", lineWidth: 2, priceLineVisible: false, lastValueVisible: false, title: "MA5" });
      averageView.setData(movingAverage5);
      movingAverageViews.five = averageView;
    }
    if (showMovingAverage20 && movingAverage20.length >= 2) {
      const averageView = chart.addSeries(LineSeries, { color: "#8b5cf6", lineWidth: 2, priceLineVisible: false, lastValueVisible: false, title: "MA20" });
      averageView.setData(movingAverage20);
      movingAverageViews.twenty = averageView;
    }
    const valueFromSeries = (value) => {
      if (!value || typeof value !== "object") return {};
      return { value: Number.isFinite(Number(value.value)) ? Number(value.value) : null, open: Number.isFinite(Number(value.open)) ? Number(value.open) : null, high: Number.isFinite(Number(value.high)) ? Number(value.high) : null, low: Number.isFinite(Number(value.low)) ? Number(value.low) : null, close: Number.isFinite(Number(value.close)) ? Number(value.close) : null };
    };
    const onCrosshairMove = (param) => {
      const time = typeof param?.time === "number" && Number.isFinite(param.time) ? param.time : null;
      if (!param?.point || time == null || !param.seriesData) {
        setHoveredPoint(null);
        return;
      }
      const pricePoint = valueFromSeries(param.seriesData.get(seriesView));
      const fivePoint = valueFromSeries(movingAverageViews.five && param.seriesData.get(movingAverageViews.five));
      const twentyPoint = valueFromSeries(movingAverageViews.twenty && param.seriesData.get(movingAverageViews.twenty));
      if (![pricePoint.value, pricePoint.close, pricePoint.open].some((value) => Number.isFinite(value))) {
        setHoveredPoint(null);
        return;
      }
      setHoveredPoint({ time, ...pricePoint, ma5: fivePoint.value, ma20: twentyPoint.value });
    };
    chart.subscribeCrosshairMove(onCrosshairMove);
    chart.timeScale().fitContent();
    return () => {
      chart.unsubscribeCrosshairMove(onCrosshairMove);
      chart.remove();
    };
  }, [points, range, market, showGrid, showMovingAverage, showMovingAverage20, movingAverage5, movingAverage20]);
  if (loading) return <div className="market-chart chart-empty" aria-label="正在获取真实行情"><DataState compact state="loading" title={`正在获取${range}数据`} description="正在从已配置渠道获取真实行情。" /></div>;
  if (error) return <div className="market-chart chart-empty" aria-label={`${range}数据暂不可用`}><DataState compact state="error" title="该周期暂时没有可用数据" description="系统会稍后自动重试，也可以立即重新获取。" actionLabel={onRetry ? "立即重试" : ""} onAction={onRetry} /></div>;
  if (points.length < 2) return <div className="market-chart chart-empty" aria-label={`暂无真实${range}数据`}><DataState compact state="empty" title={`暂无真实${range}数据`} description="有新数据返回后会自动显示，空白区域不会使用示例走势填充。" /></div>;
  const displayValue = Number.isFinite(hoveredPoint?.close) ? hoveredPoint.close : hoveredPoint?.value;
  return <div className="market-chart market-chart-with-tooltip" ref={ref} aria-label={`真实${range}数据图表`}>
    {hoveredPoint && <div className="market-chart-tooltip" role="status" aria-label="图表数据明细">
      <strong>{formatQuoteDateTime(hoveredPoint.time * 1000, market)}</strong>
      <div className="market-chart-tooltip-values">
        {Number.isFinite(hoveredPoint.open) ? <span><small>开</small><b>{formatPrice(hoveredPoint.open)}</b></span> : null}
        {Number.isFinite(hoveredPoint.high) ? <span><small>高</small><b>{formatPrice(hoveredPoint.high)}</b></span> : null}
        {Number.isFinite(hoveredPoint.low) ? <span><small>低</small><b>{formatPrice(hoveredPoint.low)}</b></span> : null}
        {Number.isFinite(displayValue) ? <span><small>{Number.isFinite(hoveredPoint.close) ? "收" : "价"}</small><b>{formatPrice(displayValue)}</b></span> : null}
        {Number.isFinite(hoveredPoint.ma5) ? <span className="market-chart-tooltip-ma5"><small>MA5</small><b>{formatPrice(hoveredPoint.ma5)}</b></span> : null}
        {Number.isFinite(hoveredPoint.ma20) ? <span className="market-chart-tooltip-ma20"><small>MA20</small><b>{formatPrice(hoveredPoint.ma20)}</b></span> : null}
      </div>
    </div>}
  </div>;
}
