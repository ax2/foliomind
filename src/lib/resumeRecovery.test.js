import { describe, expect, it } from "vitest";
import { RESUME_RECOVERY_AFTER_MS, shouldRecoverAfterResume } from "./resumeRecovery.js";

describe("resume recovery", () => {
  it("requires a finite inactive interval at or above the recovery threshold", () => {
    expect(shouldRecoverAfterResume(1_000, 1_000 + RESUME_RECOVERY_AFTER_MS)).toBe(true);
    expect(shouldRecoverAfterResume(1_000, 1_000 + RESUME_RECOVERY_AFTER_MS - 1)).toBe(false);
    expect(shouldRecoverAfterResume(2_000, 1_000 + RESUME_RECOVERY_AFTER_MS)).toBe(false);
  });

  it("does not recover from invalid timestamps or a negative threshold", () => {
    expect(shouldRecoverAfterResume("invalid", 10_000)).toBe(false);
    expect(shouldRecoverAfterResume(1_000, "invalid")).toBe(false);
    expect(shouldRecoverAfterResume(1_000, 2_000, -1)).toBe(false);
  });
});
