export function normalizePortfolioPosition(value) {
  if (!value || typeof value !== "object") return null;
  const symbol = String(value.symbol ?? "").trim().toUpperCase();
  const name = String(value.name ?? symbol).trim();
  const market = String(value.market ?? "").trim();
  const quantity = Number(value.quantity);
  const averageCost = Number(value.averageCost ?? value.average_cost);
  if (!symbol || !name || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(averageCost) || averageCost <= 0) return null;
  return {
    id: String(value.id ?? "").trim(),
    symbol,
    name,
    market,
    quantity,
    averageCost,
  };
}

function finite(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

export function portfolioMetrics(positions, liveQuotes) {
  const rows = (Array.isArray(positions) ? positions : []).map((position) => {
    const quote = liveQuotes?.[position.symbol];
    const currentPrice = finite(quote?.price);
    const costValue = position.quantity * position.averageCost;
    const marketValue = currentPrice == null ? null : position.quantity * currentPrice;
    const pnl = marketValue == null ? null : marketValue - costValue;
    const pnlPercent = pnl == null || costValue === 0 ? null : (pnl / costValue) * 100;
    return { ...position, quote, currentPrice, costValue, marketValue, pnl, pnlPercent, hasQuote: currentPrice != null };
  });
  const pricedRows = rows.filter((row) => row.hasQuote);
  const marketValue = pricedRows.reduce((total, row) => total + row.marketValue, 0);
  const costValue = rows.reduce((total, row) => total + row.costValue, 0);
  return {
    rows: rows.map((row) => ({ ...row, weight: marketValue > 0 && row.marketValue != null ? (row.marketValue / marketValue) * 100 : null })),
    totalCost: costValue,
    totalMarketValue: pricedRows.length ? marketValue : null,
    totalPnl: pricedRows.length ? pricedRows.reduce((total, row) => total + row.pnl, 0) : null,
    totalPnlPercent: pricedRows.length && costValue > 0 ? (pricedRows.reduce((total, row) => total + row.pnl, 0) / costValue) * 100 : null,
    pricedCount: pricedRows.length,
    totalCount: rows.length,
  };
}
