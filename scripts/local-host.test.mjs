import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { abortInFlightRequests, acquireStateFileLock, adaptParameters, allDataCacheHit, atomicJson, BUILTIN_CAPABILITY_CATALOG, cacheSharedResult, capabilityAuditOperation, classifyRequest, costFrom, costSummary, createAbortScope, createCacheWarmupGate, createRuntimeGate, dateStringInTimeZone, debugPayload, DEFAULT_DATA_PROVIDER, DEFAULT_MAX_CONCURRENT_DATA_REQUESTS, directCapabilityParameters, MAX_DIRECT_DATA_CACHE_ENTRIES, isAbortError, isRetryableUpstreamError, isRetryableUpstreamStatus, linkAbortSignal, normalizeCapabilityResult, normalizeDiscoveredCapability, retryDelayMs, shouldFallbackForDataKind, shouldFallbackToCachedTool, shouldInvalidateToolCache, STATE_FILE_LOCK_STALE_MS, subscribeToSharedRequest, upstreamWithRetry, validateDiscoveredCapabilitySelection, validateEndpointUrl, validateIntegrationSettings } from "./local-host.mjs";

test("uses two concurrent data requests by default for local web refreshes", () => {
  assert.equal(DEFAULT_MAX_CONCURRENT_DATA_REQUESTS, 2);
});

test("uses the Shanghai local calendar date for CAP defaults across UTC boundaries", () => {
  assert.equal(dateStringInTimeZone(new Date("2026-09-03T16:30:00.000Z")), "2026-09-04");
  assert.equal(dateStringInTimeZone(new Date("2026-09-03T15:59:59.000Z")), "2026-09-03");
  const parameters = directCapabilityParameters("market_news", { query: "利率" }, new Date("2026-09-03T16:30:00.000Z"));
  assert.deepEqual(parameters, { query: "利率", start_date: "2026-08-05", end_date: "2026-09-04", limit: 10 });
  const calendar = directCapabilityParameters("trading_calendar", {}, new Date("2026-09-03T16:30:00.000Z"));
  assert.equal(calendar.startdate, "2026-09-04");
  assert.equal(calendar.enddate, "2026-09-04");
});

