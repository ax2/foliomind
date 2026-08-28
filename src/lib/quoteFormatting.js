const numberValue = (value) => Number(value);

export function formatPrice(value) {
  const number = numberValue(value);
  if (!Number.isFinite(number)) return "—";
  return number >= 1000 ? number.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : number >= 1 ? number.toFixed(2) : number.toFixed(4);
}

export function formatPercent(value) {
  const number = numberValue(value);
  return Number.isFinite(number) ? `${number >= 0 ? "+" : ""}${number.toFixed(2)}%` : "—";
}

export function formatAmount(value, kind) {
  const number = numberValue(value);
  if (!Number.isFinite(number)) return "—";
  if (kind === "volume") return number >= 100_000_000 ? `${(number / 100_000_000).toFixed(2)} 亿股` : number >= 10_000 ? `${(number / 10_000).toFixed(2)} 万股` : `${number.toLocaleString("zh-CN")} 股`;
  if (kind === "turnover" || kind === "marketCap" || kind === "floatMarketCap") return number >= 100_000_000_000 ? `${(number / 100_000_000_000).toFixed(2)} 千亿` : number >= 100_000_000 ? `${(number / 100_000_000).toFixed(2)} 亿` : `${number.toLocaleString("zh-CN")} 元`;
  return number.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}

export function formatQuoteField(key, value) {
  if (value == null || value === "") return "—";
  if (["open", "previousClose", "high", "low"].includes(key)) return formatPrice(value);
  if (key === "turnoverRate") {
    const number = numberValue(value);
    return Number.isFinite(number) ? `${number.toFixed(2)}%` : "—";
  }
  if (["volumeRatio", "pe", "pb"].includes(key)) {
    const number = numberValue(value);
    return Number.isFinite(number) ? number.toFixed(2) : "—";
  }
  if (["grossMargin", "netMargin", "roe"].includes(key)) {
    const number = numberValue(value);
    if (!Number.isFinite(number)) return String(value);
    const percent = Math.abs(number) <= 1 ? number * 100 : number;
    return `${percent.toFixed(2)}%`;
  }
  if (["revenue", "netProfit"].includes(key)) return formatAmount(value, "turnover");
  if (key === "volume") return formatAmount(value, "volume");
  if (["turnover", "marketCap", "floatMarketCap"].includes(key)) return formatAmount(value, key);
  return String(value);
}
