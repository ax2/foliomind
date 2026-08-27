import { useEffect, useRef } from "react";
import { AreaSeries, createChart, HistogramSeries, LineSeries } from "lightweight-charts";
import { intradaySeries } from "../data/market.js";

export function MarketChart() {
  const ref = useRef(null);

  useEffect(() => {
    if (!ref.current) return undefined;
    const chart = createChart(ref.current, {
      autoSize: true,
      height: 280,
      layout: { background: { color: "transparent" }, textColor: "#7b8494", fontFamily: "Inter, PingFang SC, sans-serif", fontSize: 11 },
      grid: { vertLines: { color: "#f0f2f5" }, horzLines: { color: "#f0f2f5" } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.12, bottom: 0.12 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
      crosshair: { vertLine: { color: "#8ebcff", style: 2 }, horzLine: { color: "#8ebcff", style: 2 } },
    });
    const series = chart.addSeries(AreaSeries, {
      lineColor: "#1677ff",
      topColor: "rgba(22, 119, 255, 0.18)",
      bottomColor: "rgba(22, 119, 255, 0.01)",
      lineWidth: 2,
      priceLineVisible: false,
    });
    series.setData(intradaySeries);
    const average = chart.addSeries(LineSeries, { color: "#f5a524", lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    average.setData(intradaySeries.map((point, index, values) => ({
      time: point.time,
      value: Number((values.slice(0, index + 1).reduce((sum, item) => sum + item.value, 0) / (index + 1)).toFixed(2)),
    })));
    const volume = chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, priceScaleId: "volume", lastValueVisible: false, priceLineVisible: false });
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    volume.setData(intradaySeries.map((point, index) => ({ time: point.time, value: 3800 + ((index * 791) % 6800), color: index % 3 === 0 ? "rgba(240,68,68,.6)" : "rgba(24,166,106,.55)" })));
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, []);

  return <div className="market-chart" ref={ref} aria-label="贵州茅台分时行情图" />;
}
