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

function csvCell(value) {
  const text = value == null ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Export only the user-owned watchlist contract; live quotes and credentials never enter the file. */
export function watchlistCsv(items) {
  const columns = [
    ["symbol", "代码"],
    ["name", "名称"],
    ["market", "市场"],
    ["category", "分类"],
    ["group", "分组"],
  ];
  const lines = [columns.map(([, label]) => csvCell(label)).join(",")];
  for (const item of Array.isArray(items) ? items : []) {
    const normalized = normalizeWatchlistItem(item);
    if (normalized.symbol && normalized.name) lines.push(columns.map(([key]) => csvCell(normalized[key])).join(","));
  }
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

function parseDelimitedLine(line) {
  const fields = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && line[index + 1] === '"' && quoted) { field += '"'; index += 1; continue; }
    if (char === '"') { quoted = !quoted; continue; }
    if (char === "," && !quoted) { fields.push(field.trim()); field = ""; continue; }
    field += char;
  }
  fields.push(field.trim());
  return fields;
}

function importedSymbol(value) {
  let token = String(value ?? "").trim().replace(/^\$/, "");
  if (!token) return null;
  let exchange = "";
  if (token.includes(":")) [exchange, token] = token.split(/:(.*)/s, 2);
  const suffix = token.match(/^(.+)\.(SH|SS|SZ|BJ|HK|US)$/i);
  if (suffix) { token = suffix[1]; exchange = exchange || suffix[2]; }
  token = token.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._-]{0,63}$/.test(token)) return null;
  const exchangeText = String(exchange).toUpperCase();
  const market = /^(SSE|SH|XSHG|SZSE|SZ|XSHE|BSE|BJ|沪|深|北)/.test(exchangeText)
    ? "A股"
    : /^(HKEX|HK|港)/.test(exchangeText)
      ? "港股"
      : /^(NASDAQ|NYSE|AMEX|US)/.test(exchangeText)
        ? "美股"
        : "自定义";
  return { symbol: token, market };
}

function headerKey(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[ _-]/g, "");
}

/**
 * Parse TradingView-style TXT lists and FolioMind CSV exports. Parsing is
 * deterministic and bounded so a malformed upload cannot partially mutate state.
 */
export function parseWatchlistImport(raw, { maxItems = 200 } = {}) {
  const source = String(raw ?? "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (source.length > 2_000_000) throw new Error("自选文件过大，请拆分后再导入（最大 2 MB）");
  const lines = source.split("\n");
  const firstIndex = lines.findIndex((line) => line.trim());
  const first = firstIndex >= 0 ? lines[firstIndex].trim() : "";
  const firstFields = parseDelimitedLine(first);
  const headerNames = firstFields.map(headerKey);
  const hasHeader = headerNames.some((key) => ["symbol", "ticker", "代码", "证券代码"].includes(key));
  const indexes = hasHeader ? {
    symbol: Math.max(0, headerNames.findIndex((key) => ["symbol", "ticker", "代码", "证券代码"].includes(key))),
    name: headerNames.findIndex((key) => ["name", "名称"].includes(key)),
    market: headerNames.findIndex((key) => ["market", "市场"].includes(key)),
    category: headerNames.findIndex((key) => ["category", "分类"].includes(key)),
    group: headerNames.findIndex((key) => ["group", "分组"].includes(key)),
  } : null;
  const items = [];
  const errors = [];
  const seen = new Set();
  let skipped = 0;
  for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
    const line = lines[lineNumber].trim();
    if (!line || line.startsWith("#") || (hasHeader && lineNumber === firstIndex)) continue;
    const fields = parseDelimitedLine(line);
    const symbolValue = indexes ? fields[indexes.symbol] : fields[0];
    const parsed = importedSymbol(symbolValue);
    if (!parsed) { errors.push({ line: lineNumber + 1, reason: "代码格式无法识别" }); continue; }
    if (seen.has(parsed.symbol)) { skipped += 1; continue; }
    if (items.length >= maxItems) { errors.push({ line: lineNumber + 1, reason: `最多导入 ${maxItems} 个标的` }); continue; }
    seen.add(parsed.symbol);
    items.push(normalizeWatchlistItem({
      symbol: parsed.symbol,
      name: indexes?.name >= 0 ? fields[indexes.name] || parsed.symbol : parsed.symbol,
      market: indexes?.market >= 0 ? fields[indexes.market] || parsed.market : parsed.market,
      category: indexes?.category >= 0 ? fields[indexes.category] : "自选",
      group: indexes?.group >= 0 ? fields[indexes.group] : "",
    }));
  }
  return { items: items.filter((item) => item.symbol && item.name), skipped, errors };
}
