// Pi extension for the QVeris run-scoped executor.  The product host owns all
// long-lived credentials and exposes only a short-lived loopback capability.

const BRIDGE_VERSION = "foliomind-bridge.v1";
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_VISIBLE_CHARS = 256_000;
const runStates = new Map();

function textSchema(description) {
  return { type: "string", description };
}

function objectSchema(properties, required = []) {
  return { type: "object", properties, required, additionalProperties: false };
}

function fail(message) {
  throw new Error(message);
}

export function isLoopbackExecutorUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (url.username || url.password || !url.port) return false;
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

function executorEnvironment() {
  const url = String(process.env.QVERIS_EXECUTOR_URL || "").trim();
  const capability = String(process.env.QVERIS_MANAGED_CAPABILITY || "").trim();
  const runId = String(process.env.QVERIS_PI_RUN_ID || "").trim();
  if (!url || !capability || !runId) fail("QVeris 工具未获得有效的本轮授权。");
  if (!isLoopbackExecutorUrl(url)) fail("QVeris executor 必须是带端口的本机回环 URL。");
  return {
    url,
    capability,
    runId,
    productRunId: String(process.env.QVERIS_PRODUCT_RUN_ID || runId).trim() || runId,
  };
}

function timeoutMs() {
  const configured = Number.parseInt(process.env.QVERIS_EXECUTOR_TIMEOUT_MS || "", 10);
  return Number.isFinite(configured) && configured >= 100 && configured <= 60_000
    ? configured
    : DEFAULT_TIMEOUT_MS;
}

