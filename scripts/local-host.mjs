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

const defaultSettings = { capabilityBaseUrl: DEFAULT_CAPABILITY, modelGatewayBaseUrl: DEFAULT_GATEWAY, modelId: "", models: [] };
const defaultState = {
  watchlist: [{ symbol: "600519", name: "贵州茅台", market: "沪深", category: "白酒" }, { symbol: "300750", name: "宁德时代", market: "深市", category: "新能源" }],
  monitorRules: [{ id: "r1", symbol: "600519", strategyId: "price_change", threshold: 3, intervalSeconds: 300, enabled: true, lastCheckedAt: null, lastTriggeredAt: null }, { id: "r2", symbol: "300750", strategyId: "news_risk", threshold: 1, intervalSeconds: 600, enabled: true, lastCheckedAt: null, lastTriggeredAt: null }],
  notifications: [],
};

let runtimeState = "stopped";
let activeAbort = null;

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
  if (!response.ok) { const error = new Error(`上游请求失败（HTTP ${response.status}）`); error.status = response.status; throw error; }
  return body;
}
async function upstreamWithRetry(url, options = {}, signal, attempts = 2) {
  for (let attempt = 0; ; attempt += 1) {
    try { return await upstream(url, options, signal); }
    catch (error) {
      const retryable = [429, 500, 502, 503, 504].includes(Number(error?.status));
      if (!retryable || attempt >= attempts) throw error;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 500 * (attempt + 1));
        if (signal) signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason || new Error("aborted")); }, { once: true });
      });
    }
  }
}
function jsonHeaders(origin) {
  const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-headers": "Content-Type, X-FolioMind-Host", "access-control-allow-methods": "GET, POST, DELETE, OPTIONS" };
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
  const result = await upstream(url, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(payload) }, signal);
  if (operation === "search") { const searchId = String(result.search_id || result.result?.search_id || ""); const ids = idsFromSearch(result); if (!searchId || !ids.size) throw new Error("Search 返回缺少 search_id 或候选工具"); phases.searches.set(searchId, ids); }
  if (operation === "inspect") for (const id of input.tool_ids) phases.inspected.add(`${input.search_id}:${id}`);
  return result;
}
async function promptAgent(message, settings, key, signal) {
  const model = settings.modelId || settings.models?.[0]?.id;
  if (!model) throw new Error("请先在设置中同步 QVeris 模型并选择模型");
  const runId = `product_${randomUUID()}`;
  const phases = { searches: new Map(), inspected: new Set() };
  const audits = [];
  const messages = [{ role: "system", content: "你是 FolioMind 金融研究 Agent。涉及实时、外部或专业数据时，必须按 Search → Inspect → Call 顺序使用 QVeris 工具；回答要标明数据时间、来源和不确定性。" }, { role: "user", content: message }];
  for (let round = 0; round < 8; round += 1) {
    const response = await upstreamWithRetry(endpoint(settings.modelGatewayBaseUrl, "chat/completions"), { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ model, messages, tools: toolDefinitions(), tool_choice: "auto", max_tokens: 4096 }) }, signal);
    const assistant = response.choices?.[0]?.message;
    if (!assistant) throw new Error("模型返回为空");
    messages.push(assistant);
    const calls = Array.isArray(assistant.tool_calls) ? assistant.tool_calls : [];
    if (!calls.length) return { text: assistant.content || assistant.reasoning || "模型已完成本轮分析。", audits };
    for (const call of calls) {
      const name = call.function?.name;
      const operation = name === "qveris_search" ? "search" : name === "qveris_inspect" ? "inspect" : name === "qveris_call" ? "call" : null;
      if (!operation) throw new Error("模型请求了未授权工具");
      let input; try { input = JSON.parse(call.function.arguments || "{}"); } catch { throw new Error("工具参数不是有效 JSON"); }
      const result = await qverisOperation(operation, input, settings, key, runId, phases, signal);
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
  if (method === "POST" && path === "/api/integration/credential") { if (typeof body.apiKey !== "string" || body.apiKey.trim().length < 8) throw new Error("API Key 无效"); await saveKey(body.apiKey); return { configured: true }; }
  if (method === "DELETE" && path === "/api/integration/credential") { await deleteKey(); return { configured: false }; }
  if (method === "POST" && path === "/api/integration/models/sync") {
    const input = body.input || {}; const key = await readKey(); if (!key) throw new Error("QVeris credential is not configured");
    const settings = { ...(await readJson(settingsFile, defaultSettings)), capabilityBaseUrl: String(input.capabilityBaseUrl || DEFAULT_CAPABILITY).trim().replace(/\/$/, ""), modelGatewayBaseUrl: String(input.modelGatewayBaseUrl || DEFAULT_GATEWAY).trim().replace(/\/$/, ""), modelId: String(input.modelId || "").trim() };
    settings.models = normalizeModels((await upstream(endpoint(settings.modelGatewayBaseUrl, "models"), { headers: { authorization: `Bearer ${key}` } })).data);
    settings.modelId = settings.models.some((item) => item.id === settings.modelId) ? settings.modelId : settings.models[0]?.id || "";
    await atomicJson(settingsFile, settings); return settings;
  }
  if (method === "POST" && path === "/api/integration/settings") { const input = body.input || {}; const settings = { ...(await readJson(settingsFile, defaultSettings)), capabilityBaseUrl: String(input.capabilityBaseUrl || DEFAULT_CAPABILITY).trim().replace(/\/$/, ""), modelGatewayBaseUrl: String(input.modelGatewayBaseUrl || DEFAULT_GATEWAY).trim().replace(/\/$/, ""), modelId: String(input.modelId || "").trim(), models: Array.isArray(input.models) ? input.models : (await readJson(settingsFile, defaultSettings)).models || [] }; await atomicJson(settingsFile, settings); return settings; }
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
    const timeoutMs = Math.max(1_000, Math.min(125_000, Number(body.timeoutMs) || 120_000));
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
    try {
      const body = ["POST", "PUT", "PATCH"].includes(req.method) ? await bodyOf(req) : {};
      const result = await route(req, body);
      res.writeHead(200, jsonHeaders(origin)); res.end(JSON.stringify(result));
    } catch (error) {
      const status = Number(error.status) || (String(error.message).includes("route") ? 404 : 400);
      res.writeHead(status, jsonHeaders(origin)); res.end(JSON.stringify({ error: error.message || "本地 Host 请求失败" }));
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
