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

/**
 * Returns transparent portfolio risk signals derived only from values that
 * have actually been returned by the data channel. No risk score is emitted
 * when the inputs are incomplete.
 */
export function portfolioRiskMetrics(positions, liveQuotes) {
  const metrics = portfolioMetrics(positions, liveQuotes);
  const pricedRows = metrics.rows.filter((row) => row.hasQuote);
  const missingRows = metrics.rows.filter((row) => !row.hasQuote);
  const topPosition = [...pricedRows].sort((left, right) => (right.weight ?? 0) - (left.weight ?? 0))[0] || null;
  const totalCost = metrics.totalCost;
  const missingCost = missingRows.reduce((total, row) => total + row.costValue, 0);
  const missingCostWeight = totalCost > 0 ? (missingCost / totalCost) * 100 : null;
  const pricedCoverage = metrics.totalCount > 0 ? (metrics.pricedCount / metrics.totalCount) * 100 : null;
  const signals = [];
  if (topPosition?.weight >= 50) {
    signals.push({ level: "critical", title: "单一标的集中度较高", detail: `${topPosition.name} 占已计价组合 ${topPosition.weight.toFixed(1)}%，建议确认是否符合你的风险上限。` });
  } else if (topPosition?.weight >= 30) {
    signals.push({ level: "warning", title: "存在集中度暴露", detail: `${topPosition.name} 占已计价组合 ${topPosition.weight.toFixed(1)}%，可以考虑设置单标的上限。` });
  }
  if (missingRows.length > 0) {
    signals.push({ level: "info", title: "部分持仓缺少现价", detail: `${missingRows.length} 个持仓暂未返回真实行情，${missingCostWeight == null ? "暂无法计算" : `约 ${missingCostWeight.toFixed(1)}% 成本暴露`}未纳入市值和盈亏。` });
  }
  if (pricedRows.length >= 2 && pricedRows.every((row) => !Array.isArray(row.quote?.series) || row.quote.series.length < 2)) {
    signals.push({ level: "info", title: "波动率与相关性尚未计算", detail: "当前没有足够的真实历史序列；补齐历史数据后才会计算波动率和相关性。" });
  }
  return {
    topPosition,
    topWeight: topPosition?.weight ?? null,
    pricedCoverage,
    missingCostWeight,
    signals,
    hasEnoughDataForRiskModel: pricedRows.length >= 2 && pricedRows.every((row) => Array.isArray(row.quote?.series) && row.quote.series.length >= 2),
  };
}
