import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_REFRESH_POLICY, loadRefreshPolicy, normalizeRefreshPolicy, REFRESH_POLICY_STORAGE_KEY, REFRESH_POLICIES, refreshPolicyConfig, saveRefreshPolicy } from "./refreshPolicy.js";

describe("refreshPolicy", () => {
  beforeEach(() => window.localStorage.clear());

  it("keeps the existing realtime cadence as the default and rejects unknown values", () => {
    expect(loadRefreshPolicy()).toBe(DEFAULT_REFRESH_POLICY);
    expect(normalizeRefreshPolicy("unknown")).toBe(DEFAULT_REFRESH_POLICY);
    expect(refreshPolicyConfig("manual")).toMatchObject({ priorityIntervalMs: 0, fullIntervalMs: 0 });
  });

  it("persists a bounded local preference without touching user state", () => {
    expect(saveRefreshPolicy("balanced")).toBe("balanced");
    expect(window.localStorage.getItem(REFRESH_POLICY_STORAGE_KEY)).toBe("balanced");
    expect(loadRefreshPolicy()).toBe("balanced");
    expect(Object.keys(REFRESH_POLICIES)).toEqual(["realtime", "balanced", "manual"]);
  });
});
