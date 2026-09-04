export const REFRESH_POLICY_STORAGE_KEY = "foliomind.refresh-policy.v1";

export const REFRESH_POLICIES = Object.freeze({
  realtime: Object.freeze({
    id: "realtime",
    label: "实时",
    description: "重点标的约 15 秒、完整自选约 3 分钟更新",
    priorityIntervalMs: 15_000,
    fullIntervalMs: 180_000,
  }),
  balanced: Object.freeze({
    id: "balanced",
    label: "均衡",
    description: "重点标的约 30 秒、完整自选约 5 分钟更新",
    priorityIntervalMs: 30_000,
    fullIntervalMs: 300_000,
  }),
  manual: Object.freeze({
    id: "manual",
    label: "手动",
    description: "不自动刷新，仅在页面点击刷新时获取真实数据",
    priorityIntervalMs: 0,
    fullIntervalMs: 0,
  }),
});

export const DEFAULT_REFRESH_POLICY = "realtime";

export function normalizeRefreshPolicy(value) {
  const id = String(value || "").trim().toLowerCase();
  return Object.hasOwn(REFRESH_POLICIES, id) ? id : DEFAULT_REFRESH_POLICY;
}

export function refreshPolicyConfig(value) {
  return REFRESH_POLICIES[normalizeRefreshPolicy(value)];
}

export function loadRefreshPolicy() {
  if (typeof window === "undefined") return DEFAULT_REFRESH_POLICY;
  try {
    return normalizeRefreshPolicy(window.localStorage.getItem(REFRESH_POLICY_STORAGE_KEY));
  } catch {
    return DEFAULT_REFRESH_POLICY;
  }
}

export function saveRefreshPolicy(value) {
  const normalized = normalizeRefreshPolicy(value);
  if (typeof window !== "undefined") {
    try { window.localStorage.setItem(REFRESH_POLICY_STORAGE_KEY, normalized); } catch { /* Storage may be disabled. */ }
    try { window.dispatchEvent(new CustomEvent("foliomind:refresh-policy", { detail: normalized })); } catch { /* Custom events may be unavailable in non-browser tests. */ }
  }
  return normalized;
}

export function subscribeRefreshPolicy(listener) {
  if (typeof window === "undefined" || typeof listener !== "function") return () => {};
  const onStorage = (event) => {
    if (event.key === REFRESH_POLICY_STORAGE_KEY) listener(normalizeRefreshPolicy(event.newValue));
  };
  const onCustom = (event) => listener(normalizeRefreshPolicy(event.detail));
  window.addEventListener("storage", onStorage);
  window.addEventListener("foliomind:refresh-policy", onCustom);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener("foliomind:refresh-policy", onCustom);
  };
}
