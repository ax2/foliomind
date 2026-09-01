import { describe, expect, it } from "vitest";
import { sortResearchItems } from "./research.js";

describe("research sorting", () => {
  it("sorts valuation fields with missing values last and stable ties", () => {
    const items = [{ symbol: "A", name: "Alpha" }, { symbol: "B", name: "Beta" }, { symbol: "C", name: "Gamma" }, { symbol: "D", name: "Delta" }];
    const quotes = { A: { pe: 12 }, B: { pe: 8 }, C: { pe: null }, D: { pe: 8 } };
    expect(sortResearchItems(items, quotes, "pe", "asc").map((item) => item.symbol)).toEqual(["B", "D", "A", "C"]);
    expect(sortResearchItems(items, quotes, "pe", "desc").map((item) => item.symbol)).toEqual(["A", "B", "D", "C"]);
    expect(sortResearchItems(items, quotes, "default").map((item) => item.symbol)).toEqual(["A", "B", "C", "D"]);
  });
});
