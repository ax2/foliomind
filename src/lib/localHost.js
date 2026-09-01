const LOCAL_HOST_PORT = import.meta.env.VITE_FOLIOMIND_HOST_PORT || "43123";
export const LOCAL_HOST_BASE_URL = `http://127.0.0.1:${LOCAL_HOST_PORT}`;
export const LOCAL_HOST_UNAVAILABLE = "LOCAL_HOST_UNAVAILABLE";

let sessionToken = null;
let sessionRequest = null;
let developerVariables = null;

export function isLocalWebRuntime() {
  if (typeof window === "undefined" || Boolean(window.__TAURI_INTERNALS__)) return false;
  return ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
}

function localHostError(message, cause) {
  const error = new Error(message);
  error.code = LOCAL_HOST_UNAVAILABLE;
  if (cause) error.cause = cause;
  return error;
}

export const LOCAL_HOST_ABORTED = "LOCAL_HOST_ABORTED";

function readSessionToken() {
  if (sessionToken) return sessionToken;
  try { sessionToken = window.sessionStorage.getItem("foliomind.local-host-token"); } catch { /* Storage may be disabled. */ }
  return sessionToken;
}

function writeSessionToken(value) {
  sessionToken = value;
  try { window.sessionStorage.setItem("foliomind.local-host-token", value); } catch { /* Memory-only session is sufficient. */ }
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 8_000);
  const onAbort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetch(url, { ...options, signal: controller.signal, headers: { Accept: "application/json", ...(options.headers || {}) } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body.error || `本地 Host 请求失败（${response.status}）`);
      error.status = response.status;
      if (body.code) error.code = body.code;
      error.response = body;
      throw error;
    }
    return body;
  } catch (error) {
    if (error?.name === "AbortError" && options.signal?.aborted) {
      const aborted = localHostError("本次本地数据请求已取消", error);
      aborted.code = LOCAL_HOST_ABORTED;
      throw aborted;
    }
    if (error?.name === "AbortError") throw localHostError("本地调试 Host 响应超时，请确认 npm run web:dev 正在运行", error);
    if (error?.code === LOCAL_HOST_UNAVAILABLE) throw error;
    if (error instanceof TypeError) throw localHostError("无法连接本地调试 Host，请先运行 npm run web:dev", error);
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

async function createSession() {
  if (!isLocalWebRuntime()) throw localHostError("本地调试 Host 仅支持 localhost 页面");
  const body = await fetchJson(`${LOCAL_HOST_BASE_URL}/api/session`, { timeoutMs: 3_000 });
  if (typeof body.token !== "string" || !body.token) throw localHostError("本地调试 Host 未返回有效会话令牌");
  writeSessionToken(body.token);
  return body.token;
}

async function getSessionToken() {
  const existing = readSessionToken();
  if (existing) return existing;
  if (!sessionRequest) sessionRequest = createSession().finally(() => { sessionRequest = null; });
  return sessionRequest;
}

export async function localHostRequest(path, { retry = true, ...options } = {}) {
  const token = await getSessionToken();
  const headers = { "Content-Type": "application/json", "X-FolioMind-Host": token, ...(options.headers || {}) };
  try {
    return await fetchJson(`${LOCAL_HOST_BASE_URL}${path}`, { ...options, headers });
  } catch (error) {
    if (retry && error?.status === 401 && !options.signal?.aborted) {
      sessionToken = null;
      try { window.sessionStorage.removeItem("foliomind.local-host-token"); } catch { /* Ignore storage failures. */ }
      return localHostRequest(path, { ...options, retry: false });
    }
    throw error;
  }
}

export function queryCachedData(input, options = {}) {
  return localHostRequest("/api/data/query", { ...options, method: "POST", body: JSON.stringify({ input }) });
}

export function testCapability(input, options = {}) {
  return localHostRequest("/api/dev/capabilities/test", { ...options, method: "POST", body: JSON.stringify({ input }) });
}

export function discoverCapabilities(input = {}, options = {}) {
  return localHostRequest("/api/dev/capabilities/discover", { timeoutMs: 30_000, ...options, method: "POST", body: JSON.stringify({ input }) });
}

export async function loadDeveloperOverview(options = {}) {
  const overview = await localHostRequest("/api/dev/overview", options);
  if (overview?.variables && typeof overview.variables === "object") developerVariables = { ...overview.variables };
  return overview;
}

export async function updateDeveloperVariables(variables, options = {}) {
  const result = await localHostRequest("/api/dev/variables", { ...options, method: "PATCH", body: JSON.stringify(variables) });
  if (result?.variables && typeof result.variables === "object") developerVariables = { ...result.variables };
  return result;
}

export function getDeveloperVariable(name, fallback) {
  return developerVariables && Object.hasOwn(developerVariables, name) ? developerVariables[name] : fallback;
}

export function clearDeveloperLogs(options = {}) {
  return localHostRequest("/api/dev/logs", { ...options, method: "DELETE" });
}

export function clearLocalHostSession() {
  sessionToken = null;
  try { window.sessionStorage.removeItem("foliomind.local-host-token"); } catch { /* Ignore storage failures. */ }
}
