import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { appendFile, chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { normalizeUserState } from "../src/lib/userStateSchema.js";

const HOST = "127.0.0.1";
const PORT = Number(process.env.FOLIOMIND_HOST_PORT || 43123);
const MAX_BODY = 512 * 1024;
const DEFAULT_CAPABILITY = "https://qveris.ai/api/v1";
const DEFAULT_GATEWAY = "https://aigateway.qveris.ai/v1";
export const DEFAULT_DATA_PROVIDER = "qveris_finance";
export const CAPABILITY_CATALOG_VERSION = 2;
const BRIDGE_LIMIT = 20;
const CAPABILITY_DIRECTORY_LIMIT = 100;
export const DEFAULT_MAX_CONCURRENT_DATA_REQUESTS = 2;
const token = `fh_${randomUUID()}`;
const dataDir = process.env.FOLIOMIND_DEV_DATA_DIR || join(
  process.env.XDG_CONFIG_HOME || (platform() === "win32" ? process.env.APPDATA || join(homedir(), "AppData", "Roaming") : join(homedir(), ".config")),
  "foliomind",
);
const settingsFile = join(dataDir, "integration-settings.json");
const credentialFile = join(dataDir, "qveris-api-key");
const stateFile = join(dataDir, "user-state.json");
const STATE_LOCK_FILE_NAME = ".user-state.json.lock";
export const STATE_FILE_LOCK_TIMEOUT_MS = 5_000;
export const STATE_FILE_LOCK_STALE_MS = 30_000;
const STATE_FILE_LOCK_RETRY_MS = 25;
const toolCacheFile = join(dataDir, "tool-selection-cache.json");
const developerLogFile = join(dataDir, "developer-logs.ndjson");
export const DEVELOPER_LOG_RETENTION_MS = 180 * 24 * 60 * 60 * 1_000;
const MAX_PERSISTED_DEVELOPER_LOGS = 2_000;
const MAX_PERSISTED_DEVELOPER_LOG_BYTES = 8 * 1024 * 1024;

const defaultSettings = { capabilityBaseUrl: DEFAULT_CAPABILITY, modelGatewayBaseUrl: DEFAULT_GATEWAY, modelId: "", models: [], dataChannel: "qveris-cap", dataProvider: DEFAULT_DATA_PROVIDER };
const defaultState = {
  watchlist: [{ symbol: "600519", name: "贵州茅台", market: "沪深", category: "白酒" }, { symbol: "300750", name: "宁德时代", market: "深市", category: "新能源" }],
  monitorRules: [],
  notifications: [],
  portfolioPositions: [],
  portfolioReviews: [],
  monitorHistory: [],
};

let runtimeState = "stopped";
let userStateMutationQueue = Promise.resolve();
const devLogs = [];
let developerLogsLoaded = false;
let developerLogsLoadPromise = null;
let developerLogWriteQueue = Promise.resolve();
let developerLogWritesSinceCompaction = 0;
const devVariables = {
  toolCacheEnabled: true,
  requestTimeoutMs: 120_000,
  maxConcurrentDataRequests: DEFAULT_MAX_CONCURRENT_DATA_REQUESTS,
  logLevel: "info",
};

// CAP responses are real upstream data, so a short in-memory TTL avoids
// duplicate requests caused by a page refresh, monitor check, and quote detail
// panel opening at the same time without turning the UI into a fake-data cache.
const DIRECT_DATA_CACHE_TTL_MS = Object.freeze({
  quote: 15_000,
  details: 300_000,
  fundamentals: 300_000,
  series: 60_000,
  core_event: 300_000,
  capital_flow: 60_000,
  sentiment: 60_000,
  trading_calendar: 12 * 60 * 60_000,
});
const directDataCache = new Map();
const directDataInFlight = new Map();
let directDataCacheGeneration = 0;
// Directory metadata may be persisted for diagnostics, but authorization is
// scoped to this Host process. A previous session's Search result must never
// authorize a new billable dynamic-tool call.
const capabilityDirectorySession = randomUUID();

function abortReason(signal) {
  return signal?.reason || Object.assign(new Error("aborted"), { name: "AbortError", code: "ABORT_ERR" });
}

/**
 * Share one upstream CAP request without coupling cancellation to its first
 * caller. Each waiter can stop waiting independently; the upstream request
 * is cancelled only after every waiter has gone away.
 */
export function subscribeToSharedRequest(entry, signal) {
  entry.subscribers += 1;
  return new Promise((resolve, reject) => {
    let settled = false;
    const release = () => {
      if (settled) return;
      settled = true;
      entry.subscribers = Math.max(0, entry.subscribers - 1);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      release();
      if (!entry.settled && entry.subscribers === 0) entry.controller.abort(abortReason(signal));
      reject(abortReason(signal));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    entry.promise.then((value) => {
      if (settled) return;
      release();
      resolve(value);
    }, (error) => {
      if (settled) return;
      release();
      reject(error);
    });
  });
}

export function isAbortError(error) {
  return error?.name === "AbortError" || error?.code === "ABORT_ERR";
}

/**
 * Link a route/request lifetime to the controller used for an upstream call.
 * A browser tab can disappear after the request body has been sent; without
 * this link the Host would keep paying for a CAP/model request whose result can
 * no longer be delivered. The child controller remains independently
 * cancellable (for timeout or configuration changes).
 */
export function linkAbortSignal(parentSignal, controller) {
  if (!parentSignal || !controller) return () => {};
  const abort = () => {
    if (controller.signal.aborted) return;
    const reason = parentSignal.reason instanceof Error
      ? parentSignal.reason
      : Object.assign(new Error("请求已取消"), { name: "AbortError", code: "ABORT_ERR" });
    controller.abort(reason);
  };
  if (parentSignal.aborted) abort();
  else parentSignal.addEventListener("abort", abort, { once: true });
  return () => parentSignal.removeEventListener("abort", abort);
}

export function createAbortScope(parentSignal, timeoutMs) {
  const controller = new AbortController();
  const unlink = linkAbortSignal(parentSignal, controller);
  const timeout = Number(timeoutMs) > 0
    ? setTimeout(() => controller.abort(new Error("timeout")), Number(timeoutMs))
    : null;
  return {
    controller,
    signal: controller.signal,
    close() {
      if (timeout) clearTimeout(timeout);
      unlink();
    },
  };
}

function clientDisconnectedError() {
  return Object.assign(new Error("client disconnected"), { name: "AbortError", code: "CLIENT_DISCONNECTED" });
}

export function abortInFlightRequests(requests, reason = "aborted") {
  const error = reason instanceof Error ? reason : Object.assign(new Error(String(reason || "aborted")), { name: "AbortError", code: "ABORT_ERR" });
  if (!error.name) error.name = "AbortError";
  if (!error.code) error.code = "ABORT_ERR";
  for (const entry of requests.values()) {
    if (!entry?.settled && entry.controller && !entry.controller.signal.aborted) entry.controller.abort(error);
  }
  requests.clear();
}

export function cacheSharedResult(cache, key, normalized, { ttl = 0, cacheGeneration = 0, currentGeneration = 0, createdAt = Date.now() } = {}) {
  if (ttl > 0 && cacheGeneration === currentGeneration) cache.set(key, { createdAt, normalized: structuredClone(normalized) });
  return normalized;
}

export function allDataCacheHit(results) {
  return Array.isArray(results) && results.length > 0 && results.every((item) => item?.memoryCacheHit === true);
}

export function capabilityAuditOperation(result) {
  return result?.dataCacheHit === true ? "cached-call" : "cap-call";
}

/** Keep one prompt request associated with one AbortController at a time. */
export function createRuntimeGate() {
  let active = null;
  return {
    acquire(controller) {
      if (active) return false;
      active = controller;
      return true;
    },
    current() { return active; },
    release(controller) {
      if (active === controller) active = null;
    },
    abort(reason) { active?.abort(reason); },
  };
}

const runtimeGate = createRuntimeGate();

function redact(value, max = 800) {
  return String(value || "")
    .replace(/Bearer\s+[^\s,;"']+/gi, "Bearer [REDACTED]")
    .replace(/(api[_-]?key|token|secret|authorization)\s*[:=]\s*[^\s,;"']+/gi, (_match, key) => `${key}=[REDACTED]`)
    .replace(/([?&](?:api[_-]?key|token|secret)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/\b(?:sk|cap)_[A-Za-z0-9._-]+\b/g, "[REDACTED]")
    .slice(0, max);
}
function debugPayload(value, max = 3_000) {
  if (value == null) return "";
  try {
    const encoded = JSON.stringify(value);
    return redact(encoded, max);
  } catch { return redact(value).slice(0, max); }
}
function costCandidate(value, unitHint = "credits") {
  if (value == null || Array.isArray(value)) return null;
  if (typeof value === "number" || typeof value === "string") {
    const amount = Number(value);
    return Number.isFinite(amount) && amount >= 0 ? { amount, unit: unitHint } : null;
  }
  if (typeof value !== "object") return null;
  const rawAmount = value.amount ?? value.value ?? value.cost ?? value.credits ?? value.chargedCredits;
  const amount = Number(rawAmount);
  if (!Number.isFinite(amount) || amount < 0) return null;
  return { amount, unit: String(value.currency || value.unit || value.costUnit || value.cost_unit || unitHint) };
}

/**
 * Extract only explicit billing fields. Never treat arbitrary response fields
 * such as a transaction `amount` or a numeric series value as a charge.
 */
export function costFrom(value, depth = 0) {
  if (depth > 4 || !value || typeof value !== "object" || Array.isArray(value)) return null;
  const unitHint = String(value.currency || value.unit || value.costUnit || value.cost_unit || "credits");
  const keys = ["qveris_cost", "qverisCost", "cost", "charged_credits", "credits_used", "fee"];
  for (const key of keys) {
    const found = costCandidate(value[key], unitHint);
    if (found) return found;
  }
  for (const key of ["usage", "billing", "meta", "metadata", "result", "data"]) {
    const found = costFrom(value[key], depth + 1);
    if (found) return found;
  }
  return null;
}
export function costSummary(logs) {
  const summary = { qverisCalls: 0, qverisCost: 0, qverisCostKnown: 0, modelCalls: 0, modelCost: 0, modelCostKnown: 0, units: new Set(), qverisUnits: new Set(), modelUnits: new Set() };
  for (const entry of logs) {
    const isModel = entry.type === "model";
    // Direct CAP calls are the fast-path QVeris provider calls and must be
    // included alongside the older search/inspect/call audit events.
    const isQveris = entry.type === "qveris" || entry.type === "cap";
    // Cache reuse is visible in the log but is not an upstream provider call
    // and must not inflate the cost-call denominator.
    if (!entry.cacheHit && isModel) summary.modelCalls += 1;
    else if (!entry.cacheHit && isQveris) summary.qverisCalls += 1;
    if (entry.cacheHit === true) continue;
    const amount = Number(entry.cost?.amount);
    if (!Number.isFinite(amount)) continue;
    const unit = String(entry.cost.unit || "credits");
    summary.units.add(unit);
    if (isModel) { summary.modelCost += amount; summary.modelCostKnown += 1; summary.modelUnits.add(unit); } else if (isQveris) { summary.qverisCost += amount; summary.qverisCostKnown += 1; summary.qverisUnits.add(unit); }
  }
  return { ...summary, qverisCost: Number(summary.qverisCost.toFixed(8)), modelCost: Number(summary.modelCost.toFixed(8)), units: [...summary.units], qverisUnits: [...summary.qverisUnits], modelUnits: [...summary.modelUnits] };
}
function developerLogEntriesFromText(text) {
  const cutoff = Date.now() - DEVELOPER_LOG_RETENTION_MS;
  return String(text || "").split("\n").map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter((entry) => entry && typeof entry === "object" && typeof entry.id === "string" && Number.isFinite(Date.parse(entry.at)) && Date.parse(entry.at) >= cutoff).slice(-MAX_PERSISTED_DEVELOPER_LOGS);
}
async function writeDeveloperLogEntries(entries) {
  const bounded = (Array.isArray(entries) ? entries : []).slice(-MAX_PERSISTED_DEVELOPER_LOGS);
  const content = bounded.length ? `${bounded.map((entry) => JSON.stringify(entry)).join("\n")}\n` : "";
  await mkdir(dataDir, { recursive: true });
  const tempFile = `${developerLogFile}.${process.pid}.tmp`;
  await writeFile(tempFile, content, { encoding: "utf8", mode: 0o600 });
  await rename(tempFile, developerLogFile);
  await chmod(developerLogFile, 0o600).catch(() => {});
}
function enqueueDeveloperLogWrite(task) {
  developerLogWriteQueue = developerLogWriteQueue.then(task, task).catch(() => {});
  return developerLogWriteQueue;
}
function persistDeveloperLog(entry) {
  enqueueDeveloperLogWrite(async () => {
    await mkdir(dataDir, { recursive: true });
    await appendFile(developerLogFile, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(developerLogFile, 0o600).catch(() => {});
    developerLogWritesSinceCompaction += 1;
    if (developerLogWritesSinceCompaction < 100) return;
    developerLogWritesSinceCompaction = 0;
    const content = await readFile(developerLogFile, "utf8").catch(() => "");
    await writeDeveloperLogEntries(developerLogEntriesFromText(content));
  });
}
async function ensureDeveloperLogsLoaded() {
  if (developerLogsLoaded) {
    await developerLogWriteQueue;
    return;
  }
  if (!developerLogsLoadPromise) {
    developerLogsLoadPromise = (async () => {
      await developerLogWriteQueue;
      const content = await readFile(developerLogFile, "utf8").catch(() => "");
      const persisted = developerLogEntriesFromText(content);
      const known = new Set(devLogs.map((entry) => entry.id));
      devLogs.push(...persisted.filter((entry) => !known.has(entry.id)));
      devLogs.sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
      while (devLogs.length > 500) devLogs.shift();
      const bytes = Buffer.byteLength(content, "utf8");
      if (content && (bytes > MAX_PERSISTED_DEVELOPER_LOG_BYTES || persisted.length < content.split("\n").filter(Boolean).length)) {
        await enqueueDeveloperLogWrite(() => writeDeveloperLogEntries(persisted));
      }
      developerLogsLoaded = true;
    })().finally(() => { developerLogsLoadPromise = null; });
  }
  await developerLogsLoadPromise;
}
async function clearDeveloperLogs() {
  devLogs.length = 0;
  developerLogsLoaded = true;
  developerLogWritesSinceCompaction = 0;
  await enqueueDeveloperLogWrite(async () => {
    try { await unlink(developerLogFile); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  });
}
function logInvocation(event) {
  if (devVariables.logLevel === "silent") return;
  if (devVariables.logLevel === "error" && Number(event.status || 200) < 400) return;
  const entry = { id: randomUUID(), at: new Date().toISOString(), ...event, detail: event.detail ? redact(event.detail) : undefined, params: event.params ? debugPayload(event.params) : undefined, response: event.response ? debugPayload(event.response) : undefined, reason: event.reason ? redact(event.reason) : undefined };
  devLogs.push(entry);
  while (devLogs.length > 500) devLogs.shift();
  persistDeveloperLog(entry);
}
function safeSettings(settings) {
  return { capabilityBaseUrl: redact(settings?.capabilityBaseUrl || DEFAULT_CAPABILITY), modelGatewayBaseUrl: redact(settings?.modelGatewayBaseUrl || DEFAULT_GATEWAY), modelId: redact(settings?.modelId || ""), dataChannel: String(settings?.dataChannel || "qveris-cap"), dataProvider: String(settings?.dataProvider || DEFAULT_DATA_PROVIDER), modelCount: Array.isArray(settings?.models) ? settings.models.length : 0 };
}
export function validateEndpointUrl(value, label = "服务地址") {
  const raw = String(value ?? "");
  if (!raw || raw !== raw.trim()) throw new Error(`${label}无效：不能包含首尾空格`);
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error(`${label}无效`); }
  if (!(["http:", "https:"].includes(parsed.protocol)) || !parsed.hostname || parsed.username || parsed.password) {
    throw new Error(`${label}必须是不含凭据的 HTTP(S) 地址`);
  }
  if (parsed.search || parsed.hash) throw new Error(`${label}不能包含查询参数或片段`);
  const hostname = parsed.hostname.toLowerCase();
  const loopback = hostname === "localhost"
    || (isIP(hostname) === 4 && hostname.startsWith("127."))
    || hostname === "[::1]";
  if (parsed.protocol !== "https:" && !loopback) throw new Error(`${label}必须使用 HTTPS；仅允许回环地址使用 HTTP`);
  return parsed;
}

export function validateIntegrationSettings(value = {}) {
  const settings = { ...defaultSettings, ...(value && typeof value === "object" ? value : {}) };
  validateEndpointUrl(settings.capabilityBaseUrl, "数据能力地址");
  validateEndpointUrl(settings.modelGatewayBaseUrl, "模型网关地址");
  return settings;
}

function endpointInput(input, key, fallback, label) {
  const hasValue = Object.hasOwn(input || {}, key) && input[key] !== undefined && input[key] !== null && String(input[key]) !== "";
  const value = hasValue ? String(input[key]) : fallback;
  // Do not silently trim a user-supplied endpoint: a pasted space should be
  // visible as a configuration error, not turn into a different URL.
  validateEndpointUrl(value, label);
  return value.replace(/\/$/, "");
}

async function readSettings() { return validateIntegrationSettings(await readJson(settingsFile, defaultSettings)); }
async function readToolCache() { return await readJson(toolCacheFile, {}); }
async function writeToolCache(value) { await atomicJson(toolCacheFile, value); }
async function clearToolCache() { directDataCacheGeneration += 1; directDataCache.clear(); abortInFlightRequests(directDataInFlight, "configuration-changed"); try { await unlink(toolCacheFile); } catch { /* idempotent */ } }
function cacheKey(kind, settings) {
  return [kind, settings?.dataChannel || "qveris-cap", settings?.dataProvider || DEFAULT_DATA_PROVIDER, settings?.capabilityBaseUrl || DEFAULT_CAPABILITY, settings?.modelGatewayBaseUrl || DEFAULT_GATEWAY, settings?.modelId || ""].join("|");
}
async function reserveCacheWarmup(message, settings) {
  const kind = classifyRequest(message);
  if (!kind || !devVariables.toolCacheEnabled) return null;
  const key = cacheKey(kind, settings);
  return cacheWarmupGate.acquire(key, async () => {
    const cache = await readToolCache();
    const entry = cache[key];
    return Boolean(entry?.toolId && entry?.searchId);
  });
}
export function classifyRequest(message) {
  const text = String(message || "");
  if (/实时行情|行情快照|最新价|报价|quote/i.test(text)) return "quote";
  if (/公司简介|财务指标|基本面|fundamental/i.test(text)) return "details";
  if (/历史|分时|日线|周线|月线|季度|年线|series|trend/i.test(text)) return "series";
  if (/公告|财报|分红|除权|股东会|事件|event/i.test(text)) return "core_event";
  if (/资金流|主力资金|大单|净流入|capital.?flow/i.test(text)) return "capital_flow";
  if (/舆情|新闻|情绪|sentiment|news/i.test(text)) return "sentiment";
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
  return Object.entries(cache || {}).filter(([key]) => !key.startsWith("__")).map(([key, entry]) => ({ key, kind: entry.kind, toolId: entry.toolId, searchId: entry.searchId, provider: entry.provider, capability: entry.capability, createdAt: entry.createdAt, lastUsedAt: entry.lastUsedAt, hitCount: Number(entry.hitCount) || 0 }));
}

// qveris_finance is a CAP provider: the capability ID is stable while QVeris
// routes each request to the best underlying source.  Keep this small contract
// local so normal page loads do not pay the Search → Inspect round trip.
export const BUILTIN_CAPABILITY_CATALOG = Object.freeze({
  quote: { toolId: "qveris_finance.mkt_l1_rt", capability: "MKT.L1.RT", description: "实时或近实时 Level 1 行情快照", parameters: { symbol: "string" }, returns: ["price", "change", "change_percent", "timestamp", "volume", "open", "high", "low", "previous_close", "turnover_amount", "currency", "symbol"] },
  details: { toolId: "qveris_finance.ref_company_profile", capability: "REF.COMPANY_PROFILE", description: "上市公司基础概况与静态资料", parameters: { symbol: "string" }, returns: ["name", "exchange", "currency", "country", "industry", "description", "sector", "website", "employees", "market_cap", "symbol"] },
  fundamentals: { toolId: "qveris_finance.fundamentals_derived_ratios", capability: "FUNDAMENTALS.DERIVED_RATIOS", description: "估值与盈利指标快照", parameters: { symbol: "string" }, returns: ["symbol", "market_cap", "pe_ttm", "pb_ratio", "ps_ratio_ttm", "ev_to_ebitda", "peg_ratio", "dividend_yield", "as_of_date"] },
  series: { toolId: "qveris_finance.mkt_bars_eod", capability: "MKT.BARS.EOD", description: "历史日线 OHLCV 时间序列", parameters: { symbol: "string", start_date: "string", end_date: "string" }, returns: ["symbol", "date", "open", "high", "low", "close", "volume"] },
  core_event: { toolId: "qveris_finance.event_calendar_corp", capability: "EVENT.CALENDAR.CORP", description: "上市公司分红、拆股、股东会等已排期事件", parameters: { symbol: "string", event_type: "string?", start_date: "string?", end_date: "string?" }, returns: ["date", "event_type", "description", "ratio", "symbol"], coverage: "已验证 corporate calendar；不等同于公告全文或限售解禁日历" },
  capital_flow: { toolId: "qveris_finance.flow_large_order", capability: "FLOW.LARGE_ORDER", description: "按订单规模拆分的个股资金流", parameters: { symbol: "string", start_date: "string?", end_date: "string?" }, returns: ["symbol", "date", "super_large_net", "large_net", "medium_net", "small_net", "main_net", "net_flow"], coverage: "已验证个股大单资金流；空交易日保持缺失" },
  sentiment: { toolId: "qveris_finance.news_fin_tagged", capability: "NEWS.FIN.TAGGED", description: "带主题与情绪标签的财经新闻", parameters: { symbol: "string", start_date: "string?", end_date: "string?" }, returns: ["title", "url", "published_at", "source", "summary", "sentiment_label", "sentiment_score"], coverage: "已验证按标的新闻；市场范围过滤暂不透传，避免上游参数映射错误" },
  trading_calendar: { toolId: "cn_financial_pro.trade_dates.v1", provider: "cn_financial_pro", capability: "REF.EXCHANGE_CALENDAR", description: "按交易所查询真实交易日期，用于休市日门禁", parameters: { marketcode: "string", startdate: "string", enddate: "string" }, returns: ["time"], coverage: "已验证 SSE/SZSE/HKEX/CFFEX；只判断是否交易，不解释休市原因" },
});

/** Convert QVeris Search results into the stable shape consumed by the dev panel. */
export function normalizeDiscoveredCapability(item, { searchId = "", provider = DEFAULT_DATA_PROVIDER } = {}) {
  const params = Array.isArray(item?.params) ? item.params.slice(0, 64) : [];
  const sampleParameters = item?.examples?.sample_parameters && typeof item.examples.sample_parameters === "object" ? item.examples.sample_parameters : {};
  const boundedSample = (() => { try { return JSON.stringify(sampleParameters).length <= 8_000 ? sampleParameters : {}; } catch { return {}; } })();
  const parameters = Object.fromEntries(params
    .filter((param) => param && typeof param.name === "string" && param.name.trim())
    .map((param) => [String(param.name).trim(), `${String(param.type || "string").trim() || "string"}${param.required ? "" : "?"}`]));
  return {
    kind: `discovered:${String(item?.tool_id || item?.id || "unknown")}`,
    toolId: String(item?.tool_id || item?.id || ""),
    capability: String(item?.capability || item?.name || item?.tool_id || "未知能力"),
    description: String(item?.description || item?.provider_description || "QVeris 返回的金融能力").slice(0, 2_000),
    provider: String(item?.provider_name || provider),
    parameters,
    parameterDetails: params.map((param) => ({ name: String(param.name || ""), type: String(param.type || "string"), required: Boolean(param.required), description: String(param.description || ""), enum: Array.isArray(param.enum) ? param.enum.slice(0, 32) : undefined })).filter((param) => param.name),
    sampleParameters: boundedSample,
    expectedCost: item?.expected_cost || item?.billing_rule?.description || null,
    billingRule: item?.billing_rule || null,
    stats: item?.stats || null,
    searchId: String(searchId || ""),
    discoveredAt: new Date().toISOString(),
  };
}

const QVERIS_FINANCE_PROVIDER_SUMMARY = Object.freeze({
  capabilityCount: 141,
  domains: ["主数据", "实时行情与K线", "财务报表与估值", "新闻与事件", "资金流", "基金与ETF", "指数", "宏观/汇率/商品", "固定收益", "衍生品", "技术分析", "加密资产", "ESG与风险"],
});

function capabilityCatalog(settings) {
  return {
    version: CAPABILITY_CATALOG_VERSION,
    channel: String(settings?.dataChannel || "qveris-cap"),
    provider: String(settings?.dataProvider || DEFAULT_DATA_PROVIDER),
    providerSummary: QVERIS_FINANCE_PROVIDER_SUMMARY,
    updatedAt: new Date().toISOString(),
    tools: Object.entries(BUILTIN_CAPABILITY_CATALOG).map(([kind, item]) => ({ kind, ...item })),
  };
}

async function persistCapabilityCatalog(settings) {
  const cache = await readToolCache();
  const previous = cache.__catalog;
  const next = capabilityCatalog(settings);
  const comparable = (value) => JSON.stringify({ ...value, updatedAt: undefined, createdAt: undefined });
  if (previous && comparable(previous) === comparable(next)) return previous;
  // Preserve the first-seen timestamp while updating the contract metadata.
  cache.__catalog = { ...next, createdAt: previous?.createdAt || next.updatedAt };
  await writeToolCache(cache);
  return cache.__catalog;
}

function directCapabilityParameters(kind, input) {
  const symbol = String(input?.symbol || "").trim().toUpperCase();
  const end = new Date();
  const start = new Date(end);
  start.setDate(end.getDate() - (kind === "series" ? 90 : 30));
  const dates = { start_date: String(input?.start_date || start.toISOString().slice(0, 10)), end_date: String(input?.end_date || end.toISOString().slice(0, 10)) };
  if (kind === "trading_calendar") {
    const date = String(input?.date || input?.startdate || input?.start_date || end.toISOString().slice(0, 10));
    return { marketcode: String(input?.marketcode || "212001"), startdate: date, enddate: String(input?.enddate || input?.end_date || date), mode: 1, date_type: 0, period: "D", date_format: 0 };
  }
  if (["series", "core_event", "capital_flow", "sentiment"].includes(kind)) return { symbol, ...dates, ...(kind === "core_event" && input?.event_type ? { event_type: String(input.event_type) } : {}), ...(kind === "sentiment" && input?.query ? { query: String(input.query) } : {}) };
  return { symbol };
}

function directDataCacheKey(kind, settings, parameters) {
  return JSON.stringify({
    kind,
    channel: settings?.dataChannel || "qveris-cap",
    provider: settings?.dataProvider || DEFAULT_DATA_PROVIDER,
    capabilityBaseUrl: settings?.capabilityBaseUrl || DEFAULT_CAPABILITY,
    tool: BUILTIN_CAPABILITY_CATALOG[kind]?.toolId || kind,
    parameters,
  });
}

function capabilityData(result) {
  return result?.result?.data ?? result?.data ?? result?.result ?? result;
}

function latestDataTimestamp(points) {
  const values = points.map((point) => String(point?.date || point?.time || point?.timestamp || "")).filter(Boolean);
  const parsed = values
    .map((value) => ({ value, timestamp: Date.parse(value) }))
    .filter((item) => Number.isFinite(item.timestamp));
  if (parsed.length) return parsed.sort((left, right) => left.timestamp - right.timestamp).at(-1).value;
  return values.sort((left, right) => left.localeCompare(right)).at(-1) || null;
}

export function normalizeCapabilityResult(kind, input, result) {
  const data = capabilityData(result);
  const statusCode = Number(result?.result?.status_code ?? result?.status_code ?? 200);
  const hasPayload = Array.isArray(data) ? data.length > 0 : Boolean(data && typeof data === "object" ? Object.keys(data).length : data);
  if (hasPayload && (result?.success === false || (Number.isFinite(statusCode) && statusCode >= 400))) {
    throw new Error("金融数据渠道暂未返回可用结果");
  }
  const meta = result?.result?._meta || result?._meta || {};
  const source = meta.source_provider || meta.source_tool_id || DEFAULT_DATA_PROVIDER;
  if (kind === "quote") {
    const price = Number(data?.price);
    // Reject non-positive quotes at the Host boundary.  The UI also guards
    // this value, but allowing it into the shared cache would let an invalid
    // upstream response contaminate later consumers and derived signals.
    if (!data || typeof data !== "object" || Array.isArray(data) || !Number.isFinite(price) || price <= 0) throw new Error("CAP 未返回可识别的实时行情");
    return { quotes: [{ ...data, price, changePercent: data.change_percent, changeAmount: data.change, previousClose: data.previous_close, turnover: data.turnover_amount, asOf: data.timestamp, source }], source, capability: "MKT.L1.RT", asOf: data.timestamp || null };
  }
  if (kind === "details") {
    if (!data || typeof data !== "object" || Array.isArray(data) || !Object.keys(data).length) throw new Error("CAP 未返回公司资料");
    return { companyDescription: data.description || "", company: data, source, capability: "REF.COMPANY_PROFILE", asOf: null };
  }
  if (kind === "series") {
    const points = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [];
    return { series: points.map((point) => ({ ...point, time: point.time || point.date, value: point.value ?? point.close })).filter((point) => point.time || point.date), source, capability: "MKT.BARS.EOD", asOf: latestDataTimestamp(points) };
  }
  if (kind === "core_event") {
    const events = Array.isArray(data) ? data : Array.isArray(data?.events) ? data.events : Array.isArray(data?.data) ? data.data : [];
    const available = result?.success !== false && Number(result?.result?.status_code || 200) < 400;
    const normalized = events.filter((event) => event && typeof event === "object").map((event) => ({
      ...event,
      date: String(event.date || event.event_date || event.effective_date || ""),
      type: String(event.event_type || event.type || ""),
      title: String(event.description || event.title || event.name || ""),
    })).filter((event) => event.date || event.title);
    return { events: normalized, eventCount: available ? normalized.length : null, source, capability: "EVENT.CALENDAR.CORP", asOf: normalized.map((event) => event.date).filter(Boolean).sort().at(-1) || null, dataStatus: available ? "success" : "empty" };
  }
  if (kind === "capital_flow") {
    const rows = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : Array.isArray(data?.rows) ? data.rows : [];
    const normalized = rows.filter((row) => row && typeof row === "object").map((row) => ({ ...row, date: String(row.date || row.trade_date || ""), mainNetInflow: row.main_net ?? row.net_flow ?? row.mainNetInflow ?? null })).filter((row) => row.date || row.mainNetInflow != null);
    const latest = [...normalized].reverse().find((row) => Number.isFinite(Number(row.mainNetInflow))) || null;
    const available = result?.success !== false && Number(result?.result?.status_code || 200) < 400;
    return { capitalFlow: normalized, mainNetInflow: available ? latest?.mainNetInflow ?? null : null, source, capability: "FLOW.LARGE_ORDER", asOf: latest?.date || null, dataStatus: available && latest ? "success" : "empty" };
  }
  if (kind === "sentiment") {
    const items = Array.isArray(data) ? data : Array.isArray(data?.news) ? data.news : Array.isArray(data?.data) ? data.data : [];
    const news = items.filter((item) => item && typeof item === "object").map((item) => ({
      ...item,
      title: String(item.title || ""),
      url: String(item.url || ""),
      publishedAt: String(item.published_at || item.publishedAt || item.date || ""),
      sourceName: String(item.source || item.source_name || ""),
      sentiment: String(item.sentiment_label || item.sentiment || "").toLowerCase() || null,
      sentimentScore: Number.isFinite(Number(item.sentiment_score)) ? Number(item.sentiment_score) : null,
    })).filter((item) => item.title || item.publishedAt);
    const latest = [...news].sort((left, right) => String(right.publishedAt).localeCompare(String(left.publishedAt)))[0] || null;
    const available = result?.success !== false && Number(result?.result?.status_code || 200) < 400;
    return { news, sentiment: available ? latest?.sentiment ?? null : null, sentimentScore: available ? latest?.sentimentScore ?? null : null, source, capability: "NEWS.FIN.TAGGED", asOf: latest?.publishedAt || null, dataStatus: available && news.length ? "success" : "empty" };
  }
  if (kind === "fundamentals") {
    if (!data || typeof data !== "object" || Array.isArray(data) || !Object.keys(data).length) throw new Error("CAP 未返回估值指标");
    return { fundamentals: data, source, capability: "FUNDAMENTALS.DERIVED_RATIOS", asOf: data.as_of_date || null };
  }
  if (kind === "trading_calendar") {
    const values = Array.isArray(data) ? data : Array.isArray(data?.time) ? data.time : Array.isArray(data?.dates) ? data.dates : [];
    const tradingDates = values.map((value) => String(value || "").slice(0, 10)).filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value));
    const queriedDate = String(input?.date || input?.startdate || input?.start_date || "").slice(0, 10);
    return { tradingDates, queriedDate, isTradingDay: queriedDate ? tradingDates.includes(queriedDate) : null, marketcode: String(input?.marketcode || "212001"), source, capability: "REF.EXCHANGE_CALENDAR", asOf: queriedDate || tradingDates.at(-1) || null };
  }
  return data;
}

async function queryDirectCapability(input, settings, key, signal) {
  const kind = String(input?.kind || "").trim();
  const catalog = await persistCapabilityCatalog(settings);
  const kinds = kind === "details" ? ["details", "fundamentals"] : [kind];
  const selections = kinds.map((entryKind) => ({ kind: entryKind, selected: catalog.tools.find((tool) => tool.kind === entryKind) })).filter(({ selected }) => selected);
  if (!selections.length) { const error = new Error("没有对应的金融能力"); error.status = 404; error.code = "CAPABILITY_NOT_FOUND"; throw error; }
  const call = async ({ kind: callKind, selected }) => {
    const parameters = directCapabilityParameters(callKind, input);
    const cacheKeyValue = directDataCacheKey(callKind, settings, parameters);
    const ttl = DIRECT_DATA_CACHE_TTL_MS[callKind] || 0;
    const cacheGeneration = directDataCacheGeneration;
    const cached = directDataCache.get(cacheKeyValue);
    if (cached && ttl > 0 && Date.now() - cached.createdAt < ttl) {
      logInvocation({ type: "cap", operation: "cap-cache-hit", kind: callKind, toolId: selected.toolId, provider: catalog.provider, capability: selected.capability, status: 200, cacheHit: true, durationMs: 0, params: parameters, response: cached.normalized });
      return { selected, normalized: structuredClone(cached.normalized), memoryCacheHit: true };
    }
    const inFlight = directDataInFlight.get(cacheKeyValue);
    if (inFlight) {
      try {
        const normalized = await subscribeToSharedRequest(inFlight, signal);
        logInvocation({ type: "cap", operation: "cap-inflight-hit", kind: callKind, toolId: selected.toolId, provider: catalog.provider, capability: selected.capability, status: 200, cacheHit: true, durationMs: 0 });
        return { selected, normalized: structuredClone(normalized), memoryCacheHit: true };
      } catch (error) {
        throw error;
      }
    }
    const runId = `cap_${randomUUID()}`;
    const startedAt = Date.now();
    const url = `${endpoint(settings.capabilityBaseUrl || DEFAULT_CAPABILITY, "tools/execute")}?tool_id=${encodeURIComponent(selected.toolId)}`;
    let upstreamResult;
    const controller = new AbortController();
    const request = (async () => {
      upstreamResult = await upstreamWithRetry(url, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ parameters, session_id: runId, max_response_size: 20480, respond_with: "full" }) }, controller.signal, 1);
      const normalized = normalizeCapabilityResult(callKind, input, upstreamResult);
      // Cache ownership belongs to the shared request, not its first waiter.
      // If that waiter navigates away, another subscriber can still commit the
      // real result and prevent the next page refresh from paying upstream again.
      return cacheSharedResult(directDataCache, cacheKeyValue, normalized, { ttl, cacheGeneration, currentGeneration: directDataCacheGeneration });
    })();
    const entry = { promise: request, controller, subscribers: 0, settled: false };
    request.then(() => {
      entry.settled = true;
      if (directDataInFlight.get(cacheKeyValue) === entry) directDataInFlight.delete(cacheKeyValue);
    }, () => {
      entry.settled = true;
      if (directDataInFlight.get(cacheKeyValue) === entry) directDataInFlight.delete(cacheKeyValue);
    });
    directDataInFlight.set(cacheKeyValue, entry);
    try {
      const normalized = await subscribeToSharedRequest(entry, signal);
      logInvocation({ type: "cap", operation: "cap-call", method: "POST", path: url, kind: callKind, toolId: selected.toolId, provider: catalog.provider, capability: selected.capability, status: 200, cacheHit: false, durationMs: Date.now() - startedAt, params: parameters, response: normalized, cost: costFrom(upstreamResult) });
      return { selected, normalized, memoryCacheHit: false };
    } catch (error) {
      if (!isAbortError(error)) logInvocation({ type: "cap", operation: "cap-call", method: "POST", path: url, kind: callKind, toolId: selected.toolId, provider: catalog.provider, capability: selected.capability, status: Number(error.status) || 502, cacheHit: false, durationMs: Date.now() - startedAt, detail: error.message, reason: error.message, params: parameters });
      throw error;
    }
  };
  const settled = await Promise.allSettled(selections.map(call));
  const results = settled.filter((item) => item.status === "fulfilled").map((item) => item.value);
  if (!results.length) throw settled.find((item) => item.status === "rejected")?.reason || new Error("CAP 暂未返回数据");
  const primary = results[0];
  const dataCacheHit = allDataCacheHit(results);
  if (kind === "details") {
    const fundamentals = results.find((item) => item.selected.kind === "fundamentals")?.normalized;
    return { data: { ...primary.normalized, fundamentals: fundamentals?.fundamentals || {}, asOf: fundamentals?.asOf || null }, cacheHit: dataCacheHit, dataCacheHit, mode: "qveris-cap", toolId: primary.selected.toolId, capability: primary.selected.capability, provider: catalog.provider };
  }
  return { data: primary.normalized, cacheHit: dataCacheHit, dataCacheHit, mode: "qveris-cap", toolId: primary.selected.toolId, capability: primary.selected.capability, provider: catalog.provider };
}

// Multiple watchlist rows can start at the same time.  Keep only the first
// cache miss responsible for Search → Inspect → Call; the other requests wait
// for that warm-up and then let the model use foliomind_data directly.
export function createCacheWarmupGate() {
  const pending = new Map();
  return {
    async acquire(key, isReady) {
      while (true) {
        if (await isReady()) return null;
        const existing = pending.get(key);
        if (existing) {
          await existing;
          continue;
        }
        let resolve;
        const promise = new Promise((complete) => { resolve = complete; });
        pending.set(key, promise);
        return () => {
          if (pending.get(key) === promise) pending.delete(key);
          resolve();
        };
      }
    },
  };
}

const cacheWarmupGate = createCacheWarmupGate();

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; }
}
async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

function stateLockPath(path) { return join(dirname(path), STATE_LOCK_FILE_NAME); }

function stateLockBusyError() {
  const error = new Error("用户状态正在被其它 FolioMind 进程保存，请稍后重试");
  error.status = 409;
  error.code = "USER_STATE_BUSY";
  return error;
}

async function removeStaleStateLock(lockPath) {
  try {
    const metadata = await stat(lockPath);
    if (Date.now() - metadata.mtimeMs < STATE_FILE_LOCK_STALE_MS) return false;
    await unlink(lockPath);
    return true;
  } catch (error) {
    // A concurrent owner may have released or replaced the lock. Re-check on
    // the next loop rather than treating that race as a save failure.
    if (error?.code === "ENOENT") return true;
    return false;
  }
}

/**
 * Acquire the lock shared by the standalone Host and the native desktop Host.
 * The lock file is deliberately tiny and token-owned so a stale-owner cleanup
 * cannot remove a newer owner's lock during a release race.
 */
export async function acquireStateFileLock(path = stateFile, { timeoutMs = STATE_FILE_LOCK_TIMEOUT_MS, retryMs = STATE_FILE_LOCK_RETRY_MS } = {}) {
  const lockPath = stateLockPath(path);
  const token = `${process.pid}:${randomUUID()}`;
  const startedAt = Date.now();
  await mkdir(dirname(lockPath), { recursive: true });
  while (true) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(token, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        try {
          if ((await readFile(lockPath, "utf8")) === token) await unlink(lockPath);
        } catch {
          // The lock may have been recovered after a process crash. Never
          // allow cleanup races to turn a completed save into a failure.
        }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (await removeStaleStateLock(lockPath)) continue;
      if (Date.now() - startedAt >= timeoutMs) throw stateLockBusyError();
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  }
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
function saveUserStateIfRevision(input) {
  const task = userStateMutationQueue.catch(() => {}).then(async () => {
    const release = await acquireStateFileLock(stateFile);
    try {
      const current = normalizeUserState(await readJson(stateFile, defaultState));
      const expectedRevision = Number(input?.expectedRevision);
      const state = normalizeUserState(input?.state || defaultState);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || state.revision !== expectedRevision || current.revision !== expectedRevision) {
        const error = new Error(`用户数据已在其他窗口更新（当前版本 ${current.revision}）`);
        error.status = 409;
        error.code = "USER_STATE_CONFLICT";
        throw error;
      }
      if (!state.watchlist.length) throw new Error("至少保留一个自选标的");
      const next = { ...state, revision: expectedRevision + 1 };
      await atomicJson(stateFile, next);
      return next;
    } finally {
      await release();
    }
  });
  userStateMutationQueue = task.catch(() => {});
  return task;
}

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
    const upstreamError = body?.error && typeof body.error === "object" ? body.error : body;
    const upstreamCode = upstreamError?.code || upstreamError?.error_code || body?.code;
    if (upstreamCode) error.upstreamCode = String(upstreamCode);
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter.trim())) error.retryAfterMs = Math.min(30_000, Number(retryAfter) * 1_000);
    throw error;
  }
  return body;
}

