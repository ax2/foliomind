import { useEffect, useMemo, useRef } from "react";
import { AreaSeries, createChart } from "lightweight-charts";

function normalizeSeries(series) {
  return (Array.isArray(series) ? series : []).map((point) => {
    const value = Number(point?.value ?? point?.price ?? point?.close);
    const rawTime = point?.time ?? point?.timestamp ?? point?.date;
    const date = typeof rawTime === "string" && !/^\d{4}-\d{2}-\d{2}$/.test(rawTime) ? new Date(rawTime) : null;
    const time = date && Number.isFinite(date.getTime()) ? Math.floor(date.getTime() / 1000) : rawTime;
    return { time, value };
  }).filter((point) => point.time != null && Number.isFinite(point.value));
}

export function MarketChart({ series = [] }) {
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
    const area = chart.addSeries(AreaSeries, { lineColor: "#1677ff", topColor: "rgba(22, 119, 255, 0.18)", bottomColor: "rgba(22, 119, 255, 0.01)", lineWidth: 2, priceLineVisible: false });
    area.setData(points);
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [points]);
  if (points.length < 2) return <div className="market-chart chart-empty" aria-label="暂无真实分时数据">暂无真实分时数据。查询行情后显示图表。</div>;
  return <div className="market-chart" ref={ref} aria-label="真实分时数据图表" />;
}
