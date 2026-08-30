import { portfolioMetrics, portfolioRiskMetrics } from "./portfolio.js";

const DISCLAIMER = "本复盘仅整理已返回的真实数据，不构成投资建议或交易指令。";

function isoDay(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function latestTimestamp(values) {
  let latest = null;
  let latestTime = -Infinity;
  for (const value of values) {
    const text = String(value || "").trim();
    if (!text) continue;
    const time = Date.parse(text);
    if (Number.isFinite(time) && time > latestTime) { latest = text; latestTime = time; }
    else if (!Number.isFinite(time) && latest == null) latest = text;
  }
  return latest;
}

function upcomingPortfolioEvents(events, symbols, createdAt) {
  const start = new Date(createdAt).getTime();
  const end = start + 7 * 86_400_000;
  return (Array.isArray(events) ? events : []).flatMap((event) => {
    const time = Date.parse(event?.date);
    const symbol = String(event?.symbol || "").toUpperCase();
    if (!symbols.has(symbol) || !Number.isFinite(time) || time < start || time > end) return [];
    return [{ symbol, name: String(event?.name || symbol), date: String(event.date), type: String(event?.type || "公司事件"), title: String(event?.title || "未命名事件"), source: String(event?.source || "数据服务"), url: String(event?.url || "") }];
  }).sort((left, right) => Date.parse(left.date) - Date.parse(right.date)).slice(0, 12);
}

/** Build a reproducible close review from real quotes already held by the client. */
export function createPortfolioReviewSnapshot({ positions, liveQuotes, events = [], createdAt = new Date().toISOString(), id = "" }) {
  const metrics = portfolioMetrics(positions, liveQuotes);
  if (!metrics.totalCount) throw new Error("请先添加持仓，再生成复盘");
  if (!metrics.pricedCount) throw new Error("当前没有真实持仓行情，请先刷新数据");
  const risk = portfolioRiskMetrics(positions, liveQuotes);
  const priced = metrics.rows.filter((row) => row.hasQuote).map((row) => ({
    symbol: row.symbol, name: row.name, currentPrice: row.currentPrice, pnl: row.pnl, pnlPercent: row.pnlPercent,
    weight: row.weight, asOf: String(row.quote?.asOf || ""), source: String(row.quote?.source || "数据服务"),
  }));
  const ranked = [...priced].sort((left, right) => (right.pnlPercent ?? -Infinity) - (left.pnlPercent ?? -Infinity));
  const symbols = new Set(metrics.rows.map((row) => String(row.symbol).toUpperCase()));
  const sources = [...new Set(priced.map((row) => row.source).filter(Boolean))].slice(0, 12);
  return {
    id: String(id || `review-${createdAt}`), kind: "close", tradingDate: isoDay(createdAt), createdAt,
    asOf: latestTimestamp(priced.map((row) => row.asOf)), pricedCount: metrics.pricedCount, totalCount: metrics.totalCount,
    totalCost: metrics.totalCost, totalMarketValue: metrics.totalMarketValue, totalPnl: metrics.totalPnl, totalPnlPercent: metrics.totalPnlPercent,
    topGainer: ranked[0] || null, topLoser: ranked.at(-1) || null,
    positions: priced, riskSignals: risk.signals.slice(0, 8).map((signal) => ({ level: signal.level, title: signal.title, detail: signal.detail })),
    upcomingEvents: upcomingPortfolioEvents(events, symbols, createdAt), sources, disclaimer: DISCLAIMER,
  };
}

export { DISCLAIMER as PORTFOLIO_REVIEW_DISCLAIMER };
