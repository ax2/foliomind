import test from "node:test";
import assert from "node:assert/strict";
import { adaptParameters, classifyRequest } from "./local-host.mjs";

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
