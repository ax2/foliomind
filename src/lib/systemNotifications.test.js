import { afterEach, describe, expect, it, vi } from "vitest";
import { requestSystemNotificationPermission, sendSystemNotification, setSystemNotificationsEnabled, systemNotificationsEnabled } from "./systemNotifications.js";

describe("system notifications", () => {
  const originalNotification = window.Notification;

  afterEach(() => {
    setSystemNotificationsEnabled(false);
    if (originalNotification) Object.defineProperty(window, "Notification", { configurable: true, value: originalNotification });
    else delete window.Notification;
    vi.restoreAllMocks();
  });

  it("requires explicit opt-in before sending a local notification", async () => {
    const send = vi.fn();
    class MockNotification {
      static permission = "granted";
      static requestPermission = vi.fn().mockResolvedValue("granted");
      constructor(...args) { send(...args); }
    }
    Object.defineProperty(window, "Notification", { configurable: true, value: MockNotification });
    expect(systemNotificationsEnabled()).toBe(false);
    expect(await sendSystemNotification({ id: "n1", title: "提醒", body: "内容" })).toBe(false);
    expect(send).not.toHaveBeenCalled();
    setSystemNotificationsEnabled(true);
    expect(await sendSystemNotification({ id: "n1", title: "提醒", body: "内容" })).toBe(true);
    expect(send).toHaveBeenCalledWith("提醒", { body: "内容", tag: "foliomind-n1" });
  });

  it("requests browser permission only when the user enables notifications", async () => {
    class MockNotification {
      static permission = "default";
      static requestPermission = vi.fn().mockResolvedValue("granted");
    }
    Object.defineProperty(window, "Notification", { configurable: true, value: MockNotification });
    expect(await requestSystemNotificationPermission()).toBe(true);
    expect(MockNotification.requestPermission).toHaveBeenCalledOnce();
  });
});
