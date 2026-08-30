import { describe, expect, it } from "vitest";
import { parseUserStateBackup, serializeUserStateBackup, userStateBackupData } from "./userState.js";

describe("user state backups", () => {
  it("exports portable data while excluding runtime configuration", () => {
    const raw = serializeUserStateBackup({
      watchlist: [{ symbol: " aapl ", name: "Apple", market: "NASDAQ", category: "科技", secret: "drop" }],
      rules: [{ id: "r1", symbol: "AAPL", strategyId: "price_change", threshold: "5", intervalSeconds: "300", enabled: true }],
      notifications: [{ id: "n1", kind: "monitor", symbol: "aapl", name: "Apple", ruleId: "r1", title: "提醒", body: "已触发", severity: "warning", createdAt: "2026-08-29T00:00:00Z", read: false }],
      portfolioPositions: [{ id: "p1", symbol: "aapl", name: "Apple", quantity: "2", averageCost: "100", takeProfitPrice: "125", stopLossPrice: "80", takeProfitTriggered: true }],
      apiKey: "sk-secret",
      settings: { modelGatewayBaseUrl: "https://secret.example" },
    });
    expect(raw).not.toContain("sk-secret");
    expect(raw).not.toContain("secret.example");
    expect(parseUserStateBackup(raw)).toMatchObject({
      watchlist: [{ symbol: "AAPL", name: "Apple" }],
      monitorRules: [{ threshold: 5, intervalSeconds: 300 }],
      notifications: [{ symbol: "AAPL", name: "Apple", ruleId: "r1" }],
      portfolioPositions: [{ symbol: "AAPL", quantity: 2, averageCost: 100, takeProfitPrice: 125, stopLossPrice: 80, takeProfitTriggered: true, planThesis: "", planActions: [] }],
    });
  });

  it("rejects unsupported or empty files", () => {
    expect(() => parseUserStateBackup("{}")) .toThrow("备份文件版本不受支持");
    expect(() => parseUserStateBackup({ name: "FolioMind User Data Backup", version: 1, data: {} })).toThrow("没有可恢复的数据");
  });

  it("bounds and sanitizes imported values", () => {
    const data = userStateBackupData({ watchlist: [{ symbol: " aapl ", name: " Apple " }], portfolioPositions: [{ id: "p", symbol: "aapl", name: "Apple", quantity: 0, averageCost: 10 }] });
    expect(data.watchlist[0]).toEqual({ symbol: "AAPL", name: "Apple", market: "", category: "", group: "自选" });
    expect(data.portfolioPositions).toEqual([]);
  });

  it("round-trips condition combinations without exposing runtime secrets", () => {
    const raw = serializeUserStateBackup({
      watchlist: [{ symbol: "600519", name: "贵州茅台" }],
      rules: [{ id: "r1", symbol: "600519", strategyId: "price_change", threshold: 3, intervalSeconds: 300, logic: "OR", conditions: [{ type: "price_change", operator: "abs_gte", value: 3 }, { type: "volume_spike", operator: "gte", value: 2.5 }] }],
    });
    expect(parseUserStateBackup(raw).monitorRules[0]).toMatchObject({ logic: "OR", conditions: [{ type: "price_change", value: 3 }, { type: "volume_spike", value: 2.5 }] });
  });

  it("round-trips watchlist groups while migrating legacy items", () => {
    const raw = serializeUserStateBackup({ watchlist: [{ symbol: "600519", name: "贵州茅台", market: "沪深", group: "核心持仓" }] });
    expect(parseUserStateBackup(raw).watchlist[0]).toMatchObject({ symbol: "600519", group: "核心持仓" });
    expect(parseUserStateBackup(serializeUserStateBackup({ watchlist: [{ symbol: "AAPL", name: "Apple", market: "NASDAQ" }] })).watchlist[0].group).toBe("美股");
  });

  it("round-trips monitor audit history without prompts or credentials", () => {
    const raw = serializeUserStateBackup({
      watchlist: [{ symbol: "600519", name: "贵州茅台" }],
      monitorHistory: [{ id: "h1", ruleId: "r1", symbol: "600519", checkedAt: "2026-08-29T10:00:00Z", outcome: "unknown", summary: "字段不足", source: "data-service", audits: [{ operation: "call", toolId: "qveris_finance.mkt_l1_rt", prompt: "do not export" }] }],
      apiKey: "sk-secret",
    });
    expect(raw).not.toContain("sk-secret");
    expect(raw).not.toContain("do not export");
    expect(parseUserStateBackup(raw).monitorHistory).toMatchObject([{ id: "h1", outcome: "unknown", audits: [{ operation: "call", toolId: "qveris_finance.mkt_l1_rt" }] }]);
  });
});
