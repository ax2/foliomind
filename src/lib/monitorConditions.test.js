import { describe, expect, it } from "vitest";
import { conditionOperatorsFor, conditionPrompt, conditionSummary, conditionsForRule, evaluateCondition, evaluateRuleConditions, normalizeConditions } from "./monitorConditions.js";

describe("monitor conditions", () => {
  it("supports all six condition types with safe defaults", () => {
    const conditions = normalizeConditions([
      { type: "price_change", value: 4 },
      { type: "volume_spike" },
      { type: "technical" },
      { type: "core_event" },
      { type: "capital_flow" },
      { type: "sentiment" },
      { type: "unknown" },
    ]);
    expect(conditions).toHaveLength(6);
    expect(new Set(conditions.map((condition) => condition.type))).toEqual(new Set(["price_change", "volume_spike", "technical", "core_event", "capital_flow", "sentiment"]));
    expect(conditionSummary(conditions[0])).toContain("4%");
  });

  it("evaluates numeric conditions and preserves unknown fields", () => {
    expect(evaluateCondition({ type: "price_change", operator: "gte", value: 3 }, { changePercent: 3.2 })).toBe(true);
    expect(evaluateCondition({ type: "volume_spike", operator: "gte", value: 2 }, {})).toBeNull();
  });

  it("restricts operators to the value type and normalizes invalid choices", () => {
    expect(conditionOperatorsFor("sentiment").map((operator) => operator.id)).toEqual(["eq"]);
    expect(normalizeConditions([{ type: "sentiment", operator: "gte", value: "positive" }])[0].operator).toBe("eq");
  });

  it("derives a technical new-high signal from a real series", () => {
    expect(evaluateCondition({ type: "technical", operator: "eq", value: "new_high" }, { series: [{ close: 10 }, { close: 11 }, { close: 12 }] })).toBe(true);
  });

  it("combines known and unknown conditions without treating missing data as false", () => {
    expect(evaluateRuleConditions({ logic: "AND", conditions: [{ type: "price_change", value: 3 }, { type: "volume_spike", value: 2 }] }, { changePercent: 4, volumeRatio: 2.2 })).toMatchObject({ known: true, triggered: true });
    expect(evaluateRuleConditions({ logic: "AND", conditions: [{ type: "price_change", value: 3 }, { type: "volume_spike", value: 2 }] }, { changePercent: 4 })).toMatchObject({ known: false, triggered: null });
    expect(evaluateRuleConditions({ logic: "OR", conditions: [{ type: "price_change", value: 3 }, { type: "volume_spike", value: 2 }] }, { changePercent: 4 })).toMatchObject({ known: true, triggered: true });
  });

  it("includes the stable condition contract in the data request prompt", () => {
    const prompt = conditionPrompt({ logic: "OR", conditions: [{ type: "price_change", operator: "gte", value: 4 }] });
    expect(prompt).toContain("OR");
    expect(prompt).toContain("price_change");
    expect(prompt).toContain("triggered=null");
  });

  it("keeps legacy strategy-only rules compatible", () => {
    expect(conditionsForRule({ strategyId: "news_risk", threshold: 1 })[0]).toMatchObject({ type: "core_event", value: 1 });
  });
});
