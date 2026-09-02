import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const localHost = vi.hoisted(() => ({ isLocalWebRuntime: vi.fn(() => false), localHostRequest: vi.fn() }));
vi.mock("./localHost.js", () => localHost);

import { loadUserState, mergeUserStateChanges, normalizeUserState, parseUserStateBackup, saveUserState, serializeUserStateBackup, userStateBackupData, UserStateMergeConflictError } from "./userState.js";

describe("user state backups", () => {
  beforeEach(() => {
    delete window.__TAURI_INTERNALS__;
    localHost.isLocalWebRuntime.mockReset().mockReturnValue(false);
    localHost.localHostRequest.mockReset();
  });

  afterEach(() => {
    delete window.__TAURI_INTERNALS__;
  });

  it("does not fall back to browser storage when the Local Host is offline", async () => {
    localHost.isLocalWebRuntime.mockReturnValue(true);
    const error = new Error("无法连接本地调试 Host");
    error.code = "LOCAL_HOST_UNAVAILABLE";
    localHost.localHostRequest.mockRejectedValue(error);
    window.localStorage.setItem("foliomind.user-state.v1", JSON.stringify({ watchlist: [{ symbol: "AAPL", name: "Apple" }] }));

    await expect(loadUserState()).rejects.toBe(error);
    expect(localHost.localHostRequest).toHaveBeenCalledWith("/api/user-state");
  });

  it("reads the canonical state from a healthy Local Host", async () => {
    localHost.isLocalWebRuntime.mockReturnValue(true);
    localHost.localHostRequest.mockResolvedValue({ revision: 3, watchlist: [{ symbol: "AAPL", name: "Apple" }] });

    await expect(loadUserState()).resolves.toMatchObject({ revision: 3, watchlist: [{ symbol: "AAPL", name: "Apple" }] });
  });

  it("does not turn a cross-process state lock into a CAS merge", async () => {
    localHost.isLocalWebRuntime.mockReturnValue(true);
    const busy = new Error("用户状态正在被其它 FolioMind 进程保存，请稍后重试");
    busy.status = 409;
    busy.code = "USER_STATE_BUSY";
    localHost.localHostRequest.mockRejectedValue(busy);
    const state = normalizeUserState({ revision: 2, watchlist: [{ symbol: "AAPL", name: "Apple" }] });

    await expect(saveUserState(state)).rejects.toBe(busy);
    expect(localHost.localHostRequest).toHaveBeenCalledTimes(1);
  });

  it("exports portable data while excluding runtime configuration", () => {
    const raw = serializeUserStateBackup({
      watchlist: [{ symbol: " aapl ", name: "Apple", market: "NASDAQ", category: "科技", secret: "drop" }],
      rules: [{ id: "r1", symbol: "AAPL", strategyId: "price_change", threshold: "5", intervalSeconds: "300", enabled: true }],
      notifications: [{ id: "n1", kind: "monitor", symbol: "aapl", name: "Apple", ruleId: "r1", eventKey: "AAPL|2026-09-01|财报", reminderPhase: "upcoming", title: "提醒", body: "已触发", severity: "warning", createdAt: "2026-08-29T00:00:00Z", read: false }],
      portfolioPositions: [{ id: "p1", symbol: "aapl", name: "Apple", quantity: "2", averageCost: "100", takeProfitPrice: "125", stopLossPrice: "80", takeProfitTriggered: true }],
      briefingSchedule: { enabled: true, closeTime: "16:05", retryMinutes: 20, lastResult: "waiting-data", lastError: "等待行情" },
      apiKey: "sk-secret",
      settings: { modelGatewayBaseUrl: "https://secret.example" },
      installedSkillIds: ["fundamental", "news"],
    });
    expect(raw).not.toContain("sk-secret");
    expect(raw).not.toContain("secret.example");
    expect(raw).not.toContain('"revision"');
    expect(parseUserStateBackup(raw)).toMatchObject({
      watchlist: [{ symbol: "AAPL", name: "Apple" }],
      monitorRules: [{ threshold: 5, intervalSeconds: 300 }],
      notifications: [{ symbol: "AAPL", name: "Apple", ruleId: "r1", eventKey: "AAPL|2026-09-01|财报", reminderPhase: "upcoming" }],
      portfolioPositions: [{ symbol: "AAPL", quantity: 2, averageCost: 100, takeProfitPrice: 125, stopLossPrice: 80, takeProfitTriggered: true, planThesis: "", planActions: [] }],
      briefingSchedule: { enabled: true, closeTime: "16:05", retryMinutes: 20, timeZone: "Asia/Shanghai", lastResult: "waiting-data", lastError: "等待行情" },
      installedSkillIds: ["fundamental", "news"],
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

  it("preserves installed Skill IDs without accepting path-like values", () => {
    const normalized = normalizeUserState({ installedSkillIds: ["fundamental", "news", "news", "../escape", "bad id"] });
    expect(normalized.installedSkillIds).toEqual(["fundamental", "news"]);
    expect(normalizeUserState({ watchlist: [{ symbol: "AAPL", name: "Apple" }] }).installedSkillIds).toEqual(["fundamental", "monitor"]);
  });

  it("removes only untouched legacy monitor seeds during onboarding migration", () => {
    const migrated = normalizeUserState({
      monitorRules: [
        { id: "r1", symbol: "600519", strategyId: "price_change", threshold: 3, intervalSeconds: 300, enabled: true },
        { id: "r2", symbol: "300750", strategyId: "news_risk", threshold: 1, intervalSeconds: 600, enabled: true },
      ],
    });
    expect(migrated.monitorRules).toEqual([]);

    const edited = normalizeUserState({
      monitorRules: [
        { id: "r1", symbol: "600519", strategyId: "price_change", threshold: 4, intervalSeconds: 300, enabled: true },
        { id: "r2", symbol: "300750", strategyId: "news_risk", threshold: 1, intervalSeconds: 600, enabled: true },
      ],
    });
    expect(edited.monitorRules).toHaveLength(2);

    const active = normalizeUserState({
      monitorRules: [
        { id: "r1", symbol: "600519", strategyId: "price_change", threshold: 3, intervalSeconds: 300, enabled: true },
        { id: "r2", symbol: "300750", strategyId: "news_risk", threshold: 1, intervalSeconds: 600, enabled: true },
      ],
      notifications: [{ id: "n1", title: "已有提醒" }],
    });
    expect(active.monitorRules).toHaveLength(2);
  });

  it("round-trips condition combinations without exposing runtime secrets", () => {
    const raw = serializeUserStateBackup({
      watchlist: [{ symbol: "600519", name: "贵州茅台" }],
      rules: [{ id: "r1", symbol: "600519", strategyId: "price_change", threshold: 3, intervalSeconds: 300, logic: "OR", conditions: [{ type: "price_change", operator: "abs_gte", value: 3 }, { type: "volume_spike", operator: "gte", value: 2.5 }] }],
    });
    expect(parseUserStateBackup(raw).monitorRules[0]).toMatchObject({ logic: "OR", conditions: [{ type: "price_change", value: 3 }, { type: "volume_spike", value: 2.5 }] });
  });

  it("round-trips dynamic watchlist monitor scope and bounded per-symbol edge state", () => {
    const raw = serializeUserStateBackup({
      watchlist: [{ symbol: "600519", name: "贵州茅台" }],
      monitorRules: [{ id: "watchlist-rule", scope: "watchlist", symbol: "*", strategyId: "price_change", threshold: 3, intervalSeconds: 300, lastSignalBySymbol: { "600519": true, AAPL: false, ignored: "invalid" } }],
    });
    expect(parseUserStateBackup(raw).monitorRules[0]).toMatchObject({ scope: "watchlist", symbol: "*", lastSignalBySymbol: { "600519": true, AAPL: false } });
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

  it("round-trips bounded portfolio reviews without raw runtime data", () => {
    const raw = serializeUserStateBackup({
      watchlist: [{ symbol: "AAPL", name: "Apple" }],
      portfolioReviews: [{ id: "review-1", kind: "close", tradingDate: "2026-08-30", createdAt: "2026-08-30T10:00:00Z", asOf: "2026-08-30T08:00:00Z", pricedCount: 1, totalCount: 1, totalCost: 200, totalMarketValue: 240, totalPnl: 40, totalPnlPercent: 20, positions: [{ symbol: "AAPL", name: "Apple", currentPrice: 120, pnl: 40, pnlPercent: 20, weight: 100, asOf: "2026-08-30T08:00:00Z", source: "provider" }], riskSignals: [], upcomingEvents: [], sources: ["provider"], disclaimer: "不构成投资建议", rawResponse: "drop-me" }],
    });
    expect(raw).not.toContain("drop-me");
    expect(parseUserStateBackup(raw).portfolioReviews).toMatchObject([{ id: "review-1", pricedCount: 1, positions: [{ symbol: "AAPL", currentPrice: 120 }] }]);
  });

  it("uses one bounded contract for malformed state from every transport", () => {
    const normalized = normalizeUserState({
      watchlist: [{ symbol: " 600519 ", name: " 贵州茅台 ", market: "沪深" }, { symbol: "", name: "bad" }],
      monitorRules: [{ id: "r1", symbol: "600519", strategyId: "price_change", threshold: "3", intervalSeconds: "300", conditions: [{ type: "unknown" }] }],
      notifications: [{ id: "n1", title: "安全提醒", body: "x".repeat(10_000), event_key: "event-1" }, { title: "缺少 id" }],
      monitorHistory: [{ id: "h1", ruleId: "r1", symbol: "600519", checkedAt: "2026-08-30T00:00:00Z", outcome: "invalid", audits: [{ prompt: "secret" }] }],
      apiKey: "sk_should_never_escape",
    });
    expect(normalized.watchlist).toEqual([{ symbol: "600519", name: "贵州茅台", market: "沪深", category: "", group: "A股" }]);
    expect(normalized.monitorRules[0]).toMatchObject({ threshold: 3, intervalSeconds: 300, logic: "AND" });
    expect(normalized.notifications).toEqual([{ id: "n1", kind: "", symbol: "", name: "", ruleId: "", title: "安全提醒", body: "x".repeat(4096), severity: "info", createdAt: "", read: false, source: "", eventKey: "event-1", reminderPhase: "" }]);
    expect(normalized.monitorHistory[0]).toMatchObject({ outcome: "unknown", audits: [] });
    expect(JSON.stringify(normalized)).not.toContain("sk_should_never_escape");
  });

  it("preserves revisions and three-way merges disjoint client and background changes", () => {
    const base = normalizeUserState({ revision: 4, watchlist: [{ symbol: "AAPL", name: "Apple" }], notifications: [] });
    const local = normalizeUserState({ ...base, watchlist: [...base.watchlist, { symbol: "MSFT", name: "Microsoft" }] });
    const remote = normalizeUserState({ ...base, revision: 5, notifications: [{ id: "n1", title: "后台复盘完成" }] });
    const merged = mergeUserStateChanges(base, local, remote);
    expect(merged.revision).toBe(5);
    expect(merged.watchlist.map((item) => item.symbol)).toEqual(["AAPL", "MSFT"]);
    expect(merged.notifications).toMatchObject([{ id: "n1", title: "后台复盘完成" }]);
  });

  it("rejects conflicting edits to the same persisted record", () => {
    const base = normalizeUserState({ revision: 2, watchlist: [{ symbol: "AAPL", name: "Apple" }] });
    const local = normalizeUserState({ ...base, watchlist: [{ symbol: "AAPL", name: "Apple Local" }] });
    const remote = normalizeUserState({ ...base, revision: 3, watchlist: [{ symbol: "AAPL", name: "Apple Remote" }] });
    expect(() => mergeUserStateChanges(base, local, remote)).toThrow(UserStateMergeConflictError);
  });

  it("merges independent Skill installation changes", () => {
    const base = normalizeUserState({ revision: 2, installedSkillIds: ["fundamental"] });
    const local = normalizeUserState({ ...base, installedSkillIds: ["fundamental", "news"] });
    const remote = normalizeUserState({ ...base, revision: 3, installedSkillIds: ["fundamental", "risk"] });
    expect(mergeUserStateChanges(base, local, remote).installedSkillIds).toEqual(["fundamental", "news", "risk"]);
    const sameChange = normalizeUserState({ ...base, revision: 3, installedSkillIds: ["fundamental", "news"] });
    expect(mergeUserStateChanges(base, local, sameChange).installedSkillIds).toEqual(["fundamental", "news"]);
  });
});