function redactedErrorText(value) {
  const source = String(value || "").trim();
  if (!source) return "上游未提供错误详情";
  let message = source;
  try {
    const payload = JSON.parse(source);
    message = String(payload?.error?.message || payload?.message || payload?.error || source);
  } catch {
    // Plain-text errors are still safe to display only after redaction.
  }
  return message
    .replace(/\bBearer\s+[^\s,;"']+/gi, "Bearer [REDACTED]")
    .replace(/\b(QVERIS_API_KEY|QVERIS_MANAGED_CAPABILITY|capability|token|api[_-]?key)\b\s*[:=]\s*[^\s,;"']+/gi, (_match, key) => `${key}: [REDACTED]`)
    .replace(/\b(?:sk|cap)_[A-Za-z0-9._-]+\b/g, "[REDACTED]")
    .replace(/https?:\/\/[^\s"']+/gi, "[REDACTED_URL]")
    .slice(0, 800);
}

function requestSignal(signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs());
  const abortFromCaller = () => controller.abort(signal?.reason || new Error("aborted"));
  if (signal) {
    if (signal.aborted) abortFromCaller();
    else signal.addEventListener("abort", abortFromCaller, { once: true });
  }
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortFromCaller);
    },
  };
}

function stateFor(runId) {
  if (!runStates.has(runId)) runStates.set(runId, { searches: new Map(), inspected: new Set() });
  return runStates.get(runId);
}

function extractSearchId(payload) {
  return String(payload?.result?.search_id || payload?.search_id || "").trim();
}

function extractToolIds(payload) {
  const candidates = payload?.result?.tools || payload?.result?.results || payload?.tools || payload?.results || [];
  return new Set((Array.isArray(candidates) ? candidates : [])
    .map((tool) => String(tool?.tool_id || tool?.id || "").trim())
    .filter(Boolean));
}

function enforcePhase(operation, input, runId) {
  const state = stateFor(runId);
  if (operation === "search") return;
  const searchId = String(input?.search_id || "").trim();
  if (!searchId || !state.searches.has(searchId)) {
    fail("必须先在本轮运行中成功执行 qveris_search，并传入其 search_id。");
  }
  if (operation === "inspect") {
    const ids = Array.isArray(input?.tool_ids) ? input.tool_ids : [];
    if (!ids.length || ids.some((id) => !state.searches.get(searchId).has(String(id)))) {
      fail("qveris_inspect 只能检查对应 Search 返回的 tool_id。");
    }
    return;
  }
  const toolId = String(input?.tool_id || "").trim();
  if (!state.searches.get(searchId).has(toolId) || !state.inspected.has(`${searchId}:${toolId}`)) {
    fail("必须先对该 Search 返回的 tool_id 成功执行 qveris_inspect，才能 qveris_call。");
  }
}

function recordPhase(operation, input, payload, runId) {
  const state = stateFor(runId);
  if (operation === "search") {
    const searchId = extractSearchId(payload);
    const ids = extractToolIds(payload);
    if (!searchId || !ids.size) fail("QVeris Search 返回缺少 search_id 或候选 tool_id。");
    state.searches.set(searchId, ids);
  } else if (operation === "inspect") {
    for (const id of input.tool_ids) state.inspected.add(`${input.search_id}:${id}`);
  }
}

function visibleExecutorResult(payload) {
  const visible = {
    result: payload?.result ?? null,
    data: payload?.data,
    mode: payload?.mode,
    tool_id: payload?.tool_id,
    capability: payload?.capability,
    audits: payload?.audits,
    data_status: payload?.data_status,
    reason_code: payload?.reason_code,
    missing_required_fields: payload?.missing_required_fields,
    cache_hit: payload?.cache_hit,
    qveris_cost: payload?.qveris_cost,
    remaining_credits: payload?.remaining_credits,
    evidence_complete: payload?.evidence_complete,
    next_action: payload?.next_action,
  };
  for (const key of Object.keys(visible)) if (visible[key] === undefined) delete visible[key];
  const encoded = JSON.stringify(visible);
  return encoded.length <= MAX_VISIBLE_CHARS
    ? encoded
    : JSON.stringify({ truncated: true, preview: encoded.slice(0, MAX_VISIBLE_CHARS), message: "结果过大；请缩小范围后重试。" });
}

const BUILTIN_DATA_KINDS = [
  "quote",
  "details",
  "series",
  "core_event",
  "capital_flow",
  "sentiment",
  "market_news",
  "index_levels",
  "commodity",
];

function executeFolioMindData(input, toolCallId, callerSignal) {
  const kind = String(input?.kind || "").trim();
  if (!BUILTIN_DATA_KINDS.includes(kind)) {
    fail("foliomind_data 的 kind 不受支持，请选择已验证的金融能力。");
  }
  const environment = executorEnvironment();
  const controlled = requestSignal(callerSignal);
  return (async () => {
    let response;
    try {
      response = await fetch(environment.url, {
        method: "POST",
        signal: controlled.signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${environment.capability}` },
        body: JSON.stringify({
          bridge_version: BRIDGE_VERSION,
          run_id: environment.runId,
          product_run_id: environment.productRunId,
          tool_call_id: toolCallId,
          operation: "data",
          input,
        }),
      });
    } catch (error) {
      const timedOut = controlled.signal.aborted && !callerSignal?.aborted;
      fail(timedOut ? "FolioMind 数据请求超时。" : "FolioMind 数据请求失败。");
    } finally {
      controlled.dispose();
    }
    const body = await response.text();
    if (!response.ok) fail(`FolioMind 数据请求失败（HTTP ${response.status}）：${redactedErrorText(body)}`);
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      fail("FolioMind 数据请求返回了无效 JSON。");
    }
    return {
      content: [{ type: "text", text: visibleExecutorResult(payload?.result ?? payload) }],
      details: {
        operation: "data",
        kind,
        traceId: String(payload?.trace_id || ""),
        cacheHit: payload?.cache_hit === true,
        qverisCost: Number(payload?.qveris_cost || payload?.result?.cost?.amount || 0),
      },
    };
  })();
}

async function executeQVeris(operation, input, toolCallId, callerSignal) {
  const environment = executorEnvironment();
  enforcePhase(operation, input, environment.runId);
  const controlled = requestSignal(callerSignal);
  let response;
  try {
    response = await fetch(environment.url, {
      method: "POST",
      signal: controlled.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${environment.capability}` },
      body: JSON.stringify({
        bridge_version: BRIDGE_VERSION,
        run_id: environment.runId,
        product_run_id: environment.productRunId,
        tool_call_id: toolCallId,
        operation,
        input,
      }),
    });
  } catch (error) {
    const timedOut = controlled.signal.aborted && !callerSignal?.aborted;
    fail(timedOut ? `QVeris ${operation} 请求超时。` : `QVeris ${operation} 请求失败。`);
  } finally {
    controlled.dispose();
  }
  const body = await response.text();
  if (!response.ok) fail(`QVeris ${operation} 失败（HTTP ${response.status}）：${redactedErrorText(body)}`);
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    fail(`QVeris ${operation} 返回了无效 JSON。`);
  }
  recordPhase(operation, input, payload, environment.runId);
  return {
    content: [{ type: "text", text: visibleExecutorResult(payload) }],
    details: {
      operation,
      traceId: String(payload?.trace_id || ""),
      cacheHit: payload?.cache_hit === true,
      qverisCost: Number(payload?.qveris_cost || 0),
    },
  };
}

export default function qverisExtension(pi) {
  pi.registerCommand?.("qveris-status", {
    description: "检查 QVeris 受管桥接是否已加载。",
    handler: async (_args, context) => context.ui.notify("QVeris managed bridge is ready", "info"),
  });
  pi.registerTool({
    name: "qveris_search",
    label: "QVeris Search",
    description: "搜索 QVeris 数据能力。外部、实时或专业数据先搜索，随后必须 Inspect。",
    parameters: objectSchema({ query: textSchema("描述数据能力、标的、市场和时间范围。"), limit: { type: "integer", minimum: 1, maximum: 20 } }, ["query"]),
    executionMode: "sequential",
    execute(toolCallId, params, signal) { return executeQVeris("search", params, toolCallId, signal); },
  });
  pi.registerTool({
    name: "qveris_inspect",
    label: "QVeris Inspect",
    description: "检查 Search 返回的候选工具参数；Call 前必需。",
    parameters: objectSchema({ tool_ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 5, uniqueItems: true }, search_id: textSchema("Search 返回的 search_id。") }, ["tool_ids", "search_id"]),
    executionMode: "sequential",
    execute(toolCallId, params, signal) { return executeQVeris("inspect", params, toolCallId, signal); },
  });
  pi.registerTool({
    name: "qveris_call",
    label: "QVeris Call",
    description: "调用已 Search 且 Inspect 的 QVeris 工具；参数必须匹配 Inspect schema。",
    parameters: objectSchema({ tool_id: textSchema("已经 Inspect 的 tool_id。"), parameters: { type: "object", additionalProperties: true }, search_id: textSchema("对应 Search 的 search_id。") }, ["tool_id", "parameters", "search_id"]),
    executionMode: "sequential",
    execute(toolCallId, params, signal) { return executeQVeris("call", params, toolCallId, signal); },
  });
  pi.registerTool({
    name: "foliomind_data",
    label: "FolioMind Data",
    description: "直接调用 FolioMind 已验证的稳定金融数据 CAP；无需 Search/Inspect。返回真实数据、来源和时间，缺失时保持空态，不得推测。",
    parameters: objectSchema({
      kind: { type: "string", enum: BUILTIN_DATA_KINDS },
      symbol: textSchema("个股或指数代码；市场新闻和商品查询可省略。"),
      range: textSchema("历史序列时间范围，例如日K或周K。"),
      start_date: textSchema("开始日期（YYYY-MM-DD）。"),
      end_date: textSchema("结束日期（YYYY-MM-DD）。"),
      event_type: textSchema("公司事件类型。"),
      query: textSchema("市场新闻或指数查询关键词。"),
      category: textSchema("新闻类别。"),
      market: textSchema("市场代码，例如 US。"),
      interval: textSchema("数据间隔，例如 tick。"),
      commodity_name: textSchema("商品名称，例如 WTI 或 Gold。"),
      frequency: textSchema("商品数据频率。"),
      limit: { type: "integer", minimum: 1, maximum: 20 },
    }, ["kind"]),
    executionMode: "sequential",
    execute(toolCallId, params, signal) { return executeFolioMindData(params, toolCallId, signal); },
  });
}
