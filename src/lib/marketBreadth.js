/**
 * Summarize the current watchlist using only quotes that contain a real price.
 * Missing fields stay missing; no preview or inferred values enter the summary.
 */
export function marketBreadth(watchlist = [], liveQuotes = {}) {
  const items = Array.isArray(watchlist) ? watchlist : [];
  const rows = items.map((item) => {
    const symbol = String(item?.symbol || "").trim().toUpperCase();
    const quote = liveQuotes?.[symbol] || liveQuotes?.[item?.symbol];
    const price = Number(quote?.price);
    const change = Number(quote?.change);
    if (!Number.isFinite(price) || price <= 0) return null;
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
    missingCount: Math.max(0, items.length - rows.length),
    upCount: changes.filter((row) => row.change > 0).length,
    downCount: changes.filter((row) => row.change < 0).length,
    flatCount: changes.filter((row) => row.change === 0).length,
    topGainer,
    topLoser,
  };
}
