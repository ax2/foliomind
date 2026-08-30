export const WATCHLIST_DEFAULT_GROUP = "自选";

export const WATCHLIST_SORT_OPTIONS = Object.freeze([
  { id: "custom", label: "自定义顺序" },
  { id: "name", label: "名称" },
  { id: "price", label: "最新价" },
  { id: "change", label: "涨跌幅" },
]);

function text(value, max = 64) {
  return String(value ?? "").trim().slice(0, max);
}

/** Resolve a stable, user-facing group from a market label for legacy items. */
export function watchlistGroupForMarket(market, fallback = WATCHLIST_DEFAULT_GROUP) {
  const value = String(market ?? "").trim().toLocaleUpperCase("zh-CN");
  if (/NASDAQ|NYSE|AMEX|美股|US/.test(value)) return "美股";
  if (/HKEX|港股|香港|HK/.test(value)) return "港股";
  if (/沪|深|A股|SH|SS|SZ|BJ/.test(value)) return "A股";
  return text(fallback) || WATCHLIST_DEFAULT_GROUP;
}

export function normalizeWatchlistItem(item = {}) {
  const market = text(item.market);
  const group = text(item.group || item.groupId) || watchlistGroupForMarket(market);
  return {
    symbol: text(item.symbol).toUpperCase(),
    name: text(item.name, 128),
    market,
    category: text(item.category),
    group,
  };
}

export function sortWatchlistItems(items, quotes = {}, sortKey = "custom", direction = "asc") {
  const values = Array.isArray(items) ? items : [];
  if (sortKey === "custom") return [...values];
  const multiplier = direction === "desc" ? -1 : 1;
  const numericValue = (item) => {
    const quote = quotes?.[item.symbol];
    if (sortKey === "price") return Number.isFinite(Number(quote?.price)) ? Number(quote.price) : null;
    if (sortKey === "change") return Number.isFinite(Number(quote?.change)) ? Number(quote.change) : null;
    return null;
  };
  return values.map((item, index) => ({ item, index })).sort((left, right) => {
    if (sortKey === "name") {
      const result = String(left.item.name || left.item.symbol).localeCompare(String(right.item.name || right.item.symbol), "zh-CN");
      return result || left.index - right.index;
    }
    const leftValue = numericValue(left.item);
    const rightValue = numericValue(right.item);
    if (leftValue === null && rightValue === null) return left.index - right.index;
    if (leftValue === null) return 1;
    if (rightValue === null) return -1;
    const result = (leftValue - rightValue) * multiplier;
    return result || left.index - right.index;
  }).map(({ item }) => item);
}

