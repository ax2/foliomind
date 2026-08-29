import { useEffect, useMemo, useRef } from "react";
import { AreaSeries, CandlestickSeries, createChart } from "lightweight-charts";

function normalizeSeries(series) {
  return (Array.isArray(series) ? series : []).map((point) => {
    const value = Number(point?.close ?? point?.price ?? point?.value);
    const rawTime = point?.time ?? point?.timestamp ?? point?.date;
    const date = typeof rawTime === "string" && !/^\d{4}-\d{2}-\d{2}$/.test(rawTime) ? new Date(rawTime) : null;
    const time = date && Number.isFinite(date.getTime()) ? Math.floor(date.getTime() / 1000) : rawTime;
    return { time, value, open: Number(point?.open), high: Number(point?.high), low: Number(point?.low), close: Number(point?.close ?? point?.value ?? point?.price) };
  }).filter((point) => point.time != null && Number.isFinite(point.value));
}

export function MarketChart({ series = [], range = "分时", loading = false, error = "", onRetry }) {
  const ref = useRef(null);
  const points = useMemo(() => normalizeSeries(series), [series]);
  useEffect(() => {
    if (!ref.current || points.length < 2) return undefined;
    const chart = createChart(ref.current, {
      autoSize: true,
      height: 280,
      layout: { background: { color: "transparent" }, textColor: "#7b8494", fontFamily: "Inter, PingFang SC, sans-serif", fontSize: 11 },
      grid: { vertLines: { color: "#f0f2f5" }, horzLines: { color: "#f0f2f5" } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.12, bottom: 0.12 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
      crosshair: { vertLine: { color: "#8ebcff", style: 2 }, horzLine: { color: "#8ebcff", style: 2 } },
    });
    const candles = range !== "分时" && range !== "5日" && points.every((point) => [point.open, point.high, point.low, point.close].every(Number.isFinite));
    const seriesView = candles ? chart.addSeries(CandlestickSeries, { upColor: "#18a66a", downColor: "#f04444", borderVisible: false, wickUpColor: "#18a66a", wickDownColor: "#f04444" }) : chart.addSeries(AreaSeries, { lineColor: "#1677ff", topColor: "rgba(22, 119, 255, 0.18)", bottomColor: "rgba(22, 119, 255, 0.01)", lineWidth: 2, priceLineVisible: false });
    seriesView.setData(candles ? points : points.map((point) => ({ time: point.time, value: point.value })));
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [points, range]);
  if (loading) return <div className="market-chart chart-empty" aria-label="正在获取真实行情">正在获取 {range} 真实数据…</div>;
  if (error) return <div className="market-chart chart-empty" role="status" aria-label={`${range}数据暂不可用`}><span>该周期暂时没有可用数据，系统会稍后自动重试。</span>{onRetry && <button className="secondary-button" onClick={onRetry}>立即重试</button>}</div>;
  if (points.length < 2) return <div className="market-chart chart-empty" aria-label={`暂无真实${range}数据`}>暂无真实{range}数据；有新数据后会自动显示。</div>;
  return <div className="market-chart" ref={ref} aria-label={`真实${range}数据图表`} />;
}
