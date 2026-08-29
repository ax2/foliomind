import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

const HOST = "127.0.0.1";
const PORT = Number(process.env.FOLIOMIND_HOST_PORT || 43123);
const MAX_BODY = 512 * 1024;
const DEFAULT_CAPABILITY = "https://qveris.ai/api/v1";
const DEFAULT_GATEWAY = "https://aigateway.qveris.ai/v1";
const BRIDGE_LIMIT = 20;
const token = `fh_${randomUUID()}`;
const dataDir = process.env.FOLIOMIND_DEV_DATA_DIR || join(
  process.env.XDG_CONFIG_HOME || (platform() === "win32" ? process.env.APPDATA || join(homedir(), "AppData", "Roaming") : join(homedir(), ".config")),
  "foliomind",
);
const settingsFile = join(dataDir, "integration-settings.json");
const credentialFile = join(dataDir, "qveris-api-key");
const stateFile = join(dataDir, "user-state.json");
const toolCacheFile = join(dataDir, "tool-selection-cache.json");

const defaultSettings = { capabilityBaseUrl: DEFAULT_CAPABILITY, modelGatewayBaseUrl: DEFAULT_GATEWAY, modelId: "", models: [] };
const defaultState = {
  watchlist: [{ symbol: "600519", name: "贵州茅台", market: "沪深", category: "白酒" }, { symbol: "300750", name: "宁德时代", market: "深市", category: "新能源" }],
  monitorRules: [{ id: "r1", symbol: "600519", strategyId: "price_change", threshold: 3, intervalSeconds: 300, enabled: true, lastCheckedAt: null, lastTriggeredAt: null }, { id: "r2", symbol: "300750", strategyId: "news_risk", threshold: 1, intervalSeconds: 600, enabled: true, lastCheckedAt: null, lastTriggeredAt: null }],
  notifications: [],
  portfolioPositions: [],
};

let runtimeState = "stopped";
let activeAbort = null;
const devLogs = [];
const devVariables = {
  toolCacheEnabled: true,
  requestTimeoutMs: 120_000,
  maxConcurrentDataRequests: 1,
  logLevel: "info",
};

