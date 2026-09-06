import { describe, expect, it } from "vitest";
import { DEFAULT_WORKSPACE, normalizeWorkspace } from "./workspace.js";

describe("workspace preferences", () => {
  it("keeps only the supported, bounded view preferences", () => {
    expect(normalizeWorkspace({ watchlistGroup: "  核心持仓 ", watchlistQuery: "  茅台 ", watchlistSort: "change", watchlistDirection: "desc", chartRange: "5日", showGrid: false, showMovingAverage: true })).toMatchObject({ watchlistGroup: "核心持仓", watchlistQuery: "茅台", watchlistSort: "change", watchlistDirection: "desc", chartRange: "5日", showGrid: false, showMovingAverage: true, showMovingAverage20: false });
  });

  it("fails closed to safe defaults for unknown or malformed values", () => {
    expect(normalizeWorkspace({ watchlistSort: "price;drop", watchlistDirection: "sideways", chartRange: "demo", showGrid: "false", showMovingAverage: 1 })).toEqual(DEFAULT_WORKSPACE);
  });
});
