import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { adaptParameters, BUILTIN_CAPABILITY_CATALOG, classifyRequest, createCacheWarmupGate, createRuntimeGate, DEFAULT_DATA_PROVIDER, DEFAULT_MAX_CONCURRENT_DATA_REQUESTS, isRetryableUpstreamError, isRetryableUpstreamStatus, normalizeCapabilityResult, retryDelayMs, shouldInvalidateToolCache, upstreamWithRetry } from "./local-host.mjs";

test("uses two concurrent data requests by default for local web refreshes", () => {
  assert.equal(DEFAULT_MAX_CONCURRENT_DATA_REQUESTS, 2);
});

test("keeps the qveris_finance CAP contract local and normalizes real envelopes", () => {
  assert.equal(DEFAULT_DATA_PROVIDER, "qveris_finance");
  assert.equal(BUILTIN_CAPABILITY_CATALOG.quote.toolId, "qveris_finance.mkt_l1_rt");
  const result = normalizeCapabilityResult("quote", { symbol: "600519.SH" }, { result: { data: { price: 1297.4, change: 5.1, change_percent: 0.39, timestamp: "2026-08-28T16:01:30", symbol: "600519.SH" }, _meta: { source_provider: "ths_ifind" } } });
  assert.equal(result.quotes[0].price, 1297.4);
  assert.equal(result.quotes[0].source, "ths_ifind");
  const series = normalizeCapabilityResult("series", { symbol: "600519.SH" }, { result: { data: [{ date: "2026-08-28", close: 1297.4 }] } });
  assert.deepEqual(series.series[0], { date: "2026-08-28", close: 1297.4, time: "2026-08-28", value: 1297.4 });
  const ascendingSeries = normalizeCapabilityResult("series", { symbol: "600519.SH" }, { result: { data: [{ date: "2026-08-26", close: 1290 }, { date: "2026-08-28", close: 1297.4 }] } });
  assert.equal(ascendingSeries.asOf, "2026-08-28");
});

test("normalizes verified event, capital-flow, and sentiment CAP envelopes", () => {
  assert.equal(BUILTIN_CAPABILITY_CATALOG.core_event.toolId, "qveris_finance.event_calendar_corp");
  assert.equal(BUILTIN_CAPABILITY_CATALOG.capital_flow.capability, "FLOW.LARGE_ORDER");
  assert.equal(BUILTIN_CAPABILITY_CATALOG.sentiment.capability, "NEWS.FIN.TAGGED");
  assert.equal(classifyRequest("贵州茅台未来一个月分红和股东会事件"), "core_event");
  assert.equal(classifyRequest("查询主力资金净流入和大单"), "capital_flow");
  assert.equal(classifyRequest("查询最近财经新闻舆情"), "sentiment");
  const events = normalizeCapabilityResult("core_event", { symbol: "600519.SH" }, { result: { data: [{ event_date: "2026-09-01", event_type: "dividend", description: "分红" }] }, _meta: { source_provider: "provider" } });
  assert.equal(events.eventCount, 1);
  assert.equal(events.events[0].title, "分红");
  const flow = normalizeCapabilityResult("capital_flow", { symbol: "600519.SH" }, { result: { data: [{ date: "2026-08-27", main_net: 100 }, { date: "2026-08-28", main_net: 200 }] }, _meta: { source_provider: "provider" } });
  assert.equal(flow.mainNetInflow, 200);
  const sentiment = normalizeCapabilityResult("sentiment", { symbol: "600519.SH" }, { result: { data: [{ title: "利好消息", published_at: "2026-08-28T10:00:00Z", sentiment_label: "positive", sentiment_score: 0.8 }] }, _meta: { source_provider: "provider" } });
  assert.equal(sentiment.sentiment, "positive");
  assert.equal(sentiment.sentimentScore, 0.8);
  const unavailable = normalizeCapabilityResult("core_event", { symbol: "600519.SH" }, { success: false, result: { data: [], status_code: 200 } });
  assert.equal(unavailable.eventCount, null);
  assert.equal(unavailable.dataStatus, "empty");
});

test("rejects explicit CAP failure envelopes instead of exposing partial fields", () => {
  assert.throws(
    () => normalizeCapabilityResult("quote", { symbol: "600519.SH" }, { success: false, result: { data: { price: 1 }, status_code: 200 } }),
    /金融数据渠道暂未返回可用结果/,
  );
  assert.throws(
    () => normalizeCapabilityResult("details", { symbol: "600519.SH" }, { result: { status_code: 503, data: { name: "贵州茅台" } } }),
    /金融数据渠道暂未返回可用结果/,
  );
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

test("evicts cached tools only for explicit invalidation responses", () => {
  assert.equal(shouldInvalidateToolCache(Object.assign(new Error("not found"), { status: 404 })), true);
  assert.equal(shouldInvalidateToolCache(Object.assign(new Error("gone"), { status: 410 })), true);
  assert.equal(shouldInvalidateToolCache(Object.assign(new Error("temporary"), { status: 429 })), false);
  assert.equal(shouldInvalidateToolCache(Object.assign(new Error("temporary"), { status: 503 })), false);
  assert.equal(shouldInvalidateToolCache({ status: 400, upstreamCode: "tool_not_found" }), true);
  assert.equal(shouldInvalidateToolCache({ status: 400, upstreamCode: "invalid_parameters" }), false);
});

test("serializes runtime prompts and releases only the owning request", () => {
  const gate = createRuntimeGate();
  const first = new AbortController();
  const second = new AbortController();
  assert.equal(gate.acquire(first), true);
  assert.equal(gate.acquire(second), false);
  assert.equal(gate.current(), first);
  gate.release(second);
  assert.equal(gate.current(), first);
  gate.release(first);
  assert.equal(gate.current(), null);
  assert.equal(gate.acquire(second), true);
  gate.abort(new Error("cancelled"));
  assert.equal(second.signal.aborted, true);
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
