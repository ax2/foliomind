import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { adaptParameters, classifyRequest, createCacheWarmupGate, DEFAULT_MAX_CONCURRENT_DATA_REQUESTS, isRetryableUpstreamError, isRetryableUpstreamStatus, retryDelayMs, upstreamWithRetry } from "./local-host.mjs";

test("uses two concurrent data requests by default for local web refreshes", () => {
  assert.equal(DEFAULT_MAX_CONCURRENT_DATA_REQUESTS, 2);
});

test("coalesces concurrent cache warm-ups and lets waiters retry after a failed owner", async () => {
  const gate = createCacheWarmupGate();
  let ready = false;
  const releaseOwner = await gate.acquire("quote", async () => ready);
  let waiterFinished = false;
  const waiter = gate.acquire("quote", async () => ready).then((release) => {
    waiterFinished = true;
    return release;
  });
  await Promise.resolve();
  assert.equal(waiterFinished, false);
  // The first owner failed before writing a cache entry.  The waiter becomes
  // the new owner instead of remaining blocked forever.
  releaseOwner();
  await Promise.resolve();
  assert.equal(waiterFinished, false);
  ready = true;
  const releaseWaiter = await waiter;
  assert.equal(waiterFinished, true);
  assert.equal(typeof releaseWaiter, "function");
  releaseWaiter();
});

test("classifies finance requests for tool caching", () => {
  assert.equal(classifyRequest("查询贵州茅台 A股实时行情快照"), "quote");
  assert.equal(classifyRequest("查询公司简介和最近一期财务指标"), "details");
  assert.equal(classifyRequest("查询最近90个交易日日线"), "series");
  assert.equal(classifyRequest("解释这个行业"), null);
});

test("adapts a discovered call template without dropping provider parameters", () => {
  const template = { symbol: "600519.SH", market: "CN", period: "1d", nested: { source: "provider" } };
  const result = adaptParameters(template, "300750", "最近5个交易日日线");
  assert.deepEqual(result, { symbol: "300750", market: "CN", period: "最近5个交易日日线", nested: { source: "provider" } });
  assert.equal(template.symbol, "600519.SH");
});

test("uses bounded exponential backoff for transient upstream responses", () => {
  assert.equal(isRetryableUpstreamStatus(408), true);
  assert.equal(isRetryableUpstreamStatus(429), true);
  assert.equal(isRetryableUpstreamStatus(503), true);
  assert.equal(isRetryableUpstreamStatus(400), false);
  assert.equal(isRetryableUpstreamStatus(401), false);
  assert.equal(isRetryableUpstreamError(new TypeError("fetch failed")), true);
  assert.equal(isRetryableUpstreamError(Object.assign(new Error("unauthorized"), { status: 401 })), false);
  assert.equal(isRetryableUpstreamError(Object.assign(new Error("aborted"), { name: "AbortError" })), false);
  assert.equal(retryDelayMs(0), 500);
  assert.equal(retryDelayMs(1), 1_000);
  assert.equal(retryDelayMs(99), 8_000);
  assert.equal(retryDelayMs(0, 2_000), 2_000);
});

test("retries a transient network failure and does not retry an already-aborted request", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    if (attempts === 1) throw new TypeError("fetch failed");
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    await assert.doesNotReject(() => upstreamWithRetry("http://loopback.test/data", {}, undefined, 1));
    assert.equal(attempts, 2);
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const callsBeforeAbort = attempts;
    await assert.rejects(() => upstreamWithRetry("http://loopback.test/data", {}, controller.signal, 1));
    assert.equal(attempts, callsBeforeAbort);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("retries a transient data request before surfacing success", async () => {
  let attempts = 0;
  const server = createServer((_request, response) => {
    attempts += 1;
    if (attempts === 1) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "temporary" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    const result = await upstreamWithRetry(`http://127.0.0.1:${address.port}/data`, {}, undefined, 1);
    assert.deepEqual(result, { ok: true });
    assert.equal(attempts, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