/**
 * A cached tool should only be evicted when the provider explicitly says the
 * selection is no longer valid.  Transient 429/5xx/network failures must not
 * force every subsequent request through Search → Inspect again.
 */
export function shouldInvalidateToolCache(error) {
  const status = Number(error?.status);
  if ([404, 410].includes(status)) return true;
  const code = String(error?.code || error?.upstreamCode || "").toLowerCase();
  return /(tool|capability)[ _-]?(not[ _-]?found|invalid|expired|removed|unavailable)/.test(code);
}

/**
 * Only fall back to a solidified Search tool when the fixed CAP itself is
 * unavailable. Authentication, throttling, timeouts and upstream outages
 * should surface directly instead of paying for a second doomed request.
 */
export function shouldFallbackToCachedTool(error) {
  if (shouldInvalidateToolCache(error)) return true;
  const status = Number(error?.status);
  // An HTTP status proves the upstream understood the request. Only explicit
  // tool invalidation (handled above) is recoverable through Search; generic
  // client errors such as 400/422 usually mean the same parameters would fail
  // again and must not trigger another billable call.
  if (Number.isFinite(status)) return false;
  // Normalization/schema failures have no HTTP status and may be recoverable
  // through a previously verified tool selection.
  return true;
}
/**
 * Trading-calendar data is a safety gate for scheduling and must fail closed;
 * it must never guess from a cached tool or a weekday heuristic. Keep this
 * kind-aware wrapper shared by HTTP data queries and model tool calls so the
 * two entry points cannot drift into different fallback/cost behaviour.
 */
