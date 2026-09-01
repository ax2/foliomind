export const RESEARCH_SORT_OPTIONS = Object.freeze([
  { id: "default", label: "默认顺序", field: null },
  { id: "price", label: "最新价", field: "price" },
  { id: "change", label: "涨跌幅", field: "change" },
  { id: "pe", label: "市盈率", field: "pe" },
  { id: "pb", label: "市净率", field: "pb" },
]);

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
