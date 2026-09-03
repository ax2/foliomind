import { describe, expect, it } from "vitest";
import { safeExternalUrl } from "./urlSafety.js";

describe("safeExternalUrl", () => {
  it("normalizes and keeps HTTP(S) links", () => {
    expect(safeExternalUrl("  https://example.com/notice  ")).toBe("https://example.com/notice");
    expect(safeExternalUrl("HTTP://example.com/notice")).toBe("HTTP://example.com/notice");
  });

  it("rejects executable, local, and custom protocols", () => {
    for (const value of ["javascript:alert(1)", "data:text/html,hi", "file:///tmp/a", "//example.com/path", "mailto:test@example.com"]) {
      expect(safeExternalUrl(value)).toBe("");
    }
  });

  it("bounds the returned URL length", () => {
    const url = `https://example.com/${"a".repeat(2_000)}`;
    expect(safeExternalUrl(url)).toHaveLength(1_024);
    expect(safeExternalUrl(url)).toMatch(/^https:\/\//);
  });
});