function redact(value) {
  return String(value || "")
    .replace(/Bearer\s+[^\s,;"']+/gi, "Bearer [REDACTED]")
    .replace(/(api[_-]?key|token|secret|authorization)\s*[:=]\s*[^\s,;"']+/gi, (_match, key) => `${key}=[REDACTED]`)
    .replace(/([?&](?:api[_-]?key|token|secret)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/\b(?:sk|cap)_[A-Za-z0-9._-]+\b/g, "[REDACTED]")
    .slice(0, 800);
}
function logInvocation(event) {
  if (devVariables.logLevel === "silent") return;
  if (devVariables.logLevel === "error" && Number(event.status || 200) < 400) return;
  devLogs.push({ id: randomUUID(), at: new Date().toISOString(), ...event, detail: event.detail ? redact(event.detail) : undefined });
  while (devLogs.length > 500) devLogs.shift();
}
function safeSettings(settings) {
  return { capabilityBaseUrl: redact(settings?.capabilityBaseUrl || DEFAULT_CAPABILITY), modelGatewayBaseUrl: redact(settings?.modelGatewayBaseUrl || DEFAULT_GATEWAY), modelId: redact(settings?.modelId || ""), modelCount: Array.isArray(settings?.models) ? settings.models.length : 0 };
}
async function readToolCache() { return await readJson(toolCacheFile, {}); }
async function writeToolCache(value) { await atomicJson(toolCacheFile, value); }
async function clearToolCache() { try { await unlink(toolCacheFile); } catch { /* idempotent */ } }
function cacheKey(kind, settings) {
  return [kind, settings?.capabilityBaseUrl || DEFAULT_CAPABILITY, settings?.modelGatewayBaseUrl || DEFAULT_GATEWAY, settings?.modelId || ""].join("|");
}
export function classifyRequest(message) {
  const text = String(message || "");
  if (/实时行情|行情快照|最新价|报价|quote/i.test(text)) return "quote";
  if (/公司简介|财务指标|基本面|fundamental/i.test(text)) return "details";
  if (/历史|分时|日线|周线|月线|季度|年线|series|trend/i.test(text)) return "series";
  return null;
}
export function adaptParameters(template, symbol, range) {
  const params = template && typeof template === "object" ? structuredClone(template) : {};
  const canonical = String(symbol || "").trim().toUpperCase();
  for (const key of Object.keys(params)) {
    if (/^(symbol|ticker|code|stock_code|stockCode|securities_code)$/i.test(key)) params[key] = canonical;
    if (/^(range|period|interval|time_range|timeRange)$/i.test(key) && range) params[key] = range;
  }
  if (!Object.keys(params).some((key) => /^(symbol|ticker|code|stock_code|stockCode|securities_code)$/i.test(key))) params.symbol = canonical;
  return params;
}
function cacheSummary(cache) {
  return Object.entries(cache || {}).map(([key, entry]) => ({ key, kind: entry.kind, toolId: entry.toolId, searchId: entry.searchId, createdAt: entry.createdAt, lastUsedAt: entry.lastUsedAt, hitCount: Number(entry.hitCount) || 0 }));
}

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; }
}
async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}
async function readKey() {
  try { const value = (await readFile(credentialFile, "utf8")).trim(); if (value) return value; } catch { /* first run */ }
  return String(process.env.QVERIS_API_KEY || "").trim() || null;
}
async function saveKey(value) {
  await mkdir(dataDir, { recursive: true });
  await writeFile(credentialFile, `${value.trim()}\n`, { encoding: "utf8", mode: 0o600 });
  try { await chmod(credentialFile, 0o600); } catch { /* Windows has no POSIX mode. */ }
}
async function deleteKey() { try { await unlink(credentialFile); } catch { /* idempotent */ } }
function apiKeyPrefix(value) { const key = String(value || "").trim(); return key ? `${key.slice(0, 8)}${key.length > 8 ? "…" : ""}` : ""; }

function normalizeModels(items) {
  const seen = new Set();
  return (Array.isArray(items) ? items : []).flatMap((item) => {
    const id = typeof item?.id === "string" ? item.id.trim() : "";
    if (!id || id.length > 256 || seen.has(id)) return [];
    const capabilities = Array.isArray(item.capabilities) ? item.capabilities : [];
    if (capabilities.length && !capabilities.includes("chat")) return [];
    seen.add(id);
    return [{ id, name: id, reasoning: capabilities.includes("reasoning"), input: capabilities.includes("vision") ? ["text", "image"] : ["text"], contextWindow: Number(item.context_window) || 128000, maxTokens: Number(item.max_output_tokens) || 16384 }];
  }).sort((a, b) => a.id.localeCompare(b.id));
}
function endpoint(base, suffix) { return `${String(base).replace(/\/$/, "")}/${suffix.replace(/^\//, "")}`; }
async function upstream(url, options = {}, signal) {
  const response = await fetch(url, { ...options, signal, headers: { accept: "application/json", ...(options.headers || {}) } });
  const text = await response.text();
  let body; try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }
  if (!response.ok) {
    const error = new Error(`上游请求失败（HTTP ${response.status}）`);
    error.status = response.status;
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter.trim())) error.retryAfterMs = Math.min(30_000, Number(retryAfter) * 1_000);
    throw error;
  }
  return body;
}
export function isRetryableUpstreamStatus(status) {
  return [408, 425, 429, 500, 502, 503, 504].includes(Number(status));
}

export function retryDelayMs(attempt, retryAfterMs = 0) {
  const serverDelay = Number.isFinite(Number(retryAfterMs)) ? Math.max(0, Number(retryAfterMs)) : 0;
  const exponentialDelay = 500 * (2 ** Math.max(0, Number(attempt) || 0));
  return Math.min(8_000, Math.max(serverDelay, exponentialDelay));
}

