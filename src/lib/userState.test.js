import { describe, expect, it } from "vitest";
import { parseUserStateBackup, serializeUserStateBackup, userStateBackupData } from "./userState.js";

describe("user state backups", () => {
  it("exports portable data while excluding runtime configuration", () => {
    const raw = serializeUserStateBackup({
      watchlist: [{ symbol: " aapl ", name: "Apple", market: "NASDAQ", category: "科技", secret: "drop" }],
      rules: [{ id: "r1", symbol: "AAPL", strategyId: "price_change", threshold: "5", intervalSeconds: "300", enabled: true }],
      notifications: [{ id: "n1", title: "提醒", body: "已触发", severity: "warning", createdAt: "2026-08-29T00:00:00Z", read: false }],
      portfolioPositions: [{ id: "p1", symbol: "aapl", name: "Apple", quantity: "2", averageCost: "100" }],
      apiKey: "sk-secret",
      settings: { modelGatewayBaseUrl: "https://secret.example" },
    });
    expect(raw).not.toContain("sk-secret");
    expect(raw).not.toContain("secret.example");
    expect(parseUserStateBackup(raw)).toMatchObject({
      watchlist: [{ symbol: "AAPL", name: "Apple" }],
      monitorRules: [{ threshold: 5, intervalSeconds: 300 }],
      portfolioPositions: [{ symbol: "AAPL", quantity: 2, averageCost: 100 }],
    });
  });

  it("rejects unsupported or empty files", () => {
    expect(() => parseUserStateBackup("{}")) .toThrow("备份文件版本不受支持");
    expect(() => parseUserStateBackup({ name: "FolioMind User Data Backup", version: 1, data: {} })).toThrow("没有可恢复的数据");
  });

  it("bounds and sanitizes imported values", () => {
    const data = userStateBackupData({ watchlist: [{ symbol: " aapl ", name: " Apple " }], portfolioPositions: [{ id: "p", symbol: "aapl", name: "Apple", quantity: 0, averageCost: 10 }] });
    expect(data.watchlist[0]).toEqual({ symbol: "AAPL", name: "Apple", market: "", category: "" });
    expect(data.portfolioPositions).toEqual([]);
  });

  it("round-trips condition combinations without exposing runtime secrets", () => {
    const raw = serializeUserStateBackup({
      watchlist: [{ symbol: "600519", name: "贵州茅台" }],
      rules: [{ id: "r1", symbol: "600519", strategyId: "price_change", threshold: 3, intervalSeconds: 300, logic: "OR", conditions: [{ type: "price_change", operator: "abs_gte", value: 3 }, { type: "volume_spike", operator: "gte", value: 2.5 }] }],
    });
    expect(parseUserStateBackup(raw).monitorRules[0]).toMatchObject({ logic: "OR", conditions: [{ type: "price_change", value: 3 }, { type: "volume_spike", value: 2.5 }] });
  });
});
