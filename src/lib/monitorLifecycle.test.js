import { describe, expect, it } from "vitest";
import { isMonitorRuleExpired, monitorDateInputValue, monitorLifecycleLabel, normalizeMonitorExpiresAt, normalizeMonitorTriggerMode } from "./monitorLifecycle.js";

describe("monitor rule lifecycle", () => {
  it("normalizes trigger modes and date-only expiry at the end of the day", () => {
    expect(normalizeMonitorTriggerMode("once")).toBe("once");
    expect(normalizeMonitorTriggerMode("unknown")).toBe("edge");
    expect(normalizeMonitorExpiresAt("2026-09-10")).toBe("2026-09-10T23:59:59.999Z");
    expect(monitorDateInputValue("2026-09-10T23:59:59.999Z")).toBe("2026-09-10");
    expect(normalizeMonitorExpiresAt("not-a-date")).toBeNull();
  });

  it("distinguishes active, expired, and single-trigger rules", () => {
    const now = Date.parse("2026-09-02T12:00:00Z");
    expect(isMonitorRuleExpired({ expiresAt: "2026-09-02T23:59:59.999Z" }, now)).toBe(false);
    expect(isMonitorRuleExpired({ expiresAt: "2026-09-01T23:59:59.999Z" }, now)).toBe(true);
    expect(monitorLifecycleLabel({ triggerMode: "once" }, now)).toBe("单次触发");
    expect(monitorLifecycleLabel({ triggerMode: "edge", expiresAt: "2026-09-01T23:59:59.999Z" }, now)).toBe("已过期");
  });
});