export async function upstreamWithRetry(url, options = {}, signal, attempts = 2) {
  for (let attempt = 0; ; attempt += 1) {
    try { return await upstream(url, options, signal); }
    catch (error) {
      if (!isRetryableUpstreamStatus(error?.status) || attempt >= attempts) throw error;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, retryDelayMs(attempt, error?.retryAfterMs));
        if (signal) signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason || new Error("aborted")); }, { once: true });
      });
    }
  }
}
function jsonHeaders(origin) {
  const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-headers": "Content-Type, X-FolioMind-Host", "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS" };
  if (origin && /^https?:\/\/(localhost|127\.0\.0\.1|\[?::1\]?)(:\d+)?\/?$/.test(origin)) { headers["access-control-allow-origin"] = origin; headers.vary = "Origin"; }
  return headers;
}
async function bodyOf(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) throw new Error("请求体过大"); chunks.push(chunk); }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("请求 JSON 无效"); }
}
function requireSession(req) {
  if (req.headers["x-foliomind-host"] !== token) { const error = new Error("invalid local host session"); error.status = 401; throw error; }
}
function toolDefinitions() {
  return [
    { type: "function", function: { name: "foliomind_data", description: "FolioMind 内置金融数据工具。优先直接调用上次已固化的工具；缓存不存在或失效时，再使用 qveris_search、qveris_inspect、qveris_call 建立固化工具。", parameters: { type: "object", properties: { kind: { type: "string", enum: ["quote", "details", "series"] }, symbol: { type: "string" }, range: { type: "string" } }, required: ["kind", "symbol"], additionalProperties: false } } },
    { type: "function", function: { name: "qveris_search", description: "搜索 QVeris 数据能力。外部、实时或专业数据先搜索，随后必须 Inspect。", parameters: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 20 } }, required: ["query"], additionalProperties: false } } },
    { type: "function", function: { name: "qveris_inspect", description: "检查 Search 返回的候选工具参数；Call 前必需。", parameters: { type: "object", properties: { tool_ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 5 }, search_id: { type: "string" } }, required: ["tool_ids", "search_id"], additionalProperties: false } } },
    { type: "function", function: { name: "qveris_call", description: "调用已 Search 且 Inspect 的 QVeris 工具。", parameters: { type: "object", properties: { tool_id: { type: "string" }, parameters: { type: "object", additionalProperties: true }, search_id: { type: "string" } }, required: ["tool_id", "parameters", "search_id"], additionalProperties: false } } },
  ];
}
function idsFromSearch(payload) {
  const values = payload?.result?.tools || payload?.result?.results || payload?.tools || payload?.results || [];
  return new Set((Array.isArray(values) ? values : []).map((value) => String(value?.tool_id || value?.id || "").trim()).filter(Boolean));
}
async function qverisOperation(operation, input, settings, key, runId, phases, signal) {
  let url; let payload;
  if (operation === "search") {
    url = endpoint(settings.capabilityBaseUrl, "search");
    payload = { ...input, session_id: runId, view: "routing", lang: "zh", limit: Math.min(Number(input.limit) || 8, BRIDGE_LIMIT) };
  } else if (operation === "inspect") {
    url = endpoint(settings.capabilityBaseUrl, "tools/by-ids");
    payload = { ...input, session_id: runId, view: "lean" };
  } else {
    const toolId = String(input.tool_id || "");
    url = `${endpoint(settings.capabilityBaseUrl, "tools/execute")}?tool_id=${encodeURIComponent(toolId)}`;
    payload = { ...input, session_id: runId, max_response_size: 20480, respond_with: "full" };
    delete payload.tool_id;
  }
  if (operation !== "search") {
    const searchId = String(input.search_id || "");
    if (!phases.searches.has(searchId)) throw new Error("必须先在本轮运行中成功执行 Search");
    if (operation === "inspect" && (!Array.isArray(input.tool_ids) || input.tool_ids.some((id) => !phases.searches.get(searchId).has(String(id))))) throw new Error("Inspect 只能检查对应 Search 返回的工具");
    if (operation === "call" && (!phases.searches.get(searchId).has(String(input.tool_id)) || !phases.inspected.has(`${searchId}:${input.tool_id}`))) throw new Error("Call 前必须先 Inspect 对应工具");
  }
  const startedAt = Date.now();
  let result;
  try {
    result = await upstreamWithRetry(url, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(payload) }, signal);
  } catch (error) {
    logInvocation({ type: "qveris", operation, status: Number(error.status) || 502, durationMs: Date.now() - startedAt, detail: error.message });
    throw error;
  }
  logInvocation({ type: "qveris", operation, status: 200, durationMs: Date.now() - startedAt, cacheHit: false });
  if (operation === "search") { const searchId = String(result.search_id || result.result?.search_id || ""); const ids = idsFromSearch(result); if (!searchId || !ids.size) throw new Error("Search 返回缺少 search_id 或候选工具"); phases.searches.set(searchId, ids); }
  if (operation === "inspect") for (const id of input.tool_ids) phases.inspected.add(`${input.search_id}:${id}`);
  return result;
}
async function rememberToolSelection(kind, settings, input, runId) {
  if (!kind || !devVariables.toolCacheEnabled || !input?.tool_id || !input?.search_id) return;
  const cache = await readToolCache();
  const key = cacheKey(kind, settings);
  const previous = cache[key] || {};
  cache[key] = {
    kind,
    toolId: String(input.tool_id),
    searchId: String(input.search_id),
    runId: String(runId),
    parameters: input.parameters && typeof input.parameters === "object" ? input.parameters : {},
    createdAt: previous.createdAt || new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
    hitCount: Number(previous.hitCount) || 0,
  };
  await writeToolCache(cache);
}
async function queryCachedData(input, settings, key, signal) {
  const kind = String(input?.kind || "").trim();
  if (!devVariables.toolCacheEnabled || !["quote", "details", "series"].includes(kind)) {
    const error = new Error("工具缓存未启用"); error.status = 404; error.code = "TOOL_CACHE_MISS"; throw error;
  }
  const cache = await readToolCache();
  const entry = cache[cacheKey(kind, settings)];
  if (!entry?.toolId || !entry?.searchId) {
    const error = new Error("尚未固化该类数据工具"); error.status = 404; error.code = "TOOL_CACHE_MISS"; throw error;
  }
  const runId = `cached_${randomUUID()}`;
  const phases = { searches: new Map([[entry.searchId, new Set([entry.toolId])]]), inspected: new Set([`${entry.searchId}:${entry.toolId}`]) };
  const startedAt = Date.now();
  let result;
  try {
    result = await qverisOperation("call", { search_id: entry.searchId, tool_id: entry.toolId, parameters: adaptParameters(entry.parameters, input.symbol, input.range) }, settings, key, runId, phases, signal);
  } catch (error) {
    delete cache[cacheKey(kind, settings)];
    await writeToolCache(cache);
    throw error;
  }
  entry.lastUsedAt = new Date().toISOString();
  entry.hitCount = (Number(entry.hitCount) || 0) + 1;
  cache[cacheKey(kind, settings)] = entry;
  await writeToolCache(cache);
  logInvocation({ type: "data", operation: "cached-call", kind, toolId: entry.toolId, cacheHit: true, durationMs: Date.now() - startedAt });
  return result;
}
async function promptAgent(message, settings, key, signal) {
  const model = settings.modelId || settings.models?.[0]?.id;
  if (!model) throw new Error("请先在设置中同步 QVeris 模型并选择模型");
  const runId = `product_${randomUUID()}`;
  const phases = { searches: new Map(), inspected: new Set() };
  const audits = [];
  const messages = [{ role: "system", content: "你是 FolioMind 金融研究 Agent。涉及实时、外部或专业数据时，先尝试使用内置 foliomind_data 直接复用已固化工具；工具提示缓存未命中时，再严格按 Search → Inspect → Call 顺序使用 QVeris 工具并让系统固化本次选择。回答要标明数据时间、来源和不确定性。" }, { role: "user", content: message }];
  for (let round = 0; round < 8; round += 1) {
    const response = await upstreamWithRetry(endpoint(settings.modelGatewayBaseUrl, "chat/completions"), { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ model, messages, tools: toolDefinitions(), tool_choice: "auto", max_tokens: 4096 }) }, signal);
    const assistant = response.choices?.[0]?.message;
    if (!assistant) throw new Error("模型返回为空");
    messages.push(assistant);
    const calls = Array.isArray(assistant.tool_calls) ? assistant.tool_calls : [];
    if (!calls.length) return { text: assistant.content || assistant.reasoning || "模型已完成本轮分析。", audits };
    for (const call of calls) {
      const name = call.function?.name;
      if (name === "foliomind_data") {
        let input; try { input = JSON.parse(call.function.arguments || "{}"); } catch { throw new Error("工具参数不是有效 JSON"); }
        try {
          const cachedResult = await queryCachedData(input, settings, key, signal);
          audits.push({ operation: "cached-call", runId, toolCallId: call.id || randomUUID(), outcome: "success", detail: null });
          messages.push({ role: "tool", tool_call_id: call.id, name, content: JSON.stringify(cachedResult) });
        } catch (error) {
          audits.push({ operation: "cached-call", runId, toolCallId: call.id || randomUUID(), outcome: "error", detail: "cache-miss" });
          messages.push({ role: "tool", tool_call_id: call.id, name, content: JSON.stringify({ error: "当前没有可直接复用的工具", next_action: "请按 qveris_search → qveris_inspect → qveris_call 建立工具固化缓存。" }) });
        }
        continue;
      }
      const operation = name === "qveris_search" ? "search" : name === "qveris_inspect" ? "inspect" : name === "qveris_call" ? "call" : null;
      if (!operation) throw new Error("模型请求了未授权工具");
      let input; try { input = JSON.parse(call.function.arguments || "{}"); } catch { throw new Error("工具参数不是有效 JSON"); }
      const result = await qverisOperation(operation, input, settings, key, runId, phases, signal);
      if (operation === "call") {
        try { await rememberToolSelection(classifyRequest(message), settings, input, runId); }
        catch (error) { logInvocation({ type: "cache", operation: "persist", status: 500, durationMs: 0, detail: error.message }); }
      }
      audits.push({ operation, runId, toolCallId: call.id || randomUUID(), outcome: "success", detail: null });
      messages.push({ role: "tool", tool_call_id: call.id, name, content: JSON.stringify(result) });
    }
  }
  throw new Error("模型工具调用超过最大轮数");
}

