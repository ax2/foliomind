export const RELEASE_API_URL = "https://api.github.com/repos/ax2/foliomind/releases/latest";
export const RELEASES_PAGE_URL = "https://github.com/ax2/foliomind/releases";

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export function parseVersion(value) {
  const match = String(value ?? "").trim().replace(/^v/i, "").match(VERSION_PATTERN);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4] || "" };
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return 0;
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }
  if (!a.prerelease && b.prerelease) return 1;
  if (a.prerelease && !b.prerelease) return -1;
  return a.prerelease === b.prerelease ? 0 : a.prerelease > b.prerelease ? 1 : -1;
}

export async function checkLatestRelease({ fetchImpl = globalThis.fetch, timeoutMs = 6000 } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("update-check-unavailable");
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timeout = controller ? globalThis.setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetchImpl(RELEASE_API_URL, {
      headers: { Accept: "application/vnd.github+json" },
      signal: controller?.signal,
    });
    if (!response?.ok) throw new Error(`update-check-http-${response?.status || "unknown"}`);
    const release = await response.json();
    const version = release?.tag_name;
    if (release?.draft || release?.prerelease || !parseVersion(version)) throw new Error("update-check-invalid-release");
    return {
      version: String(version).replace(/^v/i, ""),
      name: String(release.name || version),
      url: typeof release.html_url === "string" ? release.html_url : RELEASES_PAGE_URL,
      publishedAt: release.published_at || null,
    };
  } finally {
    if (timeout) globalThis.clearTimeout(timeout);
  }
}
