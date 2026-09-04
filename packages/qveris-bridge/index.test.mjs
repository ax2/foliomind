import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import qverisExtension, { isLoopbackExecutorUrl } from "./index.mjs";

function loadExtension() {
  const tools = new Map();
  qverisExtension({ registerTool(tool) { tools.set(tool.name, tool); } });
  return tools;
}

async function withExecutor(handler, run) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const previous = Object.fromEntries(["QVERIS_EXECUTOR_URL", "QVERIS_MANAGED_CAPABILITY", "QVERIS_PI_RUN_ID", "QVERIS_PRODUCT_RUN_ID", "QVERIS_API_KEY"].map((key) => [key, process.env[key]]));
  process.env.QVERIS_EXECUTOR_URL = `http://127.0.0.1:${server.address().port}/execute`;
  process.env.QVERIS_MANAGED_CAPABILITY = "capability-test";
  process.env.QVERIS_PI_RUN_ID = `run-${Date.now()}-${Math.random()}`;
  process.env.QVERIS_PRODUCT_RUN_ID = "product-run-test";
  process.env.QVERIS_API_KEY = "long-lived-key-must-not-be-read";
  try { await run(); } finally {
    await new Promise((resolve) => server.close(resolve));
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
}

async function completeChain(tools) {
  await tools.get("qveris_search").execute("search-call", { query: "equity quote API" });
  await tools.get("qveris_inspect").execute("inspect-call", { search_id: "search-1", tool_ids: ["market.quote.v1"] });
  return tools.get("qveris_call").execute("call-call", { search_id: "search-1", tool_id: "market.quote.v1", parameters: { symbol: "AAPL" } });
}

test("registers the QVeris tools and the stable FolioMind data tool", () => {
  const tools = loadExtension();
  assert.deepEqual([...tools.keys()], ["qveris_search", "qveris_inspect", "qveris_call", "foliomind_data"]);
  assert.equal("session_id" in tools.get("qveris_search").parameters.properties, false);
  assert.equal("session_id" in tools.get("qveris_inspect").parameters.properties, false);
  assert.equal("session_id" in tools.get("qveris_call").parameters.properties, false);
  assert.equal("max_response_size" in tools.get("qveris_call").parameters.properties, false);
  assert.deepEqual(tools.get("foliomind_data").parameters.required, ["kind"]);
  assert.deepEqual(tools.get("foliomind_data").parameters.properties.kind.enum, ["quote", "details", "series", "core_event", "capital_flow", "sentiment", "market_news", "index_levels", "commodity"]);
  assert.equal("commodity_name" in tools.get("foliomind_data").parameters.properties, true);
});

test("accepts only loopback executor URLs", () => {
  assert.equal(isLoopbackExecutorUrl("http://127.0.0.1:9002/execute"), true);
  assert.equal(isLoopbackExecutorUrl("http://localhost:9002/execute"), true);
  assert.equal(isLoopbackExecutorUrl("https://executor.example.com:443/execute"), false);
  assert.equal(isLoopbackExecutorUrl("http://127.0.0.1.evil.test:9002/execute"), false);
  assert.equal(isLoopbackExecutorUrl("http://127.0.0.1/execute"), false);
});

test("rejects a non-loopback executor before making a request", async () => {
  const previous = {
    url: process.env.QVERIS_EXECUTOR_URL,
    capability: process.env.QVERIS_MANAGED_CAPABILITY,
    run: process.env.QVERIS_PI_RUN_ID,
  };
  process.env.QVERIS_EXECUTOR_URL = "https://executor.example.com:443/execute";
  process.env.QVERIS_MANAGED_CAPABILITY = "capability-test";
  process.env.QVERIS_PI_RUN_ID = "run-invalid-url";
  try {
    await assert.rejects(loadExtension().get("qveris_search").execute("search", { query: "quote API" }), /本机回环 URL/);
  } finally {
    for (const [key, value] of Object.entries({
      QVERIS_EXECUTOR_URL: previous.url,
      QVERIS_MANAGED_CAPABILITY: previous.capability,
      QVERIS_PI_RUN_ID: previous.run,
    })) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
});

test("forwards run metadata and uses only the managed capability", async () => {
  const operations = [];
  await withExecutor(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    operations.push({ authorization: request.headers.authorization, body });
    const result = body.operation === "search"
      ? { search_id: "search-1", tools: [{ id: "market.quote.v1" }] }
      : { tools: [{ id: "market.quote.v1" }], quote: 123 };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ result, trace_id: "trace-1" }));
  }, async () => {
    const result = await completeChain(loadExtension());
    assert.equal(JSON.parse(result.content[0].text).result.quote, 123);
  });
  assert.deepEqual(operations.map(({ body }) => body.operation), ["search", "inspect", "call"]);
  for (const { authorization, body } of operations) {
    assert.equal(authorization, "Bearer capability-test");
    assert.equal(body.bridge_version, "foliomind-bridge.v1");
    assert.equal(body.run_id.startsWith("run-"), true);
    assert.equal(body.product_run_id, "product-run-test");
    assert.ok(body.tool_call_id);
    assert.equal(JSON.stringify(body).includes("long-lived-key-must-not-be-read"), false);
  }
});

test("calls stable FolioMind data without Search or Inspect", async () => {
  let captured;
  await withExecutor(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    captured = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ result: { data: { price: 123.45 }, tool_id: "qveris_finance.mkt_l1_rt", capability: "MKT.L1.RT" } }));
  }, async () => {
    const result = await loadExtension().get("foliomind_data").execute("data-call", { kind: "quote", symbol: "600519" });
    const visible = JSON.parse(result.content[0].text);
    assert.equal(visible.data.price, 123.45);
    assert.equal(result.details.operation, "data");
  });
  assert.equal(captured.operation, "data");
  assert.deepEqual(captured.input, { kind: "quote", symbol: "600519" });
  assert.equal(captured.bridge_version, "foliomind-bridge.v1");
});

test("rejects skipped or mismatched Search/Inspect phases before network I/O", async () => {
  await withExecutor((_request, response) => response.end("{}"), async () => {
    const tools = loadExtension();
    await assert.rejects(tools.get("qveris_call").execute("call", { search_id: "missing", tool_id: "x", parameters: {} }), /必须先在本轮运行中成功执行/);
    await assert.rejects(tools.get("qveris_inspect").execute("inspect", { search_id: "missing", tool_ids: ["x"] }), /必须先在本轮运行中成功执行/);
  });
});

test("redacts executor secrets from errors", async () => {
  await withExecutor((_request, response) => {
    response.writeHead(403, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "capability: cap_secret-token Bearer cap_supersecret http://127.0.0.1:1234/private" } }));
  }, async () => {
    const tools = loadExtension();
    await assert.rejects(
      tools.get("qveris_search").execute("search", { query: "quote API" }),
      (error) => !error.message.includes("cap_secret-token") && !error.message.includes("cap_supersecret") && !error.message.includes("127.0.0.1:1234"),
    );
  });
});