async function route(req, body) {
  const method = req.method; const path = new URL(req.url, `http://${HOST}`).pathname;
  if (method === "GET" && path === "/api/health") return { ok: true, service: "foliomind-dev-host", mode: "standalone" };
  if (method === "GET" && path === "/api/session") return { token, service: "foliomind-dev-host", mode: "standalone" };
  requireSession(req);
  if (method === "GET" && path === "/api/integration/status") { const key = await readKey(); return { credentialConfigured: Boolean(key), keyPrefix: apiKeyPrefix(key), settings: await readJson(settingsFile, defaultSettings) }; }
  if (method === "POST" && path === "/api/integration/credential") { if (typeof body.apiKey !== "string" || body.apiKey.trim().length < 8) throw new Error("API Key 无效"); await saveKey(body.apiKey); await clearToolCache(); return { configured: true, keyPrefix: apiKeyPrefix(body.apiKey) }; }
  if (method === "DELETE" && path === "/api/integration/credential") { await deleteKey(); await clearToolCache(); return { configured: false, keyPrefix: "" }; }
  if (method === "POST" && path === "/api/integration/models/sync") {
    const input = body.input || {}; const key = await readKey(); if (!key) throw new Error("QVeris credential is not configured");
    const settings = { ...(await readJson(settingsFile, defaultSettings)), capabilityBaseUrl: String(input.capabilityBaseUrl || DEFAULT_CAPABILITY).trim().replace(/\/$/, ""), modelGatewayBaseUrl: String(input.modelGatewayBaseUrl || DEFAULT_GATEWAY).trim().replace(/\/$/, ""), modelId: String(input.modelId || "").trim() };
    settings.models = normalizeModels((await upstream(endpoint(settings.modelGatewayBaseUrl, "models"), { headers: { authorization: `Bearer ${key}` } })).data);
    settings.modelId = settings.models.some((item) => item.id === settings.modelId) ? settings.modelId : settings.models[0]?.id || "";
    await atomicJson(settingsFile, settings); await clearToolCache(); return settings;
  }
  if (method === "POST" && path === "/api/integration/settings") { const input = body.input || {}; const settings = { ...(await readJson(settingsFile, defaultSettings)), capabilityBaseUrl: String(input.capabilityBaseUrl || DEFAULT_CAPABILITY).trim().replace(/\/$/, ""), modelGatewayBaseUrl: String(input.modelGatewayBaseUrl || DEFAULT_GATEWAY).trim().replace(/\/$/, ""), modelId: String(input.modelId || "").trim(), models: Array.isArray(input.models) ? input.models : (await readJson(settingsFile, defaultSettings)).models || [] }; await atomicJson(settingsFile, settings); await clearToolCache(); return settings; }
  if (method === "GET" && path === "/api/dev/overview") {
    const settings = await readJson(settingsFile, defaultSettings); const key = await readKey();
    return { logs: devLogs.slice(-200), state: { runtimeState, activeRequest: Boolean(activeAbort), pid: process.pid, credentialConfigured: Boolean(key), keyPrefix: apiKeyPrefix(key), settings: safeSettings(settings), toolCache: cacheSummary(await readToolCache()) }, variables: { ...devVariables } };
  }
  if (method === "DELETE" && path === "/api/dev/logs") { devLogs.length = 0; return { cleared: true }; }
  if (method === "PATCH" && path === "/api/dev/variables") {
    const input = body && typeof body === "object" ? body : {};
    if (Object.hasOwn(input, "toolCacheEnabled")) { if (typeof input.toolCacheEnabled !== "boolean") throw new Error("toolCacheEnabled 必须是布尔值"); devVariables.toolCacheEnabled = input.toolCacheEnabled; }
    if (Object.hasOwn(input, "requestTimeoutMs")) { const value = Number(input.requestTimeoutMs); if (!Number.isInteger(value) || value < 5_000 || value > 180_000) throw new Error("requestTimeoutMs 需在 5000–180000 之间"); devVariables.requestTimeoutMs = value; }
    if (Object.hasOwn(input, "maxConcurrentDataRequests")) { const value = Number(input.maxConcurrentDataRequests); if (!Number.isInteger(value) || value < 1 || value > 4) throw new Error("maxConcurrentDataRequests 需在 1–4 之间"); devVariables.maxConcurrentDataRequests = value; }
    if (Object.hasOwn(input, "logLevel")) { if (!["silent", "error", "info", "debug"].includes(input.logLevel)) throw new Error("logLevel 无效"); devVariables.logLevel = input.logLevel; }
    return { variables: { ...devVariables } };
  }
  if (method === "POST" && path === "/api/data/query") {
    const key = await readKey(); if (!key) throw new Error("请先配置 QVeris API Key");
    const settings = await readJson(settingsFile, defaultSettings); const input = body.input || {};
    if (!String(input.symbol || "").trim() || !["quote", "details", "series"].includes(String(input.kind || ""))) throw new Error("数据查询参数无效");
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(new Error("timeout")), devVariables.requestTimeoutMs);
    try { const result = await queryCachedData(input, settings, key, controller.signal); return { data: result?.result ?? result, cacheHit: true, mode: "standalone-dev-host", audits: [{ operation: "cached-call", outcome: "success", toolId: "cached" }] }; }
    finally { clearTimeout(timeout); }
  }
  if (method === "GET" && path === "/api/user-state") return readJson(stateFile, defaultState);
  if (method === "POST" && path === "/api/user-state") { await atomicJson(stateFile, body.state || defaultState); return body.state || defaultState; }
  if (method === "GET" && path === "/api/runtime/status") return { state: runtimeState, pid: process.pid, detail: null };
  if (method === "POST" && path === "/api/runtime/start") { runtimeState = "running"; return { state: runtimeState, pid: process.pid, detail: null }; }
  if (method === "POST" && path === "/api/runtime/stop") { runtimeState = "stopped"; activeAbort?.abort(); activeAbort = null; return { state: runtimeState, pid: null, detail: null }; }
  if (method === "POST" && path === "/api/runtime/abort") { activeAbort?.abort(new Error("aborted")); return { success: true }; }
  if (method === "POST" && path === "/api/runtime/prompt") {
    if (typeof body.message !== "string" || !body.message.trim()) throw new Error("分析问题不能为空");
    const key = await readKey(); if (!key) throw new Error("请先配置 QVeris API Key");
    const settings = await readJson(settingsFile, defaultSettings); runtimeState = "running"; activeAbort = new AbortController();
    const timeoutMs = Math.max(5_000, Math.min(180_000, Number(body.timeoutMs) || devVariables.requestTimeoutMs));
    const timeout = setTimeout(() => activeAbort?.abort(new Error("timeout")), timeoutMs);
    try { return { ...(await promptAgent(body.message.trim(), settings, key, activeAbort.signal)), mode: "standalone-dev-host" }; }
    finally {
      clearTimeout(timeout);
      activeAbort = null;
      // A completed (or failed) request must release the runtime lock so the
      // next browser prompt can start without requiring a host restart.
      runtimeState = "stopped";
    }
  }
  const error = new Error("route not found"); error.status = 404; throw error;
}