test("atomic JSON writes protect private local metadata on POSIX", async (context) => {
  const dataDir = await mkdtemp(join(tmpdir(), "foliomind-private-file-"));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const file = join(dataDir, "user-state.json");
  await atomicJson(file, { portfolio: "private" });
  if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test("uses a token-owned cross-process user-state lock and recovers stale owners", async (context) => {
  const dataDir = await mkdtemp(join(tmpdir(), "foliomind-state-lock-"));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const stateFile = join(dataDir, "user-state.json");
  const release = await acquireStateFileLock(stateFile);
  await assert.rejects(
    acquireStateFileLock(stateFile, { timeoutMs: 40, retryMs: 5 }),
    (error) => error?.code === "USER_STATE_BUSY" && error?.status === 409,
  );
  const lockPath = join(dataDir, ".user-state.json.lock");
  await writeFile(lockPath, "new-owner", "utf8");
  await release();
  assert.equal(await readFile(lockPath, "utf8"), "new-owner");
  await unlink(lockPath);
  await writeFile(lockPath, "crashed-owner", "utf8");
  const staleAt = new Date(Date.now() - STATE_FILE_LOCK_STALE_MS - 1_000);
  await utimes(lockPath, staleAt, staleAt);
  const recoveredRelease = await acquireStateFileLock(stateFile, { timeoutMs: 100, retryMs: 5 });
  await recoveredRelease();
});

test("keeps Local Host endpoint validation aligned with the desktop security boundary", () => {
  for (const value of ["https://api.example.com/v1", "http://localhost:43123", "http://127.0.0.1:43123", "http://127.12.0.9:43123", "http://[::1]:43123"]) {
    assert.doesNotThrow(() => validateEndpointUrl(value));
  }
  for (const value of ["http://api.example.com/v1", "http://169.254.1.1/v1", "ftp://api.example.com/v1", "https://user:pass@api.example.com/v1", "https://api.example.com/v1?token=secret", " https://api.example.com/v1 "]) {
    assert.throws(() => validateEndpointUrl(value));
  }
  assert.doesNotThrow(() => validateIntegrationSettings({ capabilityBaseUrl: "https://api.example.com/v1", modelGatewayBaseUrl: "https://gateway.example.com/v1" }));
  assert.throws(() => validateIntegrationSettings({ capabilityBaseUrl: "http://api.example.com/v1" }));
});

test("extracts provider and model gateway costs without inventing missing charges", () => {
  assert.deepEqual(costFrom({ qveris_cost: 0.012, currency: "credits" }), { amount: 0.012, unit: "credits" });
  assert.deepEqual(costFrom({ usage: { cost: { amount: "0.4", unit: "USD" } } }), { amount: 0.4, unit: "USD" });
  assert.equal(costFrom({ usage: { prompt_tokens: 10 } }), null);
  assert.equal(costFrom({ data: { amount: 999, price: 12.3 } }), null);
  assert.equal(costFrom({ data: [12.3, 11.8] }), null);
  assert.deepEqual(costFrom({ result: { cost: { value: "0.2", cost_unit: "credits" } } }), { amount: 0.2, unit: "credits" });
  assert.deepEqual(costSummary([{ type: "qveris", cost: { amount: 0.1, unit: "credits" } }, { type: "cap", cost: { amount: 0.05, unit: "credits" } }, { type: "model", cost: { amount: 0.2, unit: "usd" } }, { type: "model" }]), { qverisCalls: 2, qverisCost: 0.15, qverisCostKnown: 2, modelCalls: 2, modelCost: 0.2, modelCostKnown: 1, units: ["credits", "usd"], qverisUnits: ["credits"], modelUnits: ["usd"] });
  assert.deepEqual(costSummary([{ type: "cap", cacheHit: true }, { type: "cap", cacheHit: false, cost: { amount: 0.1, unit: "credits" } }]), { qverisCalls: 1, qverisCost: 0.1, qverisCostKnown: 1, modelCalls: 0, modelCost: 0, modelCostKnown: 0, units: ["credits"], qverisUnits: ["credits"], modelUnits: [] });
});

test("redacts nested credentials from developer payloads", () => {
  const payload = debugPayload({
    apiKey: "sk_live_should-not-appear",
    nested: { access_token: "access-secret", clientSecret: "client-secret", safe: "600519" },
    list: [{ authorization: "Bearer hidden" }, { token: "token-secret" }],
    note: 'Bearer sk_text_secret and {"password":"inline-secret"}',
  });
  assert.equal(payload.includes("sk_live_should-not-appear"), false);
  assert.equal(payload.includes("access-secret"), false);
  assert.equal(payload.includes("client-secret"), false);
  assert.equal(payload.includes("token-secret"), false);
  assert.equal(payload.includes("inline-secret"), false);
  assert.match(payload, /\[REDACTED\]/);
  assert.match(payload, /600519/);

  const circular = { safe: "kept" };
  circular.self = circular;
  assert.doesNotThrow(() => debugPayload(circular));
  assert.match(debugPayload(circular), /\[CIRCULAR\]/);
  assert.equal(debugPayload({ values: Array.from({ length: 101 }, (_, index) => index) }).includes("100"), false);
});

test("keeps the qveris_finance CAP contract local and normalizes nested quote envelopes", () => {
  assert.equal(DEFAULT_DATA_PROVIDER, "qveris_finance");
  assert.equal(BUILTIN_CAPABILITY_CATALOG.quote.toolId, "qveris_finance.mkt_l1_rt");
  const result = normalizeCapabilityResult("quote", { symbol: "600519.SH" }, { result: { data: { price: 1297.4, change: 5.1, change_percent: 0.39, timestamp: "2026-08-28T16:01:30", symbol: "600519.SH" }, _meta: { source_provider: "ths_ifind" } } });
  assert.equal(result.quotes[0].price, 1297.4);
  assert.equal(result.quotes[0].source, "ths_ifind");
  const nestedQuote = normalizeCapabilityResult("quote", { symbol: "600519.SH" }, { result: { data: { payload: { quotes: [{ last_price: "1298.6", change_percent: 0.21, timestamp: "2026-08-28T16:01:31", symbol: "600519.SH" }] } } } });
  assert.equal(nestedQuote.quotes[0].price, 1298.6);
  assert.equal(nestedQuote.quotes[0].changePercent, 0.21);
  const directArrayQuote = normalizeCapabilityResult("quote", { symbol: "600519.SH" }, { data: [{ quote: { lastPrice: 1299.2, changeAmount: 1.8, asOf: "2026-08-28T16:01:32" } }] });
  assert.equal(directArrayQuote.quotes[0].price, 1299.2);
  assert.equal(directArrayQuote.quotes[0].changeAmount, 1.8);
  const series = normalizeCapabilityResult("series", { symbol: "600519.SH" }, { result: { data: [{ date: "2026-08-28", close: 1297.4 }] } });
  assert.deepEqual(series.series[0], { date: "2026-08-28", close: 1297.4, time: "2026-08-28", value: 1297.4 });
  const ascendingSeries = normalizeCapabilityResult("series", { symbol: "600519.SH" }, { result: { data: [{ date: "2026-08-26", close: 1290 }, { date: "2026-08-28", close: 1297.4 }] } });
  assert.equal(ascendingSeries.asOf, "2026-08-28");
  const mixedSeries = normalizeCapabilityResult("series", { symbol: "600519.SH" }, { result: { data: [{ date: "unknown", close: 1290 }, { date: "2026-08-28", close: 1297.4 }] } });
  assert.equal(mixedSeries.asOf, "2026-08-28");
  const calendar = normalizeCapabilityResult("trading_calendar", { date: "2026-08-31", marketcode: "212001" }, { success: true, result: { data: { time: ["2026-08-28", "2026-08-31"] } } });
  assert.deepEqual(calendar.tradingDates, ["2026-08-28", "2026-08-31"]);
  assert.equal(calendar.isTradingDay, true);
});

test("normalizes discovered capabilities without losing schema, examples, or billing hints", () => {
  const capability = normalizeDiscoveredCapability({ tool_id: "qveris_finance.analytics_rsi", name: "RSI 技术指标", description: "计算相对强弱指标", provider_name: "qveris_finance", params: [{ name: "symbol", type: "string", required: true, description: "证券代码" }, { name: "period", type: "integer", required: false }], examples: { sample_parameters: { symbol: "600519" } }, expected_cost: "1 credit", stats: { success_rate: 0.98 } }, { searchId: "srch_demo" });
  assert.equal(capability.kind, "discovered:qveris_finance.analytics_rsi");
  assert.deepEqual(capability.parameters, { symbol: "string", period: "integer?" });
  assert.equal(capability.sampleParameters.symbol, "600519");
  assert.equal(capability.expectedCost, "1 credit");
  assert.equal(capability.searchId, "srch_demo");
});

test("binds dynamic capability tests to the currently discovered directory", () => {
  const directory = {
    searchId: "search-current",
    tools: [{ toolId: "qveris_finance.analytics_rsi" }],
  };
  assert.deepEqual(validateDiscoveredCapabilitySelection(directory, { toolId: "qveris_finance.analytics_rsi", searchId: "search-current" }), {
    toolId: "qveris_finance.analytics_rsi",
    searchId: "search-current",
  });
  for (const input of [
    { toolId: "qveris_finance.other", searchId: "search-current" },
    { toolId: "qveris_finance.analytics_rsi", searchId: "search-old" },
    { toolId: "qveris_finance.analytics_rsi", searchId: "" },
  ]) {
    assert.throws(() => validateDiscoveredCapabilitySelection(directory, input), (error) => error?.code === "CAPABILITY_NOT_VERIFIED" && error?.status === 403);
  }
  assert.throws(() => validateDiscoveredCapabilitySelection({ ...directory, sessionId: "host-a" }, { toolId: "qveris_finance.analytics_rsi", searchId: "search-current", sessionId: "host-b" }), (error) => error?.code === "CAPABILITY_NOT_VERIFIED" && error?.status === 403);
});

test("normalizes verified event, capital-flow, and sentiment CAP envelopes", () => {
  assert.equal(BUILTIN_CAPABILITY_CATALOG.core_event.toolId, "qveris_finance.event_calendar_corp");
  assert.equal(BUILTIN_CAPABILITY_CATALOG.capital_flow.capability, "FLOW.LARGE_ORDER");
  assert.equal(BUILTIN_CAPABILITY_CATALOG.sentiment.capability, "NEWS.FIN.TAGGED");
  assert.equal(BUILTIN_CAPABILITY_CATALOG.market_news.toolId, "qveris_finance.news_fin_realtime");
  assert.equal(BUILTIN_CAPABILITY_CATALOG.index_levels.toolId, "qveris_finance.index_levels");
  assert.equal(BUILTIN_CAPABILITY_CATALOG.commodity.toolId, "qveris_finance.macro_commodity_benchmark");
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
  const marketNews = normalizeCapabilityResult("market_news", { query: "利率" }, { result: { data: [{ headline: "利率决议", published_at: "2026-09-04", source: "央行" }] } });
  assert.equal(marketNews.news[0].title, "利率决议");
  const indices = normalizeCapabilityResult("index_levels", { symbol: "DJI" }, { result: { data: [{ symbol: "DJI", price: 53_000, timestamp: "2026-09-04" }] } });
  assert.equal(indices.indices[0].price, 53_000);
  const commodities = normalizeCapabilityResult("commodity", { commodityName: "WTI" }, { result: { data: [{ commodity_name: "WTI", price: 72, unit: "USD" }] } });
  assert.equal(commodities.commodities[0].name, "WTI");
});

test("unwraps bounded multi-layer CAP envelopes for every read-only data kind", () => {
  const envelope = (payload, meta = {}) => ({ success: true, result: { payload: { data: payload, _meta: meta } } });
  const details = normalizeCapabilityResult("details", { symbol: "AAPL" }, envelope({ name: "Apple", industry: "Technology" }, { source_provider: "profile-provider" }));
  assert.equal(details.company.name, "Apple");
  assert.equal(details.source, "profile-provider");
  const series = normalizeCapabilityResult("series", { symbol: "AAPL" }, envelope({ bars: [{ date: "2026-09-01", close: 231.4 }] }));
  assert.deepEqual(series.series[0], { date: "2026-09-01", close: 231.4, time: "2026-09-01", value: 231.4 });
  const events = normalizeCapabilityResult("core_event", { symbol: "AAPL" }, envelope({ events: [{ event_date: "2026-09-02", title: "股东会" }] }));
  assert.equal(events.events[0].title, "股东会");
  const flow = normalizeCapabilityResult("capital_flow", { symbol: "AAPL" }, envelope({ rows: [{ date: "2026-09-02", net_flow: 12 }] }));
  assert.equal(flow.mainNetInflow, 12);
  const sentiment = normalizeCapabilityResult("sentiment", { symbol: "AAPL" }, envelope({ news: [{ title: "结果发布", published_at: "2026-09-02" }] }));
  assert.equal(sentiment.news[0].title, "结果发布");
  const marketNews = normalizeCapabilityResult("market_news", { query: "利率" }, envelope({ articles: [{ headline: "议息会议", published_at: "2026-09-02" }] }));
  assert.equal(marketNews.news[0].title, "议息会议");
  const indices = normalizeCapabilityResult("index_levels", { symbol: "SPX" }, envelope({ indices: [{ symbol: "SPX", price: 5_500 }] }));
  assert.equal(indices.indices[0].price, 5_500);
  const commodities = normalizeCapabilityResult("commodity", { symbol: "WTI" }, envelope({ commodities: [{ symbol: "WTI", price: 72 }] }));
  assert.equal(commodities.commodities[0].price, 72);
});

test("rejects explicit failures hidden in nested CAP envelopes", () => {
  assert.throws(
    () => normalizeCapabilityResult("details", { symbol: "AAPL" }, { result: { payload: { data: { name: "Apple" }, status_code: 503 } } }),
    /金融数据渠道暂未返回可用结果/,
  );
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

test("rejects zero and negative quote prices at the Host normalization boundary", () => {
  for (const price of [0, -1, "", "-0.01", undefined, Number.NaN, "NaN"]) {
    assert.throws(
      () => normalizeCapabilityResult("quote", { symbol: "600519.SH" }, { result: { data: { price, timestamp: "2026-08-28T16:01:30" } } }),
      /CAP 未返回可识别的实时行情/,
    );
  }
  const result = normalizeCapabilityResult("quote", { symbol: "600519.SH" }, { result: { data: { price: "1297.4", timestamp: "2026-08-28T16:01:30" } } });
  assert.equal(result.quotes[0].price, 1297.4);
});

test("keeps direct CAP and cached-tool audit semantics distinct", () => {
  assert.equal(allDataCacheHit([{ memoryCacheHit: true }]), true);
  assert.equal(allDataCacheHit([{ memoryCacheHit: true }, { memoryCacheHit: false }]), false);
  assert.equal(allDataCacheHit([]), false);
  assert.equal(capabilityAuditOperation({ dataCacheHit: true }), "cached-call");
  assert.equal(capabilityAuditOperation({ dataCacheHit: false }), "cap-call");
  assert.equal(capabilityAuditOperation({}), "cap-call");
});

test("only falls back to cached tools for capability failures", () => {
  assert.equal(shouldFallbackToCachedTool({ status: 404 }), true);
  assert.equal(shouldFallbackToCachedTool({ status: 400, upstreamCode: "tool_not_found" }), true);
  assert.equal(shouldFallbackToCachedTool({ status: 401 }), false);
  assert.equal(shouldFallbackToCachedTool({ status: 403 }), false);
  assert.equal(shouldFallbackToCachedTool({ status: 429 }), false);
  assert.equal(shouldFallbackToCachedTool({ status: 503 }), false);
  assert.equal(shouldFallbackToCachedTool({ status: 400, upstreamCode: "invalid_parameters" }), false);
  assert.equal(shouldFallbackToCachedTool({ status: 422 }), false);
  assert.equal(shouldFallbackToCachedTool(new Error("CAP 未返回可识别的实时行情")), true);
  assert.equal(shouldFallbackForDataKind("quote", { status: 404 }), true);
  assert.equal(shouldFallbackForDataKind("trading_calendar", { status: 404 }), false);
  assert.equal(shouldFallbackForDataKind("quote", { status: 401 }), false);
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

test("lets one shared CAP waiter cancel without aborting other waiters", async () => {
  let resolveRequest;
  const upstreamController = new AbortController();
  const entry = {
    controller: upstreamController,
    subscribers: 0,
    settled: false,
    promise: new Promise((resolve) => { resolveRequest = resolve; }),
  };
  const firstController = new AbortController();
  const secondController = new AbortController();
  const first = subscribeToSharedRequest(entry, firstController.signal);
  const second = subscribeToSharedRequest(entry, secondController.signal);

  firstController.abort();
  await assert.rejects(first, (error) => error?.name === "AbortError");
  assert.equal(entry.subscribers, 1);
  assert.equal(upstreamController.signal.aborted, false);

  entry.settled = true;
  resolveRequest({ price: 1297.4 });
  await assert.doesNotReject(second);
  assert.equal(entry.subscribers, 0);
});

test("commits a shared CAP result even when the first waiter cancels", async () => {
  let resolveRequest;
  const cache = new Map();
  const entry = { controller: new AbortController(), subscribers: 0, settled: false, promise: new Promise((resolve) => { resolveRequest = resolve; }) };
  const firstController = new AbortController();
  const secondController = new AbortController();
  const first = subscribeToSharedRequest(entry, firstController.signal);
  const second = subscribeToSharedRequest(entry, secondController.signal);
  firstController.abort();
  await assert.rejects(first, (error) => isAbortError(error));
  const value = { quotes: [{ price: 1297.4 }] };
  cacheSharedResult(cache, "quote-key", value, { ttl: 15_000, cacheGeneration: 2, currentGeneration: 2, createdAt: 123 });
  entry.settled = true;
  resolveRequest(value);
  await assert.deepEqual(await second, value);
  assert.deepEqual(cache.get("quote-key"), { createdAt: 123, normalized: value });
});

test("keeps the direct CAP cache bounded and evicts the least recently used entry", () => {
  assert.equal(MAX_DIRECT_DATA_CACHE_ENTRIES, 256);
  const cache = new Map();
  cacheSharedResult(cache, "old", { value: "old" }, { ttl: 15_000, cacheGeneration: 1, currentGeneration: 1, createdAt: 1, maxEntries: 2 });
  cacheSharedResult(cache, "active", { value: "active" }, { ttl: 15_000, cacheGeneration: 1, currentGeneration: 1, createdAt: 2, maxEntries: 2 });
  // Re-inserting a hot key moves it to the newest position before capacity is
  // applied, matching the behavior of a long-running Host cache hit.
  cacheSharedResult(cache, "old", { value: "old-refresh" }, { ttl: 15_000, cacheGeneration: 1, currentGeneration: 1, createdAt: 3, maxEntries: 2 });
  cacheSharedResult(cache, "new", { value: "new" }, { ttl: 15_000, cacheGeneration: 1, currentGeneration: 1, createdAt: 4, maxEntries: 2 });
  assert.equal(cache.has("active"), false);
  assert.deepEqual([...cache.keys()], ["old", "new"]);
});

test("aborts and removes in-flight requests when the cache is reset", () => {
  const requests = new Map();
  const controller = new AbortController();
  const entry = { controller, settled: false };
  requests.set("quote-key", entry);
  abortInFlightRequests(requests, "configuration-changed");
  assert.equal(requests.size, 0);
  assert.equal(controller.signal.aborted, true);
  assert.equal(isAbortError(controller.signal.reason), true);
});

test("links a disconnected route to its upstream controller without losing child cancellation", () => {
  const parent = new AbortController();
  const child = new AbortController();
  const unlink = linkAbortSignal(parent.signal, child);
  parent.abort(new Error("client disconnected"));
  assert.equal(child.signal.aborted, true);
  assert.equal(child.signal.reason.message, "client disconnected");
  unlink();

  const secondParent = new AbortController();
  const scope = createAbortScope(secondParent.signal, 0);
  secondParent.abort("route closed");
  assert.equal(scope.signal.aborted, true);
  scope.close();
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
