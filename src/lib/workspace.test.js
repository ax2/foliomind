import { describe, expect, it } from "vitest";
import { DEFAULT_WORKSPACE, normalizeWorkspace } from "./workspace.js";

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
});