export function startLocalHost({ port = PORT } = {}) {
  const server = createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (req.method === "OPTIONS") { res.writeHead(204, jsonHeaders(origin)); res.end(); return; }
    const startedAt = Date.now();
    const path = new URL(req.url, `http://${HOST}`).pathname;
    try {
      const body = ["POST", "PUT", "PATCH"].includes(req.method) ? await bodyOf(req) : {};
      const result = await route(req, body);
      logInvocation({ type: "http", method: req.method, path, status: 200, durationMs: Date.now() - startedAt });
      res.writeHead(200, jsonHeaders(origin)); res.end(JSON.stringify(result));
    } catch (error) {
      const status = Number(error.status) || (String(error.message).includes("route") ? 404 : 400);
      logInvocation({ type: "http", method: req.method, path, status, durationMs: Date.now() - startedAt, detail: error.message });
      res.writeHead(status, jsonHeaders(origin)); res.end(JSON.stringify({ error: error.message || "本地 Host 请求失败", code: error.code || undefined }));
    }
  });
  server.on("error", (error) => {
    console.error(`[foliomind-dev-host] failed to listen on ${HOST}:${port}: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(port, HOST, () => {
    if (process.argv[1]?.endsWith("local-host.mjs")) console.log(`[foliomind-dev-host] listening on http://${HOST}:${port}`);
  });
  return server;
}

if (process.argv[1] && process.argv[1].endsWith("local-host.mjs")) {
  const server = startLocalHost();
  const close = () => server.close(() => process.exit(0));
  process.once("SIGINT", close); process.once("SIGTERM", close);
}
