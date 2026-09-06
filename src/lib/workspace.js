const SORT_KEYS = new Set(["custom", "name", "price", "change"]);
const RANGES = new Set(["分时", "5日", "日K", "周K", "月K", "季K", "年K"]);
export const WORKSPACE_VIEW_KEYS = Object.freeze(["watchlistGroup", "watchlistQuery", "watchlistSort", "watchlistDirection", "chartRange", "showGrid", "showMovingAverage", "showMovingAverage20"]);
export const MAX_SAVED_WORKSPACE_VIEWS = 12;

export const DEFAULT_WORKSPACE = Object.freeze({
  watchlistGroup: "all", watchlistQuery: "", watchlistSort: "custom", watchlistDirection: "asc",
  chartRange: "分时", showGrid: true, showMovingAverage: false, showMovingAverage20: false, savedViews: Object.freeze([]),
});
const text = (value, max) => String(value ?? "").trim().slice(0, max);
export function workspaceViewPreferences(value = {}) {
  const normalized = normalizeWorkspace(value);
  return Object.fromEntries(WORKSPACE_VIEW_KEYS.map((key) => [key, normalized[key]]));
}
export function normalizeSavedWorkspaceView(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = text(value.id, 64);
  const name = text(value.name, 64);
  if (!id || !name) return null;
  return { id, name, preferences: workspaceViewPreferences(value.preferences || value) };
}
export function normalizeWorkspace(value = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    watchlistGroup: text(source.watchlistGroup, 64) || DEFAULT_WORKSPACE.watchlistGroup,
    watchlistQuery: text(source.watchlistQuery, 160),
    watchlistSort: SORT_KEYS.has(source.watchlistSort) ? source.watchlistSort : DEFAULT_WORKSPACE.watchlistSort,
    watchlistDirection: source.watchlistDirection === "desc" ? "desc" : DEFAULT_WORKSPACE.watchlistDirection,
    chartRange: RANGES.has(source.chartRange) ? source.chartRange : DEFAULT_WORKSPACE.chartRange,
    showGrid: source.showGrid !== false, showMovingAverage: source.showMovingAverage === true, showMovingAverage20: source.showMovingAverage20 === true,
    savedViews: (Array.isArray(source.savedViews) ? source.savedViews : []).map(normalizeSavedWorkspaceView).filter(Boolean).slice(0, MAX_SAVED_WORKSPACE_VIEWS),
  };
}
export { SORT_KEYS, RANGES };
