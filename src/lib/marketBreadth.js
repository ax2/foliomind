import { quoteFreshness } from "./quoteFormatting.js";

/**
 * Summarize the current watchlist using only quotes that contain a real price.
 * Explicitly stale quotes stay visible elsewhere, but must not drive a
 * current-market breadth summary. Unknown provider timestamps remain usable
 * because some valid CAP responses do not include an as-of field.
 */
export function marketBreadth(watchlist = [], liveQuotes = {}, options = {}) {
  const items = Array.isArray(watchlist) ? watchlist : [];
  const staleRows = [];
  const rows = items.map((item) => {
    const symbol = String(item?.symbol || "").trim().toUpperCase();
    const quote = liveQuotes?.[symbol] || liveQuotes?.[item?.symbol];
    const price = Number(quote?.price);
    const change = Number(quote?.change);
    if (!Number.isFinite(price) || price <= 0) return null;
    const freshness = quoteFreshness(quote?.asOf, options.now, options.staleAfterMs);
    if (freshness.state === "stale") {
      staleRows.push(symbol);
      return null;
    }
    return {
      symbol,
      name: String(item?.name || symbol),
      change: Number.isFinite(change) ? change : null,
      asOf: quote?.asOf || null,
      source: quote?.source || "数据服务",
    };
  }).filter(Boolean);
  const changes = rows.filter((row) => Number.isFinite(row.change));
  const topGainer = changes.filter((row) => row.change > 0).reduce((best, row) => !best || row.change > best.change ? row : best, null);
  const topLoser = changes.filter((row) => row.change < 0).reduce((best, row) => !best || row.change < best.change ? row : best, null);
  return {
    totalCount: items.length,
    pricedCount: rows.length,
    changeCount: changes.length,
    staleCount: staleRows.length,
    missingCount: Math.max(0, items.length - rows.length - staleRows.length),
    upCount: changes.filter((row) => row.change > 0).length,
    downCount: changes.filter((row) => row.change < 0).length,
    flatCount: changes.filter((row) => row.change === 0).length,
    topGainer,
    topLoser,
  };
}
