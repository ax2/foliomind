const SORT_KEYS = new Set(["custom", "name", "price", "change"]);
const RANGES = new Set(["分时", "5日", "日K", "周K", "月K", "季K", "年K"]);

export const DEFAULT_WORKSPACE = Object.freeze({
  watchlistGroup: "all", watchlistQuery: "", watchlistSort: "custom", watchlistDirection: "asc",
  chartRange: "分时", showGrid: true, showMovingAverage: false, showMovingAverage20: false,
});
const text = (value, max) => String(value ?? "").trim().slice(0, max);
export function normalizeWorkspace(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    watchlistGroup: text(source.watchlistGroup, 64) || DEFAULT_WORKSPACE.watchlistGroup,
    watchlistQuery: text(source.watchlistQuery, 160),
    watchlistSort: SORT_KEYS.has(source.watchlistSort) ? source.watchlistSort : DEFAULT_WORKSPACE.watchlistSort,
    watchlistDirection: source.watchlistDirection === "desc" ? "desc" : DEFAULT_WORKSPACE.watchlistDirection,
    chartRange: RANGES.has(source.chartRange) ? source.chartRange : DEFAULT_WORKSPACE.chartRange,
    showGrid: source.showGrid !== false, showMovingAverage: source.showMovingAverage === true, showMovingAverage20: source.showMovingAverage20 === true,
  };
}
export { SORT_KEYS, RANGES };