export function shouldFallbackForDataKind(kind, error) {
  return String(kind || "") !== "trading_calendar" && shouldFallbackToCachedTool(error);
}
export function isRetryableUpstreamStatus(status) {
  return [408, 425, 429, 500, 502, 503, 504].includes(Number(status));
}

export function isRetryableUpstreamError(error) {
  if (error?.name === "AbortError" || error?.code === "ABORT_ERR") return false;
  const status = Number(error?.status);
  return Number.isFinite(status) ? isRetryableUpstreamStatus(status) : true;
}

export function retryDelayMs(attempt, retryAfterMs = 0) {
  const serverDelay = Number.isFinite(Number(retryAfterMs)) ? Math.max(0, Number(retryAfterMs)) : 0;
  const exponentialDelay = 500 * (2 ** Math.max(0, Number(attempt) || 0));
  return Math.min(8_000, Math.max(serverDelay, exponentialDelay));
}

export async function upstreamWithRetry(url, options = {}, signal, attempts = 2) {
  for (let attempt = 0; ; attempt += 1) {
    if (signal?.aborted) throw signal.reason || new Error("aborted");
    try { return await upstream(url, options, signal); }
    catch (error) {
      if (signal?.aborted || !isRetryableUpstreamError(error) || attempt >= attempts) throw error;
      await new Promise((resolve, reject) => {
        if (signal?.aborted) { reject(signal.reason || new Error("aborted")); return; }
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
    { type: "function", function: { name: "foliomind_data", description: "FolioMind 内置金融数据工具。优先直接调用已验证的 QVeris Finance CAP；缓存不存在或失效时，再使用 qveris_search、qveris_inspect、qveris_call 建立固化工具。", parameters: { type: "object", properties: { kind: { type: "string", enum: ["quote", "details", "series", "core_event", "capital_flow", "sentiment"] }, symbol: { type: "string" }, range: { type: "string" }, start_date: { type: "string" }, end_date: { type: "string" }, event_type: { type: "string" }, query: { type: "string" } }, required: ["kind", "symbol"], additionalProperties: false } } },
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
    logInvocation({ type: "qveris", operation, method: "POST", path: url, status: Number(error.status) || 502, durationMs: Date.now() - startedAt, detail: error.message, reason: error.message, params: payload });
    throw error;
  }
  logInvocation({ type: "qveris", operation, method: "POST", path: url, status: 200, durationMs: Date.now() - startedAt, cacheHit: false, params: payload, response: result, cost: costFrom(result) });
  if (operation === "search") { const searchId = String(result.search_id || result.result?.search_id || ""); const ids = idsFromSearch(result); if (!searchId || !ids.size) throw new Error("Search 返回缺少 search_id 或候选工具"); phases.searches.set(searchId, ids); }
  if (operation === "inspect") for (const id of input.tool_ids) phases.inspected.add(`${input.search_id}:${id}`);
  return result;
}

async function discoverCapabilityDirectory(input, settings, key, signal) {
  const query = String(input?.query || `provider:${settings?.dataProvider || DEFAULT_DATA_PROVIDER}`).trim().slice(0, 160);
  if (!query) throw new Error("能力目录查询不能为空");
  const limit = Math.max(1, Math.min(CAPABILITY_DIRECTORY_LIMIT, Number(input?.limit) || CAPABILITY_DIRECTORY_LIMIT));
  const runId = `catalog_${randomUUID()}`;
  const url = endpoint(settings.capabilityBaseUrl || DEFAULT_CAPABILITY, "search");
  const startedAt = Date.now();
  let result;
  try {
    // Directory browsing is an explicit user action. Do not hold the panel for
    // a Retry-After window on a rate limit; the user can retry after the short
    // message and regular data requests keep their normal retry policy.
    result = await upstreamWithRetry(url, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ query, limit, session_id: runId, view: "full", lang: "zh" }) }, signal, 0);
  } catch (error) {
    logInvocation({ type: "qveris", operation: "capability-discover", method: "POST", path: url, status: Number(error.status) || 502, durationMs: Date.now() - startedAt, detail: error.message, reason: error.message, params: { query, limit } });
    throw error;
  }
  const searchId = String(result?.search_id || result?.result?.search_id || "");
  const rawResults = Array.isArray(result?.results) ? result.results : Array.isArray(result?.result?.results) ? result.result.results : [];
  const tools = rawResults.map((item) => normalizeDiscoveredCapability(item, { searchId, provider: settings?.dataProvider || DEFAULT_DATA_PROVIDER })).filter((item) => item.toolId);
  logInvocation({ type: "qveris", operation: "capability-discover", method: "POST", path: url, status: 200, durationMs: Date.now() - startedAt, params: { query, limit }, response: { searchId, total: result?.total ?? tools.length, tools: tools.map((tool) => ({ toolId: tool.toolId, capability: tool.capability, provider: tool.provider })) }, cost: costFrom(result) });
  if (!searchId && !tools.length) throw new Error("能力目录暂未返回可用结果");
  const directory = { query, searchId, total: Number(result?.total) || tools.length, tools, remainingCredits: result?.remaining_credits ?? null, updatedAt: new Date().toISOString(), sessionId: capabilityDirectorySession };
  const cache = await readToolCache();
  cache.__directory = directory;
  await writeToolCache(cache);
  return directory;
}

