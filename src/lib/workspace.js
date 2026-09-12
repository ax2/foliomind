import { normalizeConditions } from "./monitorConditions.js";
import { normalizeResearchFilters } from "./research.js";

const SORT_KEYS = new Set(["custom", "name", "price", "change"]);
const RANGES = new Set(["分时", "5日", "日K", "周K", "月K", "季K", "年K"]);
const MONITOR_TEMPLATE_INTERVALS = new Set([60, 300, 600, 1800]);
export const MARKET_COLUMN_KEYS = Object.freeze(["price", "change", "volume", "turnover", "turnoverRate", "pe", "pb", "asOf"]);
export const DEFAULT_MARKET_COLUMNS = Object.freeze(["price", "change", "pe", "pb"]);
export const WORKSPACE_VIEW_KEYS = Object.freeze(["watchlistGroup", "watchlistQuery", "watchlistSort", "watchlistDirection", "chartRange", "showGrid", "showMovingAverage", "showMovingAverage20"]);
export const MAX_SAVED_WORKSPACE_VIEWS = 12;
export const MAX_SAVED_MONITOR_TEMPLATES = 8;
export const MAX_SAVED_RESEARCH_SCREENS = 10;
export const MAX_SAVED_MARKET_VIEWS = 10;

export const DEFAULT_WORKSPACE = Object.freeze({
  watchlistGroup: "all", watchlistQuery: "", watchlistSort: "custom", watchlistDirection: "asc",
  chartRange: "分时", showGrid: true, showMovingAverage: false, showMovingAverage20: false, marketColumns: DEFAULT_MARKET_COLUMNS, savedViews: Object.freeze([]), savedMonitorTemplates: Object.freeze([]), savedResearchScreens: Object.freeze([]), savedMarketViews: Object.freeze([]),
});
const text = (value, max) => String(value ?? "").trim().slice(0, max);
export function normalizeMarketColumns(columns) {
  const allowed = new Set(MARKET_COLUMN_KEYS);
  const result = Array.isArray(columns) ? [...new Set(columns.filter((column) => allowed.has(column)))] : [];
  return result.length ? result : [...DEFAULT_MARKET_COLUMNS];
}
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
export function normalizeSavedMonitorTemplate(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = text(value.id, 64);
  const name = text(value.name, 64);
  if (!id || !name) return null;
  const intervalSeconds = Number(value.intervalSeconds);
  return {
    id,
    name,
    logic: value.logic === "OR" ? "OR" : "AND",
    conditions: normalizeConditions(value.conditions, "price_change"),
    intervalSeconds: MONITOR_TEMPLATE_INTERVALS.has(intervalSeconds) ? intervalSeconds : 300,
  };
}
export function normalizeSavedResearchScreen(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = text(value.id, 64);
  const name = text(value.name, 32);
  if (!id || !name) return null;
  return { id, name, filters: normalizeResearchFilters(value.filters) };
}
export function normalizeSavedMarketView(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = text(value.id, 64);
  const name = text(value.name, 32);
  const allowed = new Set(MARKET_COLUMN_KEYS);
  const columns = Array.isArray(value.columns) ? [...new Set(value.columns.filter((column) => allowed.has(column)))] : [];
  if (!id || !name || !columns.length) return null;
  return { id, name, columns };
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
    marketColumns: normalizeMarketColumns(source.marketColumns),
    savedViews: (Array.isArray(source.savedViews) ? source.savedViews : []).map(normalizeSavedWorkspaceView).filter(Boolean).slice(0, MAX_SAVED_WORKSPACE_VIEWS),
    savedMonitorTemplates: (Array.isArray(source.savedMonitorTemplates) ? source.savedMonitorTemplates : []).map(normalizeSavedMonitorTemplate).filter(Boolean).slice(0, MAX_SAVED_MONITOR_TEMPLATES),
    savedResearchScreens: (Array.isArray(source.savedResearchScreens) ? source.savedResearchScreens : []).map(normalizeSavedResearchScreen).filter(Boolean).slice(0, MAX_SAVED_RESEARCH_SCREENS),
    savedMarketViews: (Array.isArray(source.savedMarketViews) ? source.savedMarketViews : []).map(normalizeSavedMarketView).filter(Boolean).slice(0, MAX_SAVED_MARKET_VIEWS),
  };
}
export { SORT_KEYS, RANGES };
