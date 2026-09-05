import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function startHost(dataDir) {
  const child = spawn(process.execPath, ["scripts/local-host.mjs"], {
    cwd: projectRoot,
    env: { ...process.env, FOLIOMIND_HOST_PORT: "0", FOLIOMIND_DEV_DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const baseUrl = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Local Host 启动超时：${output}`)), 5_000);
    const inspect = (chunk) => {
      output += chunk.toString();
      const match = output.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    };
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`Local Host 提前退出（${code}）：${output}`)); });
  });
  const sessionResponse = await fetch(`${baseUrl}/api/session`);
  const { token } = await sessionResponse.json();
  return { child, baseUrl, token };
}

async function stopHost(child) {
  if (child.exitCode != null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timeout = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 2_000);
    child.once("exit", () => { clearTimeout(timeout); resolve(); });
  });
}

async function hostRequest(host, path, { method = "GET", body, authenticated = true } = {}) {
  const response = await fetch(`${host.baseUrl}${path}`, {
    method,
    headers: {
      ...(authenticated ? { "x-foliomind-host": host.token } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  return { response, payload };
}

test("Local Host enforces session auth and persists credential status and user state", async (context) => {
  const dataDir = await mkdtemp(join(tmpdir(), "foliomind-host-contract-"));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  let host = await startHost(dataDir);
  context.after(() => stopHost(host.child));

  const unauthenticated = await hostRequest(host, "/api/integration/status", { authenticated: false });
  assert.equal(unauthenticated.response.status, 401);
  assert.equal(unauthenticated.payload.error, "invalid local host session");

  const credential = await hostRequest(host, "/api/integration/credential", { method: "POST", body: { apiKey: "sk_contract_test_123456" } });
  assert.equal(credential.response.status, 200);
  assert.equal(credential.payload.configured, true);
  assert.equal(credential.payload.keyPrefix, "sk_contr…");
  assert.equal(typeof credential.payload.credentialRevision, "string");

  const insecureSettings = await hostRequest(host, "/api/integration/settings", { method: "POST", body: { input: { modelGatewayBaseUrl: "http://gateway.example.com/v1" } } });
  assert.equal(insecureSettings.response.status, 400);
  assert.match(insecureSettings.payload.error, /HTTPS/);
  const querySettings = await hostRequest(host, "/api/integration/settings", { method: "POST", body: { input: { capabilityBaseUrl: "https://api.example.com/v1?token=secret" } } });
  assert.equal(querySettings.response.status, 400);
  assert.match(querySettings.payload.error, /查询参数/);
  const whitespaceSettings = await hostRequest(host, "/api/integration/settings", { method: "POST", body: { input: { modelGatewayBaseUrl: " https://gateway.example.com/v1" } } });
  assert.equal(whitespaceSettings.response.status, 400);
  assert.match(whitespaceSettings.payload.error, /首尾空格/);

  const state = {
    revision: 0,
    watchlist: [{ symbol: "600519", name: "贵州茅台", market: "沪深", category: "白酒" }],
    monitorRules: [], notifications: [], portfolioPositions: [], portfolioReviews: [], monitorHistory: [],
    briefingSchedule: { enabled: true, closeTime: "15:40", timezone: "Asia/Shanghai", retryIntervalMinutes: 20 },
  };
  const saved = await hostRequest(host, "/api/user-state", { method: "POST", body: { state, expectedRevision: 0 } });
  assert.equal(saved.response.status, 200);
  assert.equal(saved.payload.revision, 1);
  assert.equal(saved.payload.briefingSchedule.closeTime, "15:40");
  const stale = await hostRequest(host, "/api/user-state", { method: "POST", body: { state, expectedRevision: 0 } });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.payload.code, "USER_STATE_CONFLICT");

  await stopHost(host.child);
  host = await startHost(dataDir);
  const status = await hostRequest(host, "/api/integration/status");
  assert.equal(status.payload.credentialConfigured, true);
  assert.equal(status.payload.keyPrefix, "sk_contr…");
  assert.equal(status.payload.credentialRevision, credential.payload.credentialRevision);
  assert.equal(Object.hasOwn(status.payload, "apiKey"), false);
  const restored = await hostRequest(host, "/api/user-state");
  assert.equal(restored.payload.watchlist[0].symbol, "600519");
  assert.equal(restored.payload.revision, 1);
  assert.equal(restored.payload.briefingSchedule.closeTime, "15:40");
  const restoredOverview = await hostRequest(host, "/api/dev/overview");
  assert.equal(restoredOverview.payload.logs.some((entry) => entry.path === "/api/integration/credential"), true);
  assert.equal(JSON.stringify(restoredOverview.payload.logs).includes("sk_contract_test_123456"), false);
  const cleared = await hostRequest(host, "/api/dev/logs", { method: "DELETE" });
  assert.equal(cleared.payload.cleared, true);
  const emptyOverview = await hostRequest(host, "/api/dev/overview");
  assert.equal(emptyOverview.payload.logs.length, 0);
});

test("two Local Hosts sharing a data directory serialize user-state CAS writes", async (context) => {
  const dataDir = await mkdtemp(join(tmpdir(), "foliomind-host-state-lock-"));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const first = await startHost(dataDir);
  const second = await startHost(dataDir);
  context.after(async () => {
    await stopHost(first.child);
    await stopHost(second.child);
  });
  const state = {
    revision: 0,
    watchlist: [{ symbol: "600519", name: "贵州茅台", market: "沪深", category: "白酒" }],
    monitorRules: [], notifications: [], portfolioPositions: [], portfolioReviews: [], monitorHistory: [],
  };
  const results = await Promise.all([
    hostRequest(first, "/api/user-state", { method: "POST", body: { state, expectedRevision: 0 } }),
    hostRequest(second, "/api/user-state", { method: "POST", body: { state, expectedRevision: 0 } }),
  ]);
  assert.deepEqual(results.map(({ response }) => response.status).sort((a, b) => a - b), [200, 409]);
  const winner = results.find(({ response }) => response.status === 200);
  assert.equal(winner.payload.revision, 1);
  const loser = results.find(({ response }) => response.status === 409);
  assert.equal(loser.payload.code, "USER_STATE_CONFLICT");
});

test("Local Host recovers user state from the last valid backup", async (context) => {
  const dataDir = await mkdtemp(join(tmpdir(), "foliomind-host-state-recovery-"));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const backup = {
    revision: 7,
    watchlist: [{ symbol: "600519", name: "贵州茅台", market: "沪深", category: "白酒" }],
    monitorRules: [], notifications: [], portfolioPositions: [], portfolioReviews: [], monitorHistory: [],
  };
  await writeFile(join(dataDir, "user-state.json"), "{broken", "utf8");
  await writeFile(join(dataDir, "user-state.json.backup"), JSON.stringify(backup), "utf8");
  const host = await startHost(dataDir);
  context.after(() => stopHost(host.child));

  const restored = await hostRequest(host, "/api/user-state");
  assert.equal(restored.response.status, 200);
  assert.equal(restored.payload.revision, 7);
  assert.equal(restored.payload.watchlist[0].symbol, "600519");
  assert.equal((await stat(join(dataDir, "user-state.json"))).isFile(), true);
  const restoredPrimary = JSON.parse(await readFile(join(dataDir, "user-state.json"), "utf8"));
  assert.equal(restoredPrimary.revision, 7);
});

test("Local Host reports a recoverable error when user state and backup are both corrupt", async (context) => {
  const dataDir = await mkdtemp(join(tmpdir(), "foliomind-host-state-corrupt-"));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  await writeFile(join(dataDir, "user-state.json"), "{broken", "utf8");
  await writeFile(join(dataDir, "user-state.json.backup"), "[]", "utf8");
  const host = await startHost(dataDir);
  context.after(() => stopHost(host.child));

  const response = await hostRequest(host, "/api/user-state");
  assert.equal(response.response.status, 400);
  assert.equal(response.payload.code, "USER_STATE_CORRUPTED");
  assert.match(response.payload.error, /导入备份/);
});

test("Local Host fails closed when the primary state is missing but its backup is corrupt", async (context) => {
  const dataDir = await mkdtemp(join(tmpdir(), "foliomind-host-state-missing-primary-"));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  await writeFile(join(dataDir, "user-state.json.backup"), "{broken", "utf8");
  const host = await startHost(dataDir);
  context.after(() => stopHost(host.child));

  const response = await hostRequest(host, "/api/user-state");
  assert.equal(response.response.status, 400);
  assert.equal(response.payload.code, "USER_STATE_CORRUPTED");
  assert.match(response.payload.error, /导入备份/);
});

test("Local Host serializes prompt requests, aborts the owner, and releases runtime state", async (context) => {
  let resolveRequest;
  const firstRequest = new Promise((resolve) => { resolveRequest = resolve; });
  const upstream = createServer((request, response) => {
    if (request.url !== "/chat/completions") { response.writeHead(404).end(); return; }
    assert.equal(request.headers.authorization, "Bearer sk_runtime_test_123456");
    resolveRequest();
    const timer = setTimeout(() => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "late result" }, finish_reason: "stop" }] }));
    }, 10_000);
    response.once("close", () => clearTimeout(timer));
  });
  const gateway = await listen(upstream);
  context.after(() => new Promise((resolve) => upstream.close(resolve)));
  const dataDir = await mkdtemp(join(tmpdir(), "foliomind-host-runtime-"));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const host = await startHost(dataDir);
  context.after(() => stopHost(host.child));

  await hostRequest(host, "/api/integration/credential", { method: "POST", body: { apiKey: "sk_runtime_test_123456" } });
  await hostRequest(host, "/api/integration/settings", { method: "POST", body: { input: { modelGatewayBaseUrl: gateway, modelId: "test-model", models: [{ id: "test-model" }] } } });

  const owner = hostRequest(host, "/api/runtime/prompt", { method: "POST", body: { message: "分析真实数据", timeoutMs: 30_000 } });
  await firstRequest;
  const concurrent = await hostRequest(host, "/api/runtime/prompt", { method: "POST", body: { message: "第二个请求" } });
  assert.equal(concurrent.response.status, 409);
  assert.equal(concurrent.payload.code, "RUNTIME_BUSY");

  const during = await hostRequest(host, "/api/dev/overview");
  assert.equal(during.payload.state.runtimeState, "running");
  assert.equal(during.payload.state.activeRequest, true);

  const aborted = await hostRequest(host, "/api/runtime/abort", { method: "POST", body: {} });
  assert.equal(aborted.response.status, 200);
  const ownerResult = await owner;
  assert.equal(ownerResult.response.status, 400);
  assert.match(ownerResult.payload.error, /aborted/);

  const after = await hostRequest(host, "/api/dev/overview");
  assert.equal(after.payload.state.runtimeState, "stopped");
  assert.equal(after.payload.state.activeRequest, false);
});

test("model connection probe omits finance tools and records model cost", async (context) => {
  let capturedBody;
  const upstream = createServer(async (request, response) => {
    if (request.url !== "/chat/completions") { response.writeHead(404).end(); return; }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    capturedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "probe-1", model: "test-model", choices: [{ message: { role: "assistant", content: "模型连接正常" }, finish_reason: "stop" }], usage: { total_tokens: 8 }, cost: { credits: 0.01 } }));
  });
  const gateway = await listen(upstream);
  context.after(() => new Promise((resolve) => upstream.close(resolve)));
  const dataDir = await mkdtemp(join(tmpdir(), "foliomind-host-model-probe-"));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const host = await startHost(dataDir);
  context.after(() => stopHost(host.child));
  await hostRequest(host, "/api/integration/credential", { method: "POST", body: { apiKey: "sk_model_probe_test_123456" } });
  const settings = await hostRequest(host, "/api/integration/settings", { method: "POST", body: { input: { modelGatewayBaseUrl: gateway, modelId: "test-model", models: [{ id: "test-model" }] } } });
  assert.equal(settings.response.status, 200);
  const result = await hostRequest(host, "/api/integration/model/test", { method: "POST" });
  assert.equal(result.response.status, 200);
  assert.equal(result.payload.text, "模型连接正常");
  assert.equal(capturedBody.tool_choice, "none");
  assert.equal(Object.hasOwn(capturedBody, "tools"), false);
  const overview = await hostRequest(host, "/api/dev/overview");
  const entry = overview.payload.logs.find((item) => item.operation === "connection-test");
  assert.equal(JSON.parse(entry.params).tools, false);
  assert.equal(entry.cost.amount, 0.01);
});

test("客户端断开时取消上游 CAP request", async (context) => {
  let upstreamStartedResolve;
  let upstreamClosedResolve;
  const upstreamStarted = new Promise((resolve) => { upstreamStartedResolve = resolve; });
  const upstreamClosed = new Promise((resolve) => { upstreamClosedResolve = resolve; });
  const upstream = createServer((request, response) => {
    if (new URL(request.url, "http://127.0.0.1").pathname !== "/tools/execute") { response.writeHead(404).end(); return; }
    upstreamStartedResolve();
    request.once("close", upstreamClosedResolve);
    // Keep the response open until the Host propagates the disconnect. This
    // proves the cancellation reaches the billable upstream request.
  });
  const capabilityBaseUrl = await listen(upstream);
  context.after(() => new Promise((resolve) => upstream.close(resolve)));
  const dataDir = await mkdtemp(join(tmpdir(), "foliomind-host-disconnect-"));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const host = await startHost(dataDir);
  context.after(() => stopHost(host.child));
  await hostRequest(host, "/api/integration/credential", { method: "POST", body: { apiKey: "sk_disconnect_test_123456" } });
  await hostRequest(host, "/api/integration/settings", { method: "POST", body: { input: { capabilityBaseUrl } } });

  const body = JSON.stringify({ input: { kind: "quote", symbol: "600519" } });
  const client = httpRequest(`${host.baseUrl}/api/data/query`, { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), "x-foliomind-host": host.token } });
  client.on("error", () => {}); // destroy() intentionally produces ECONNRESET on the client.
  client.end(body);
  await upstreamStarted;
  client.destroy();
  await Promise.race([upstreamClosed, new Promise((_, reject) => setTimeout(() => reject(new Error("上游请求未在期限内取消")), 3_000))]);

  const overview = await hostRequest(host, "/api/dev/overview");
  assert.equal(overview.payload.logs.some((entry) => entry.status === 499 && entry.reason === "client-disconnected"), true);
  assert.equal(overview.payload.state.activeRequest, false);
});

test("Local Host never caches trading-calendar gates", async (context) => {
  let calendarCalls = 0;
  const upstream = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname !== "/tools/execute") { response.writeHead(404).end(); return; }
    calendarCalls += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ success: true, result: { data: { time: ["2026-09-01"] } } }));
  });
  const capabilityBaseUrl = await listen(upstream);
  context.after(() => new Promise((resolve) => upstream.close(resolve)));
  const dataDir = await mkdtemp(join(tmpdir(), "foliomind-host-calendar-cache-"));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const host = await startHost(dataDir);
  context.after(() => stopHost(host.child));
  await hostRequest(host, "/api/integration/credential", { method: "POST", body: { apiKey: "sk_calendar_cache_test_123456" } });
  await hostRequest(host, "/api/integration/settings", { method: "POST", body: { input: { capabilityBaseUrl } } });

  const input = { kind: "trading_calendar", date: "2026-09-01", marketcode: "212001" };
  const first = await hostRequest(host, "/api/data/query", { method: "POST", body: { input } });
  const second = await hostRequest(host, "/api/data/query", { method: "POST", body: { input } });
  assert.equal(first.response.status, 200);
  assert.equal(second.response.status, 200);
  assert.equal(first.payload.data.isTradingDay, true);
  assert.equal(second.payload.data.isTradingDay, true);
  assert.equal(calendarCalls, 2);
  const overview = await hostRequest(host, "/api/dev/overview");
  assert.equal(overview.payload.logs.some((entry) => entry.operation === "cap-cache-hit" && entry.kind === "trading_calendar"), false);
});

test("动态 CAP 测试只允许当前目录已验证的工具", async (context) => {
  const calls = [];
  const upstream = createServer((request, response) => {
    const path = new URL(request.url, "http://127.0.0.1").pathname;
    calls.push(path);
    if (path === "/search") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ search_id: "search-current", total: 1, results: [{ tool_id: "qveris_finance.analytics_rsi", name: "RSI", params: [{ name: "symbol", type: "string", required: true }] }] }));
      return;
    }
    if (path === "/tools/execute") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ success: true, result: { value: 52.4 } }));
      return;
    }
    response.writeHead(404).end();
  });
  const capabilityBaseUrl = await listen(upstream);
  context.after(() => new Promise((resolve) => upstream.close(resolve)));
  const dataDir = await mkdtemp(join(tmpdir(), "foliomind-host-capability-test-"));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const host = await startHost(dataDir);
  context.after(() => stopHost(host.child));

  await hostRequest(host, "/api/integration/credential", { method: "POST", body: { apiKey: "sk_capability_test_123456" } });
  await hostRequest(host, "/api/integration/settings", { method: "POST", body: { input: { capabilityBaseUrl } } });

  const unverified = await hostRequest(host, "/api/dev/capabilities/test", { method: "POST", body: { input: { toolId: "qveris_finance.hidden_tool", searchId: "search-attacker", parameters: { symbol: "600519" } } } });
  assert.equal(unverified.response.status, 403);
  assert.equal(unverified.payload.code, "CAPABILITY_NOT_VERIFIED");
  assert.deepEqual(calls, []);

  const directory = await hostRequest(host, "/api/dev/capabilities/discover", { method: "POST", body: { input: { query: "provider:qveris_finance", limit: 10 } } });
  assert.equal(directory.response.status, 200);
  assert.equal(directory.payload.searchId, "search-current");
  assert.deepEqual(calls, ["/search"]);

  const stale = await hostRequest(host, "/api/dev/capabilities/test", { method: "POST", body: { input: { toolId: "qveris_finance.analytics_rsi", searchId: "search-old", parameters: { symbol: "600519" } } } });
  assert.equal(stale.response.status, 403);
  assert.equal(stale.payload.code, "CAPABILITY_NOT_VERIFIED");
  assert.deepEqual(calls, ["/search"]);

  const verified = await hostRequest(host, "/api/dev/capabilities/test", { method: "POST", body: { input: { toolId: "qveris_finance.analytics_rsi", searchId: "search-current", parameters: { symbol: "600519" } } } });
  assert.equal(verified.response.status, 200);
  assert.equal(verified.payload.result.result.value, 52.4);
  assert.deepEqual(calls, ["/search", "/tools/execute"]);

  // Directory metadata survives for inspection, but its authorization is
  // bound to the Host process that performed Search. Restarting the Host must
  // require a fresh discovery before another billable dynamic call.
  await stopHost(host.child);
  const restarted = await startHost(dataDir);
  context.after(() => stopHost(restarted.child));
  const overview = await hostRequest(restarted, "/api/dev/overview");
  assert.equal(overview.payload.state.capabilityDirectory.searchId, "search-current");
  const afterRestart = await hostRequest(restarted, "/api/dev/capabilities/test", { method: "POST", body: { input: { toolId: "qveris_finance.analytics_rsi", searchId: "search-current", parameters: { symbol: "600519" } } } });
  assert.equal(afterRestart.response.status, 403);
  assert.equal(afterRestart.payload.code, "CAPABILITY_NOT_VERIFIED");
  assert.deepEqual(calls, ["/search", "/tools/execute"]);
});

test("does not fall back to Search after an authentication failure", async (context) => {
  const calls = [];
  const upstream = createServer((request, response) => {
    calls.push(new URL(request.url, "http://127.0.0.1").pathname);
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: "invalid_api_key" } }));
  });
  const capabilityBaseUrl = await listen(upstream);
  context.after(() => new Promise((resolve) => upstream.close(resolve)));
  const dataDir = await mkdtemp(join(tmpdir(), "foliomind-host-fallback-"));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const host = await startHost(dataDir);
  context.after(() => stopHost(host.child));

  await hostRequest(host, "/api/integration/credential", { method: "POST", body: { apiKey: "sk_fallback_test_123456" } });
  await hostRequest(host, "/api/integration/settings", { method: "POST", body: { input: { capabilityBaseUrl, dataProvider: "qveris_finance", dataChannel: "qveris-cap" } } });
  const result = await hostRequest(host, "/api/data/query", { method: "POST", body: { input: { kind: "quote", symbol: "600519" } } });

  assert.equal(result.response.status, 401);
  assert.deepEqual(calls, ["/tools/execute"]);
  const overview = await hostRequest(host, "/api/dev/overview");
  assert.equal(overview.payload.logs.some((entry) => entry.operation === "cap-fallback"), false);
});

test("does not fall back from model data tools after an authentication failure", async (context) => {
  const calls = [];
  const upstream = createServer((request, response) => {
    const path = new URL(request.url, "http://127.0.0.1").pathname;
    calls.push(path);
    if (path === "/chat/completions") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { role: "assistant", tool_calls: [{ id: "call-1", type: "function", function: { name: "foliomind_data", arguments: JSON.stringify({ kind: "quote", symbol: "600519" }) } }] }, finish_reason: "tool_calls" }] }));
      return;
    }
    if (path === "/tools/execute") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "invalid_api_key" } }));
      return;
    }
    response.writeHead(404).end();
  });
  const gateway = await listen(upstream);
  context.after(() => new Promise((resolve) => upstream.close(resolve)));
  const dataDir = await mkdtemp(join(tmpdir(), "foliomind-host-prompt-fallback-"));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const host = await startHost(dataDir);
  context.after(() => stopHost(host.child));

  await hostRequest(host, "/api/integration/credential", { method: "POST", body: { apiKey: "sk_prompt_fallback_test_123456" } });
  await hostRequest(host, "/api/integration/settings", { method: "POST", body: { input: { capabilityBaseUrl: gateway, modelGatewayBaseUrl: gateway, modelId: "test-model", models: [{ id: "test-model" }] } } });
  const result = await hostRequest(host, "/api/runtime/prompt", { method: "POST", body: { message: "查询贵州茅台实时行情" } });

  assert.equal(result.response.status, 401);
  assert.deepEqual(calls, ["/chat/completions", "/tools/execute"]);
  const overview = await hostRequest(host, "/api/dev/overview");
  assert.equal(overview.payload.logs.some((entry) => entry.operation === "cap-fallback"), false);
});