/**
 * Dynamic capability tests must be bound to the directory the user actually
 * discovered in this Host session. Accepting arbitrary tool/search IDs from
 * a browser would let a compromised local page spend the configured API key
 * on an unverified QVeris capability. The directory is intentionally
 * replaced on every discover operation, so stale cards must be refreshed.
 */
export function validateDiscoveredCapabilitySelection(directory, { toolId = "", searchId = "", sessionId = "" } = {}) {
  const normalizedToolId = String(toolId || "").trim();
  const normalizedSearchId = String(searchId || "").trim();
  const normalizedSessionId = String(sessionId || "").trim();
  const directorySearchId = String(directory?.searchId || "").trim();
  const directorySessionId = String(directory?.sessionId || "").trim();
  const verified = Array.isArray(directory?.tools)
    && directory.tools.some((tool) => String(tool?.toolId || "").trim() === normalizedToolId);
  if (!normalizedToolId || !normalizedSearchId || !directorySearchId || normalizedSearchId !== directorySearchId || !verified || (normalizedSessionId && directorySessionId !== normalizedSessionId)) {
    const error = new Error("该能力尚未由当前能力目录验证，请先刷新完整能力目录");
    error.status = 403;
    error.code = "CAPABILITY_NOT_VERIFIED";
    throw error;
  }
  return { toolId: normalizedToolId, searchId: normalizedSearchId };
}

