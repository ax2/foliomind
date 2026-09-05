import { describe, expect, it } from "vitest";
import { notificationCsv } from "./notifications.js";

describe("notificationCsv", () => {
  it("exports a stable, escaped audit table", () => {
    const csv = notificationCsv([{ createdAt: "2026-09-05T01:02:03Z", kind: "monitor", severity: "warning", read: false, symbol: "600519", title: "突破,提醒", body: "第一行\n第二行", source: "data-service" }]);
    expect(csv).toContain("\uFEFF时间,类型,级别,状态,代码,标题,内容,来源");
    expect(csv).toContain('2026-09-05T01:02:03Z,盯盘,warning,未读,600519,"突破,提醒",第一行 第二行,data-service');
  });

  it("does not serialize non-array input", () => {
    expect(notificationCsv(null)).toBe("\uFEFF时间,类型,级别,状态,代码,标题,内容,来源\n");
  });
});
