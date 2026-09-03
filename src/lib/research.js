export const RESEARCH_SORT_OPTIONS = Object.freeze([
  { id: "default", label: "默认顺序", field: null },
  { id: "price", label: "最新价", field: "price" },
  { id: "change", label: "涨跌幅", field: "change" },
  { id: "pe", label: "市盈率", field: "pe" },
  { id: "pb", label: "市净率", field: "pb" },
]);

export const RESEARCH_FILTER_FIELDS = Object.freeze([
  { id: "minChange", label: "涨跌幅下限", field: "change", suffix: "%", description: "只保留涨跌幅不低于该值的真实报价" },
  { id: "maxChange", label: "涨跌幅上限", field: "change", suffix: "%", description: "只保留涨跌幅不高于该值的真实报价" },
  { id: "maxPe", label: "市盈率上限", field: "pe", suffix: "", description: "只保留市盈率不高于该值的真实报价" },
  { id: "maxPb", label: "市净率上限", field: "pb", suffix: "", description: "只保留市净率不高于该值的真实报价" },
  { id: "minVolume", label: "成交量下限", field: "volume", suffix: "", description: "只保留成交量不低于该值的真实报价" },
]);

export const DEFAULT_RESEARCH_FILTERS = Object.freeze({
  minChange: "",
  maxChange: "",
  maxPe: "",
  maxPb: "",
  minVolume: "",
});

function finiteFilter(value) {
  if (value == null || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function normalizeResearchFilters(value) {
  const filters = value && typeof value === "object" ? value : {};
  return Object.fromEntries(Object.keys(DEFAULT_RESEARCH_FILTERS).map((key) => {
    const raw = filters[key];
    return [key, raw == null ? "" : String(raw).trim().slice(0, 24)];
  }));
}

/** Filter only by real quote fields; a configured bound excludes missing fields. */
export function filterResearchItems(items, quotes = {}, filters = DEFAULT_RESEARCH_FILTERS) {
  const normalized = normalizeResearchFilters(filters);
  return (Array.isArray(items) ? items : []).filter((item) => {
    const quote = quotes?.[item?.symbol];
    return RESEARCH_FILTER_FIELDS.every(({ id, field }) => {
      const bound = finiteFilter(normalized[id]);
      if (bound == null) return true;
      const actual = finiteFilter(quote?.[field]);
      if (actual == null) return false;
      if (id === "minChange" || id === "minVolume") return actual >= bound;
      return actual <= bound;
    });
  });
}

export function activeResearchFilterCount(filters = DEFAULT_RESEARCH_FILTERS) {
  return Object.values(normalizeResearchFilters(filters)).filter((value) => finiteFilter(value) != null).length;
}

/** Sort real quote fields for the research table; missing values always stay last. */
export function sortResearchItems(items, quotes = {}, sortKey = "default", direction = "desc") {
  const values = Array.isArray(items) ? items : [];
  const option = RESEARCH_SORT_OPTIONS.find((candidate) => candidate.id === sortKey);
  if (!option?.field) return [...values];
  const multiplier = direction === "asc" ? 1 : -1;
  return values.map((item, index) => ({ item, index })).sort((left, right) => {
    const numericValue = (value) => {
      if (value === null || value === undefined || String(value).trim() === "") return null;
      const number = Number(value);
      return Number.isFinite(number) ? number : null;
    };
    const leftValue = numericValue(quotes?.[left.item.symbol]?.[option.field]);
    const rightValue = numericValue(quotes?.[right.item.symbol]?.[option.field]);
    if (leftValue === null && rightValue === null) return left.index - right.index;
    if (leftValue === null) return 1;
    if (rightValue === null) return -1;
    return (leftValue - rightValue) * multiplier || left.index - right.index;
  }).map(({ item }) => item);
}