async function testDiscoveredCapability(input, settings, key, signal) {
  const toolId = String(input?.toolId || "").trim();
  const searchId = String(input?.searchId || "").trim();
  const parameters = input?.parameters && typeof input.parameters === "object" && !Array.isArray(input.parameters) ? input.parameters : null;
  if (!toolId || !searchId || !parameters) throw new Error("能力测试需要 toolId、searchId 和 JSON 参数");
  const cache = await readToolCache();
  validateDiscoveredCapabilitySelection(cache.__directory, { toolId, searchId, sessionId: capabilityDirectorySession });
  const runId = `cap_test_${randomUUID()}`;
  const url = `${endpoint(settings.capabilityBaseUrl || DEFAULT_CAPABILITY, "tools/execute")}?tool_id=${encodeURIComponent(toolId)}`;
  const startedAt = Date.now();
  try {
    const result = await upstreamWithRetry(url, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ search_id: searchId, session_id: runId, parameters, max_response_size: 20480, respond_with: "full" }) }, signal);
    logInvocation({ type: "cap", operation: "capability-test", method: "POST", path: url, status: 200, durationMs: Date.now() - startedAt, params: { toolId, searchId, parameters }, response: result, cost: costFrom(result) });
    return { toolId, searchId, result, cost: costFrom(result), success: result?.success !== false };
  } catch (error) {
    logInvocation({ type: "cap", operation: "capability-test", method: "POST", path: url, status: Number(error.status) || 502, durationMs: Date.now() - startedAt, detail: error.message, reason: error.message, params: { toolId, searchId, parameters } });
    throw error;
  }
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
    provider: String(settings?.dataProvider || DEFAULT_DATA_PROVIDER),
    capability: previous.capability || null,
    parameters: input.parameters && typeof input.parameters === "object" ? input.parameters : {},
    createdAt: previous.createdAt || new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
    hitCount: Number(previous.hitCount) || 0,
  };
  await writeToolCache(cache);
}
async function queryCachedData(input, settings, key, signal) {
  const kind = String(input?.kind || "").trim();
  if (!devVariables.toolCacheEnabled || !["quote", "details", "series", "core_event", "capital_flow", "sentiment"].includes(kind)) {
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
    if (signal?.aborted) throw error;
    if (shouldInvalidateToolCache(error)) {
      delete cache[cacheKey(kind, settings)];
      await writeToolCache(cache);
      logInvocation({ type: "cache", operation: "evict", kind, toolId: entry.toolId, status: Number(error.status) || 502, detail: error.message });
    } else {
      logInvocation({ type: "cache", operation: "retain", kind, toolId: entry.toolId, status: Number(error.status) || 502, detail: error.message });
    }
    throw error;
  }
  entry.lastUsedAt = new Date().toISOString();
  entry.hitCount = (Number(entry.hitCount) || 0) + 1;
  cache[cacheKey(kind, settings)] = entry;
  await writeToolCache(cache);
  logInvocation({ type: "data", operation: "cached-call", kind, toolId: entry.toolId, cacheHit: true, durationMs: Date.now() - startedAt });
  return result;
}
async function runPromptAgent(message, settings, key, signal) {
  const model = settings.modelId || settings.models?.[0]?.id;
  if (!model) throw new Error("请先在设置中同步 QVeris 模型并选择模型");
  const runId = `product_${randomUUID()}`;
  const phases = { searches: new Map(), inspected: new Set() };
  const audits = [];
  const messages = [{ role: "system", content: "你是 FolioMind 金融研究 Agent。行情、公司资料、估值、历史序列、公司事件、资金流和标注新闻优先调用内置 foliomind_data（它直连 qveris_finance CAP，避免重复发现工具）；只有能力不可用时，才按 Search → Inspect → Call 顺序使用 QVeris 工具并让系统固化本次选择。回答要标明数据时间、来源和不确定性，绝不编造缺失数据。" }, { role: "user", content: message }];
  for (let round = 0; round < 8; round += 1) {
    const modelStartedAt = Date.now();
    let response;
    try {
      response = await upstreamWithRetry(endpoint(settings.modelGatewayBaseUrl, "chat/completions"), { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ model, messages, tools: toolDefinitions(), tool_choice: "auto", max_tokens: 4096 }) }, signal);
      logInvocation({ type: "model", operation: "chat-completions", method: "POST", path: endpoint(settings.modelGatewayBaseUrl, "chat/completions"), model, status: 200, durationMs: Date.now() - modelStartedAt, params: { model, messageCount: messages.length, toolChoice: "auto" }, response: { id: response.id, model: response.model, choices: response.choices?.map((choice) => ({ finish_reason: choice.finish_reason, hasContent: Boolean(choice.message?.content), toolCallCount: Array.isArray(choice.message?.tool_calls) ? choice.message.tool_calls.length : 0 })), usage: response.usage }, cost: costFrom(response) });
    } catch (error) {
      logInvocation({ type: "model", operation: "chat-completions", method: "POST", path: endpoint(settings.modelGatewayBaseUrl, "chat/completions"), model, status: Number(error.status) || 502, durationMs: Date.now() - modelStartedAt, detail: error.message, reason: error.message, params: { model, messageCount: messages.length, toolChoice: "auto" } });
      throw error;
    }
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
          const cachedResult = await queryDirectCapability(input, settings, key, signal);
          audits.push({ operation: capabilityAuditOperation(cachedResult), runId, toolCallId: call.id || randomUUID(), outcome: "success", detail: null, cacheHit: cachedResult?.dataCacheHit === true });
          messages.push({ role: "tool", tool_call_id: call.id, name, content: JSON.stringify(cachedResult) });
        } catch (error) {
          const toolCallId = call.id || randomUUID();
          if (signal?.aborted || !shouldFallbackForDataKind(input?.kind, error)) {
            audits.push({ operation: "cap-call", runId, toolCallId, outcome: "error", detail: "direct-capability-failed", cacheHit: false });
            throw error;
          }
          audits.push({ operation: "cap-call", runId, toolCallId, outcome: "error", detail: "direct-capability-unavailable", cacheHit: false });
          try {
            const cachedResult = await queryCachedData(input, settings, key, signal);
            messages.push({ role: "tool", tool_call_id: call.id, name, content: JSON.stringify(cachedResult) });
          } catch {
            audits.push({ operation: "cached-call", runId, toolCallId, outcome: "error", detail: "cache-miss" });
            messages.push({ role: "tool", tool_call_id: call.id, name, content: JSON.stringify({ error: "当前金融能力暂不可用", next_action: "请稍后重试；若持续失败，请打开开发者面板查看 CAP 调用日志。" }) });
          }
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

async function promptAgent(message, settings, key, signal) {
  const releaseWarmup = await reserveCacheWarmup(message, settings);
  try {
    return await runPromptAgent(message, settings, key, signal);
  } finally {
    releaseWarmup?.();
  }
}

async function route(req, body, requestSignal) {
  const method = req.method; const path = new URL(req.url, `http://${HOST}`).pathname;
  if (method === "GET" && path === "/api/health") return { ok: true, service: "foliomind-dev-host", mode: "standalone" };
  if (method === "GET" && path === "/api/session") return { token, service: "foliomind-dev-host", mode: "standalone" };
  requireSession(req);
  if (method === "GET" && path === "/api/integration/status") { const key = await readKey(); return { credentialConfigured: Boolean(key), keyPrefix: apiKeyPrefix(key), settings: await readSettings() }; }
  if (method === "POST" && path === "/api/integration/credential") { if (typeof body.apiKey !== "string" || body.apiKey.trim().length < 8) throw new Error("API Key 无效"); await saveKey(body.apiKey); await clearToolCache(); return { configured: true, keyPrefix: apiKeyPrefix(body.apiKey) }; }
  if (method === "DELETE" && path === "/api/integration/credential") { await deleteKey(); await clearToolCache(); return { configured: false, keyPrefix: "" }; }
  if (method === "POST" && path === "/api/integration/models/sync") {
    const input = body.input || {}; const key = await readKey(); if (!key) throw new Error("QVeris credential is not configured");
    const previous = await readSettings();
    const settings = validateIntegrationSettings({ ...previous, capabilityBaseUrl: endpointInput(input, "capabilityBaseUrl", previous.capabilityBaseUrl, "数据能力地址"), modelGatewayBaseUrl: endpointInput(input, "modelGatewayBaseUrl", previous.modelGatewayBaseUrl, "模型网关地址"), modelId: String(input.modelId || "").trim(), dataChannel: String(input.dataChannel || "qveris-cap"), dataProvider: String(input.dataProvider || DEFAULT_DATA_PROVIDER) });
    const scope = createAbortScope(requestSignal, devVariables.requestTimeoutMs);
    try {
      settings.models = normalizeModels((await upstream(endpoint(settings.modelGatewayBaseUrl, "models"), { headers: { authorization: `Bearer ${key}` } }, scope.signal)).data);
      settings.modelId = settings.models.some((item) => item.id === settings.modelId) ? settings.modelId : settings.models[0]?.id || "";
      await atomicJson(settingsFile, settings); await clearToolCache(); return settings;
    } finally { scope.close(); }
  }
  if (method === "POST" && path === "/api/integration/settings") { const input = body.input || {}; const previous = await readSettings(); const settings = validateIntegrationSettings({ ...previous, capabilityBaseUrl: endpointInput(input, "capabilityBaseUrl", previous.capabilityBaseUrl, "数据能力地址"), modelGatewayBaseUrl: endpointInput(input, "modelGatewayBaseUrl", previous.modelGatewayBaseUrl, "模型网关地址"), modelId: String(input.modelId || "").trim(), dataChannel: String(input.dataChannel || previous.dataChannel || "qveris-cap"), dataProvider: String(input.dataProvider || previous.dataProvider || DEFAULT_DATA_PROVIDER), models: Array.isArray(input.models) ? input.models : previous.models || [] }); await atomicJson(settingsFile, settings); await clearToolCache(); return settings; }
  if (method === "GET" && path === "/api/dev/overview") {
    await ensureDeveloperLogsLoaded();
    const settings = await readSettings(); const key = await readKey();
    const cache = await readToolCache();
    return { logs: devLogs.slice(-200), costSummary: costSummary(devLogs), state: { runtimeState, activeRequest: Boolean(runtimeGate.current()), pid: process.pid, credentialConfigured: Boolean(key), keyPrefix: apiKeyPrefix(key), settings: safeSettings(settings), toolCache: cacheSummary(cache), capabilityCatalog: cache.__catalog || capabilityCatalog(settings), capabilityDirectory: cache.__directory || null }, variables: { ...devVariables } };
  }
  if (method === "GET" && path === "/api/dev/capabilities") {
    const settings = await readSettings();
    return capabilityCatalog(settings);
  }
  if (method === "POST" && path === "/api/dev/capabilities/discover") {
    const key = await readKey(); if (!key) return { available: false, errorMessage: "请先在设置中配置 API Key" };
    const settings = await readSettings();
    const scope = createAbortScope(requestSignal, devVariables.requestTimeoutMs);
    try { return await discoverCapabilityDirectory(body.input || {}, settings, key, scope.signal); }
    catch (error) {
      if (requestSignal?.aborted) throw error;
      // Keep expected upstream throttling/service failures inside the Host
      // contract so the browser does not surface a noisy failed-resource error.
      return { available: false, query: String(body.input?.query || `provider:${settings?.dataProvider || DEFAULT_DATA_PROVIDER}`), errorMessage: Number(error?.status) === 429 ? "能力目录当前请求较多，请稍后重试" : "能力目录暂时无法加载，请稍后重试" };
    }
    finally { scope.close(); }
  }
  if (method === "POST" && path === "/api/dev/capabilities/test") {
    const key = await readKey(); if (!key) throw new Error("请先配置 QVeris API Key");
    const settings = await readSettings(); const input = body.input || {};
    if (input.toolId || input.searchId) {
      const scope = createAbortScope(requestSignal, devVariables.requestTimeoutMs);
      try { return await testDiscoveredCapability(input, settings, key, scope.signal); }
      finally { scope.close(); }
    }
    if (!BUILTIN_CAPABILITY_CATALOG[String(input.kind || "")] || (String(input.kind || "") !== "trading_calendar" && !String(input.symbol || "").trim())) throw new Error("能力测试需要有效的 kind 和查询参数");
    const scope = createAbortScope(requestSignal, devVariables.requestTimeoutMs);
    try { return await queryDirectCapability(input, settings, key, scope.signal); }
    finally { scope.close(); }
  }
  if (method === "DELETE" && path === "/api/dev/logs") { await clearDeveloperLogs(); return { cleared: true }; }
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
    const settings = await readSettings(); const input = body.input || {};
    const kind = String(input.kind || "");
    if (!["quote", "details", "series", "core_event", "capital_flow", "sentiment", "trading_calendar"].includes(kind) || (kind !== "trading_calendar" && !String(input.symbol || "").trim())) throw new Error("数据查询参数无效");
    const scope = createAbortScope(requestSignal, devVariables.requestTimeoutMs);
    try {
      const result = await queryDirectCapability(input, settings, key, scope.signal);
      return { ...result, audits: [{ operation: "cap-call", outcome: "success", toolId: result.toolId, capability: result.capability }] };
    } catch (directError) {
      if (scope.signal.aborted) throw directError;
      if (isAbortError(directError)) throw directError;
      if (!shouldFallbackForDataKind(kind, directError)) throw directError;
      logInvocation({ type: "data", operation: "cap-fallback", status: Number(directError.status) || 502, detail: directError.message });
      const result = await queryCachedData(input, settings, key, scope.signal);
      return { data: result?.result ?? result, cacheHit: true, mode: "standalone-dev-host", audits: [{ operation: "cached-call", outcome: "success", toolId: "cached" }] };
    }
    finally { scope.close(); }
  }
  if (method === "GET" && path === "/api/user-state") return normalizeUserState(await readJson(stateFile, defaultState));
  if (method === "POST" && path === "/api/user-state") {
    return saveUserStateIfRevision(body);
  }
  if (method === "GET" && path === "/api/runtime/status") return { state: runtimeState, pid: process.pid, detail: null };
  if (method === "POST" && path === "/api/runtime/start") { runtimeState = "running"; return { state: runtimeState, pid: process.pid, detail: null }; }
  if (method === "POST" && path === "/api/runtime/stop") { runtimeState = "stopped"; runtimeGate.abort(); return { state: runtimeState, pid: null, detail: null }; }
  if (method === "POST" && path === "/api/runtime/abort") { runtimeGate.abort(new Error("aborted")); return { success: true }; }
  if (method === "POST" && path === "/api/runtime/prompt") {
    if (typeof body.message !== "string" || !body.message.trim()) throw new Error("分析问题不能为空");
    const controller = new AbortController();
    if (!runtimeGate.acquire(controller)) {
      const error = new Error("当前已有一轮分析正在运行，请等待完成或先取消");
      error.status = 409;
      error.code = "RUNTIME_BUSY";
      throw error;
    }
    runtimeState = "running";
    const unlink = linkAbortSignal(requestSignal, controller);
    let timeout;
    try {
      const key = await readKey(); if (!key) throw new Error("请先配置 QVeris API Key");
      const settings = await readSettings();
      const timeoutMs = Math.max(5_000, Math.min(180_000, Number(body.timeoutMs) || devVariables.requestTimeoutMs));
      timeout = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
      return { ...(await promptAgent(body.message.trim(), settings, key, controller.signal)), mode: "standalone-dev-host" };
    }
    finally {
      if (timeout) clearTimeout(timeout);
      unlink();
      if (runtimeGate.current() === controller) {
        runtimeGate.release(controller);
        // A completed (or failed) request must release the runtime lock so the
        // next browser prompt can start without requiring a host restart.
        runtimeState = "stopped";
      }
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
    const requestController = new AbortController();
    let responseStarted = false;
    const abortForDisconnect = () => {
      if (!requestController.signal.aborted) requestController.abort(clientDisconnectedError());
    };
    req.once("aborted", abortForDisconnect);
    res.once("close", () => { if (!responseStarted) abortForDisconnect(); });
    try {
      const body = ["POST", "PUT", "PATCH"].includes(req.method) ? await bodyOf(req) : {};
      const result = await route(req, body, requestController.signal);
      if (requestController.signal.aborted) return;
      if (path !== "/api/dev/logs") logInvocation({ type: "http", method: req.method, path, status: 200, durationMs: Date.now() - startedAt });
      responseStarted = true;
      res.writeHead(200, jsonHeaders(origin)); res.end(JSON.stringify(result));
    } catch (error) {
      if (requestController.signal.aborted) {
        logInvocation({ type: "http", method: req.method, path, status: 499, durationMs: Date.now() - startedAt, detail: "客户端已断开，请求已取消", reason: "client-disconnected" });
        return;
      }
      const status = Number(error.status) || (String(error.message).includes("route") ? 404 : 400);
      logInvocation({ type: "http", method: req.method, path, status, durationMs: Date.now() - startedAt, detail: error.message });
      responseStarted = true;
      res.writeHead(status, jsonHeaders(origin)); res.end(JSON.stringify({ error: error.message || "本地 Host 请求失败", code: error.code || undefined }));
    } finally {
      req.removeListener("aborted", abortForDisconnect);
    }
  });
  server.on("error", (error) => {
    console.error(`[foliomind-dev-host] failed to listen on ${HOST}:${port}: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(port, HOST, () => {
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    if (process.argv[1]?.endsWith("local-host.mjs")) console.log(`[foliomind-dev-host] listening on http://${HOST}:${actualPort}`);
  });
  return server;
}

if (process.argv[1] && process.argv[1].endsWith("local-host.mjs")) {
  const server = startLocalHost();
  const close = () => server.close(() => process.exit(0));
  process.once("SIGINT", close); process.once("SIGTERM", close);
}
