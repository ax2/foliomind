import { describe, expect, it } from "vitest";
import { friendlyDataMessage, friendlyModelMessage } from "./friendlyMessages.js";

describe("friendlyDataMessage", () => {
  it("does not expose unknown upstream details", () => {
    expect(friendlyDataMessage(new Error("unexpected provider payload detail"), "导入失败，请重试")).toBe("导入失败，请重试");
  });

  it("keeps actionable credential classification", () => {
    expect(friendlyDataMessage(new Error("401 unauthorized"), "导入失败，请重试")).toBe("数据服务凭据需要重新确认，请到设置中检查配置");
  });
});

describe("friendlyModelMessage", () => {
  it("separates model credential errors from data errors", () => {
    expect(friendlyModelMessage(new Error("401 unauthorized"))).toBe("模型网关凭据需要重新确认，请到设置中检查 API Key");
  });

  it("explains slow model responses without exposing upstream details", () => {
    expect(friendlyModelMessage(new Error("model gateway timeout"))).toBe("模型响应较慢，已停止本次测试；请稍后重试");
  });

  it("keeps unknown model failures recoverable", () => {
    expect(friendlyModelMessage(new Error("unexpected provider payload"))).toBe("模型暂时没有完成响应，请稍后重试");
  });
});
