const MAX_EXTERNAL_URL_LENGTH = 1_024;

/**
 * Keep untrusted provider/user-facing links on web protocols only.  The
 * helper is intentionally small and pure so both Store normalization and
 * render-time boundaries use the same rule.
 */
export function safeExternalUrl(value) {
  const candidate = String(value ?? "").trim();
  return /^https?:\/\//i.test(candidate) ? candidate.slice(0, MAX_EXTERNAL_URL_LENGTH) : "";
}
