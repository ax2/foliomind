import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
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
  assert.equal(Object.hasOwn(status.payload, "apiKey"), false);
  const restored = await hostRequest(host, "/api/user-state");
  assert.equal(restored.payload.watchlist[0].symbol, "600519");
  assert.equal(restored.payload.revision, 1);
  assert.equal(restored.payload.briefingSchedule.closeTime, "15:40");
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
