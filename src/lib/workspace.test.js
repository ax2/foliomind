import { describe, expect, it } from "vitest";
import { DEFAULT_WORKSPACE, MAX_SAVED_MONITOR_TEMPLATES, MAX_SAVED_RESEARCH_SCREENS, MAX_SAVED_WORKSPACE_VIEWS, normalizeWorkspace, workspaceViewPreferences } from "./workspace.js";

describe("workspace preferences", () => {
  it("keeps only the supported, bounded view preferences", () => {
    expect(normalizeWorkspace({ watchlistGroup: "  核心持仓 ", watchlistQuery: "  茅台 ", watchlistSort: "change", watchlistDirection: "desc", chartRange: "5日", showGrid: false, showMovingAverage: true })).toMatchObject({ watchlistGroup: "核心持仓", watchlistQuery: "茅台", watchlistSort: "change", watchlistDirection: "desc", chartRange: "5日", showGrid: false, showMovingAverage: true, showMovingAverage20: false });
  });

  it("fails closed to safe defaults for unknown or malformed values", () => {
    expect(normalizeWorkspace({ watchlistSort: "price;drop", watchlistDirection: "sideways", chartRange: "demo", showGrid: "false", showMovingAverage: 1 })).toEqual(DEFAULT_WORKSPACE);
  });

  it("accepts only plain objects and bounds user-controlled text", () => {
    expect(normalizeWorkspace(null)).toEqual(DEFAULT_WORKSPACE);
    expect(normalizeWorkspace(["watchlistQuery", "secret"])).toEqual(DEFAULT_WORKSPACE);
    expect(normalizeWorkspace({ watchlistGroup: ` ${"x".repeat(100)} `, watchlistQuery: "y".repeat(300) })).toMatchObject({ watchlistGroup: "x".repeat(64), watchlistQuery: "y".repeat(160) });
  });

  it("does not coerce truthy values into enabled chart settings", () => {
    expect(normalizeWorkspace({ showGrid: 1, showMovingAverage: "true", showMovingAverage20: {} })).toEqual(DEFAULT_WORKSPACE);
    expect(normalizeWorkspace({ showGrid: true, showMovingAverage: true, showMovingAverage20: true })).toMatchObject({ showGrid: true, showMovingAverage: true, showMovingAverage20: true });
  });

  it("keeps saved views bounded and excludes nested saved views from a snapshot", () => {
    const savedViews = Array.from({ length: MAX_SAVED_WORKSPACE_VIEWS + 3 }, (_, index) => ({ id: `v${index}`, name: `视图${index}`, preferences: { watchlistSort: "change", chartRange: "日K" } }));
    const normalized = normalizeWorkspace({ savedViews });
    expect(normalized.savedViews).toHaveLength(MAX_SAVED_WORKSPACE_VIEWS);
    expect(normalized.savedViews[0]).toMatchObject({ id: "v0", name: "视图0", preferences: { watchlistSort: "change", chartRange: "日K" } });
    expect(workspaceViewPreferences(normalized)).toEqual(expect.objectContaining({ watchlistSort: "custom", chartRange: "分时" }));
    expect(workspaceViewPreferences(normalized)).not.toHaveProperty("savedViews");
  });

  it("normalizes saved monitor templates to bounded conditions and intervals", () => {
    const templates = Array.from({ length: MAX_SAVED_MONITOR_TEMPLATES + 2 }, (_, index) => ({
      id: `template-${index}`,
      name: `模板${index}`,
      logic: index === 1 ? "OR" : "invalid",
      intervalSeconds: index === 1 ? 600 : 999,
      conditions: [{ type: "price_level", operator: "gte", value: 1800, apiKey: "drop-me" }],
    }));
    const normalized = normalizeWorkspace({ savedMonitorTemplates: templates });
    expect(normalized.savedMonitorTemplates).toHaveLength(MAX_SAVED_MONITOR_TEMPLATES);
    expect(normalized.savedMonitorTemplates[0]).toMatchObject({ logic: "AND", intervalSeconds: 300, conditions: [{ type: "price_level", operator: "gte", value: 1800 }] });
    expect(normalized.savedMonitorTemplates[0].conditions[0]).not.toHaveProperty("apiKey");
    expect(normalized.savedMonitorTemplates[1]).toMatchObject({ logic: "OR", intervalSeconds: 600 });
  });

  it("normalizes saved research screens to bounded filter fields", () => {
    const screens = Array.from({ length: MAX_SAVED_RESEARCH_SCREENS + 2 }, (_, index) => ({
      id: `screen-${index}`,
      name: `筛选${index}`,
      filters: { minChange: index === 1 ? " 1.5 " : "not-a-number", maxPe: 24.8, ignored: "drop" },
    }));
    const normalized = normalizeWorkspace({ savedResearchScreens: screens });
    expect(normalized.savedResearchScreens).toHaveLength(MAX_SAVED_RESEARCH_SCREENS);
    expect(normalized.savedResearchScreens[0]).toMatchObject({ name: "筛选0", filters: { minChange: "not-a-number", maxPe: "24.8" } });
    expect(normalized.savedResearchScreens[1]).toMatchObject({ filters: { minChange: "1.5", maxPe: "24.8" } });
    expect(normalized.savedResearchScreens[0].filters).not.toHaveProperty("ignored");
  });
});
