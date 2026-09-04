import { quoteForSymbol, quoteFreshness } from "./quoteFormatting.js";

const numberValue = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const severityFor = (type, value) => {
  if (type === "price") return Math.abs(value) >= 8 ? "critical" : "warning";
  return value >= 5 ? "critical" : "warning";
};

/**
 * Derive a small, explainable anomaly list from the quote fields already
 * returned by the data provider. Missing fields intentionally produce no
 * anomaly instead of an estimate.
 */
export function detectMarketAnomalies(watchlist = [], liveQuotes = {}, options = {}) {
  const priceThreshold = numberValue(options.priceThreshold) ?? 4;
  const volumeThreshold = numberValue(options.volumeThreshold) ?? 2.5;
  if (priceThreshold <= 0 || volumeThreshold <= 0) return [];

  const anomalies = [];
  for (const item of watchlist) {
    const quote = quoteForSymbol(liveQuotes, item.symbol);
    const price = numberValue(quote?.price);
    const change = numberValue(quote?.change);
    const asOf = String(quote?.asOf || "");
    const source = String(quote?.source || "数据服务");
    const freshness = quoteFreshness(quote?.asOf, options.now, options.staleAfterMs);
    if (freshness.state === "stale") continue;
    if (price != null && change != null && Math.abs(change) >= priceThreshold) {
      anomalies.push({
        id: `${item.symbol}:price`, symbol: item.symbol, name: item.name, market: item.market,
        type: "price", severity: severityFor("price", change), value: change,
        threshold: priceThreshold, price, asOf, source,
      });
    }
    const volumeRatio = numberValue(quote?.volumeRatio);
    if (price != null && volumeRatio != null && volumeRatio >= volumeThreshold) {
      anomalies.push({
        id: `${item.symbol}:volume`, symbol: item.symbol, name: item.name, market: item.market,
        type: "volume", severity: severityFor("volume", volumeRatio), value: volumeRatio,
        threshold: volumeThreshold, price, asOf, source,
      });
    }
  }
  return anomalies.sort((left, right) => {
    const severityWeight = { critical: 0, warning: 1 };
    return (severityWeight[left.severity] - severityWeight[right.severity]) || Math.abs(right.value) - Math.abs(left.value);
  });
}

export function anomalyLabel(anomaly) {
  if (anomaly.type === "volume") return `量比 ${Number(anomaly.value).toFixed(2)} 倍`;
  return `${anomaly.value >= 0 ? "上涨" : "下跌"} ${Math.abs(anomaly.value).toFixed(2)}%`;
}
