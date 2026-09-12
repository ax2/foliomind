export const RESUME_RECOVERY_AFTER_MS = 60_000;

export function shouldRecoverAfterResume(lastActiveAt, now = Date.now(), thresholdMs = RESUME_RECOVERY_AFTER_MS) {
  const last = Number(lastActiveAt);
  const current = Number(now);
  const threshold = Number(thresholdMs);
  if (![last, current, threshold].every(Number.isFinite) || threshold < 0) return false;
  return Math.max(0, current - last) >= threshold;
}
