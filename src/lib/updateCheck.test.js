import { afterEach, describe, expect, it, vi } from "vitest";
import { checkLatestRelease, compareVersions, parseVersion, RELEASE_API_URL } from "./updateCheck.js";

describe("update check", () => {
  afterEach(() => vi.restoreAllMocks());

  it("parses and compares release versions without treating a prerelease as newer", () => {
    expect(parseVersion("v1.2.3")).toMatchObject({ major: 1, minor: 2, patch: 3 });
    expect(compareVersions("1.2.3", "1.3.0")).toBe(-1);
    expect(compareVersions("1.2.3", "v1.2.3")).toBe(0);
    expect(compareVersions("1.2.3-beta.1", "1.2.3")).toBe(-1);
    expect(compareVersions("1.2.4", "1.2.3-beta.1")).toBe(1);
    expect(parseVersion("not-a-version")).toBeNull();
  });

  it("validates the GitHub release payload and keeps failures actionable", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ tag_name: "v0.2.0", name: "FolioMind 0.2.0", html_url: "https://github.com/ax2/foliomind/releases/tag/v0.2.0", published_at: "2026-08-29T00:00:00Z" }),
    });
    await expect(checkLatestRelease({ fetchImpl })).resolves.toMatchObject({ version: "0.2.0", url: "https://github.com/ax2/foliomind/releases/tag/v0.2.0" });
    expect(fetchImpl).toHaveBeenCalledWith(RELEASE_API_URL, expect.objectContaining({ headers: expect.objectContaining({ Accept: "application/vnd.github+json" }) }));
    await expect(checkLatestRelease({ fetchImpl: vi.fn().mockResolvedValue({ ok: false, status: 429 }) })).rejects.toThrow("update-check-http-429");
  });
});
