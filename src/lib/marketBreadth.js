import { quoteFreshness } from "./quoteFormatting.js";

const SUMMARY_FIELDS = Object.freeze(["price", "change", "volume", "turnover", "turnoverRate", "pe", "pb"]);

function currentQuoteRows(watchlist = [], liveQuotes = {}, options = {}) {
  const items = Array.isArray(watchlist) ? watchlist : [];
  const staleRows = [];
  const rows = items.map((item) => {
    const symbol = String(item?.symbol || "").trim().toUpperCase();
    const quote = liveQuotes?.[symbol] || liveQuotes?.[item?.symbol];
    const price = Number(quote?.price);
    if (!Number.isFinite(price) || price <= 0) return null;
    const freshness = quoteFreshness(quote?.asOf, options.now, options.staleAfterMs);
    if (freshness.state === "stale") {
      staleRows.push(symbol);
      return null;
    }
    return { symbol, name: String(item?.name || symbol), quote };
  }).filter(Boolean);
  return { items, rows, staleRows };
}

/**
 * Summarize the current watchlist using only quotes that contain a real price.
 * Explicitly stale quotes stay visible elsewhere, but must not drive a
 * current-market breadth summary. Unknown provider timestamps remain usable
 * because some valid CAP responses do not include an as-of field.
 */
export function marketBreadth(watchlist = [], liveQuotes = {}, options = {}) {
  const { items, rows: currentRows, staleRows } = currentQuoteRows(watchlist, liveQuotes, options);
  const rows = currentRows.map(({ symbol, name, quote }) => {
    const change = Number(quote?.change);
    return {
      symbol,
      name,
      change: Number.isFinite(change) ? change : null,
      asOf: quote?.asOf || null,
      source: quote?.source || "数据服务",
    };
  });
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

function summarizeValues(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return { count: 0, min: null, max: null, average: null, median: null };
  const middle = Math.floor(sorted.length / 2);
  return {
    count: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    average: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
  };
}

function numericFieldValue(value) {
  if (value == null || value === "") return NaN;
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
}

/**
 * Summarize numeric fields from current, non-stale watchlist quotes.
 * Missing fields are excluded independently, so one incomplete quote does not
 * hide valid values from the other fields.
 */
export function marketWatchlistSummary(watchlist = [], liveQuotes = {}, options = {}) {
  const { rows, staleRows } = currentQuoteRows(watchlist, liveQuotes, options);
  const fields = Object.fromEntries(SUMMARY_FIELDS.map((field) => [field, summarizeValues(rows.map(({ quote }) => numericFieldValue(quote?.[field])))]));
  return {
    eligibleCount: rows.length,
    staleCount: staleRows.length,
    fields,
  };
}
