import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { normalizeUserState } from "../src/lib/userStateSchema.js";

test("shared legacy user-state fixture receives safe Web defaults", async () => {
  const raw = await readFile(new URL("../tests/fixtures/legacy-user-state.json", import.meta.url), "utf8");
  const normalized = normalizeUserState(JSON.parse(raw));

  assert.equal(normalized.revision, 12);
  assert.equal(normalized.onboardingCompleted, true);
  assert.deepEqual(normalized.watchlist[0], {
    symbol: "600519",
    name: "贵州茅台",
    market: "沪深",
    category: "白酒",
    group: "A股",
  });
  assert.deepEqual(normalized.monitorRules[0], {
    id: "legacy-r1",
    scope: "symbol",
    symbol: "600519",
    strategyId: "price_change",
    threshold: 3,
    conditions: [{ id: "condition-1", type: "price_change", field: "changePercent", operator: "abs_gte", value: 3 }],
    logic: "AND",
    intervalSeconds: 300,
    enabled: true,
    lastCheckedAt: null,
    lastTriggeredAt: null,
    lastSignalTriggered: null,
    lastSignalBySymbol: {},
    triggerMode: "edge",
    expiresAt: null,
  });
  assert.equal(normalized.workspace.watchlistSort, "custom");
  assert.deepEqual(normalized.workspace.marketColumns, ["price", "change", "pe", "pb"]);
  assert.deepEqual(normalized.installedSkillIds, ["fundamental", "monitor"]);
  assert.deepEqual(normalized.portfolioPositions, []);
});
