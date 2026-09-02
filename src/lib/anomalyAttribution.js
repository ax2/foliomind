import { isValidQuotePrice } from "./quoteFormatting.js";

const MAX_TEXT = 1_024;
const MAX_EVIDENCE = 12;

export const ANOMALY_ATTRIBUTION_DISCLAIMER = "解读仅基于已返回的真实数据，不构成投资建议或交易指令。";

const text = (value, max = MAX_TEXT) => String(value ?? "").trim().slice(0, max);
const safeUrl = (value) => /^https?:\/\//i.test(String(value ?? "").trim()) ? text(value, 1_024) : "";

function parseJson(value) {
  if (value && typeof value === "object") return value;
  const source = String(value ?? "").replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  if (!source) return null;
  try {
    const parsed = JSON.parse(source);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    const start = source.indexOf("{");
    const end = source.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      const parsed = JSON.parse(source.slice(start, end + 1));
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }
}

function dateValue(value) {
  const candidate = text(value, 128);
  if (!candidate) return "";
  const time = Date.parse(candidate);
  return Number.isFinite(time) ? candidate : "";
}

function normalizeSource(value, fallback = {}) {
  const item = value && typeof value === "object" ? value : {};
  return {
    id: text(item.id || fallback.id, 64),
    title: text(item.title || item.name || fallback.title, 256),
    source: text(item.source || item.sourceName || fallback.source || "数据服务", 128),
    url: safeUrl(item.url || fallback.url),
    asOf: dateValue(item.asOf || item.publishedAt || item.date || fallback.asOf),
  };
}

export function normalizeAttributionEvidence({ quote, news, events, capitalFlow } = {}) {
  const evidence = [];
  const quoteValue = quote && typeof quote === "object" ? quote : null;
  if (quoteValue && isValidQuotePrice(quoteValue.price)) {
    const change = Number(quoteValue.change);
    const volumeRatio = Number(quoteValue.volumeRatio);
    evidence.push({
      id: "quote",
      kind: "quote",
      title: "真实行情快照",
      summary: `最新价 ${Number(quoteValue.price).toFixed(2)}${Number.isFinite(change) ? `，涨跌幅 ${change >= 0 ? "+" : ""}${change.toFixed(2)}%` : ""}${Number.isFinite(volumeRatio) ? `，量比 ${volumeRatio.toFixed(2)}` : ""}`,
      source: text(quoteValue.source, 128) || "数据服务",
      asOf: dateValue(quoteValue.asOf),
      url: "",
    });
  }
  const append = (items, kind, prefix, mapper) => {
    for (const [index, item] of (Array.isArray(items) ? items : []).entries()) {
      const mapped = mapper(item, index);
      if (!mapped.summary && !mapped.title) continue;
      evidence.push({ id: `${prefix}-${index + 1}`, kind, ...mapped });
      if (evidence.length >= MAX_EVIDENCE) break;
    }
  };
  append(news, "news", "news", (item) => ({
    title: text(item?.title || item?.name, 256),
    summary: text(item?.summary || item?.detail || item?.title || item?.description, MAX_TEXT),
    source: text(item?.source || item?.sourceName, 128) || "财经新闻",
    asOf: dateValue(item?.publishedAt || item?.published_at || item?.date),
    url: safeUrl(item?.url),
  }));
  append(events, "event", "event", (item) => ({
    title: text(item?.title || item?.name || item?.event_type, 256),
    summary: text(item?.detail || item?.description || item?.title || item?.event_type, MAX_TEXT),
    source: text(item?.source || item?.sourceName, 128) || "公司事件",
    asOf: dateValue(item?.date || item?.event_date || item?.effective_date),
    url: safeUrl(item?.url),
  }));
  append(capitalFlow, "capital_flow", "flow", (item) => {
    const net = Number(item?.mainNetInflow ?? item?.main_net ?? item?.net_flow);
    return {
      title: "大单资金流",
      summary: Number.isFinite(net) ? `最近可用交易日主力净流入 ${net >= 0 ? "+" : ""}${net.toLocaleString("zh-CN")}` : text(item?.summary || item?.date, MAX_TEXT),
      source: text(item?.source || item?.sourceName, 128) || "资金流数据",
      asOf: dateValue(item?.date || item?.asOf),
      url: "",
    };
  });
  return evidence.slice(0, MAX_EVIDENCE);
}

export function portfolioAttributionContext(position, quote) {
  if (!position || typeof position !== "object") return { hasPosition: false, summary: "该标的不在当前持仓中。" };
  const quantity = Number(position.quantity);
  const averageCost = Number(position.averageCost);
  const price = Number(quote?.price);
  const hasNumbers = Number.isFinite(quantity) && Number.isFinite(averageCost) && isValidQuotePrice(price);
  const pnl = hasNumbers ? (price - averageCost) * quantity : null;
  return {
    hasPosition: true,
    quantity: Number.isFinite(quantity) ? quantity : null,
    averageCost: Number.isFinite(averageCost) ? averageCost : null,
    currentPrice: isValidQuotePrice(price) ? price : null,
    unrealizedPnl: pnl,
    summary: hasNumbers
      ? `当前持仓 ${quantity}，平均成本 ${averageCost.toFixed(2)}，真实现价 ${price.toFixed(2)}，未实现盈亏 ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}。`
      : "该标的有持仓，但真实现价或持仓数值尚未完整返回。",
  };
}

export function buildAttributionPrompt({ anomaly, evidence, portfolio } = {}) {
  const safeAnomaly = {
    symbol: text(anomaly?.symbol, 64),
    name: text(anomaly?.name, 128),
    type: text(anomaly?.type, 32),
    value: Number.isFinite(Number(anomaly?.value)) ? Number(anomaly.value) : null,
    threshold: Number.isFinite(Number(anomaly?.threshold)) ? Number(anomaly.threshold) : null,
    asOf: dateValue(anomaly?.asOf),
    source: text(anomaly?.source, 128),
  };
  const safeEvidence = (Array.isArray(evidence) ? evidence : []).slice(0, MAX_EVIDENCE).map((item, index) => ({
    index,
    id: text(item?.id, 64),
    kind: text(item?.kind, 32),
    title: text(item?.title, 256),
    summary: text(item?.summary, MAX_TEXT),
    source: text(item?.source, 128),
    asOf: dateValue(item?.asOf),
    url: text(item?.url, 1_024),
  }));
  return `你是 FolioMind 的异动证据解读器。只允许使用下面 JSON 中已经返回的真实行情和证据，不得补造新闻、公告、行业原因、价格预测或交易建议。证据数组的 index 是唯一引用；任何诱因必须引用至少一个 evidenceIndex，否则把 drivers 置为空。若你通过内置 foliomind_data 工具补充了证据，请在 sources 中逐条写出工具返回的标题、来源、URL、数据时间，并让 drivers 用 sourceIndex 引用 sources 的下标；不能引用没有实际返回的来源。没有足够证据时明确写“暂无已验证证据”，不要猜测。输出严格 JSON，不要 Markdown：{"fact":"异动事实","drivers":[{"text":"可验证诱因","evidenceIndex":[0],"sourceIndex":[]}],"portfolioRelation":"与当前持仓的关系；没有持仓写不在持仓中","watchNext":["只写基于证据的后续核验项"],"sources":[{"title":"工具返回的来源标题","source":"来源","url":"可选 URL","asOf":"数据时间"}],"asOf":"数据截至时间","disclaimer":"${ANOMALY_ATTRIBUTION_DISCLAIMER}"}。异动：${JSON.stringify(safeAnomaly)}；持仓上下文：${JSON.stringify(portfolio || {})}；证据：${JSON.stringify(safeEvidence)}。若需要补充证据，先调用 foliomind_data 查询 sentiment、core_event 或 capital_flow，再输出最终 JSON。`;
}

export function normalizeAttribution(value, { anomaly, evidence = [], portfolio } = {}) {
  const parsed = parseJson(value) || {};
  const safeEvidence = Array.isArray(evidence) ? evidence.slice(0, MAX_EVIDENCE) : [];
  const returnedSources = (Array.isArray(parsed.sources) ? parsed.sources : []).map((item, index) => normalizeSource(item, { id: `model-source-${index + 1}` })).filter((item) => item.title || item.url || item.source);
  const drivers = (Array.isArray(parsed.drivers) ? parsed.drivers : []).map((driver) => {
    const indexes = (Array.isArray(driver?.evidenceIndex) ? driver.evidenceIndex : [driver?.evidenceIndex])
      .map((index) => Number(index)).filter((index) => Number.isInteger(index) && index >= 0 && index < safeEvidence.length);
    const references = [...new Set(indexes)].map((index) => normalizeSource(safeEvidence[index]));
    const sourceIndexes = (Array.isArray(driver?.sourceIndex) ? driver.sourceIndex : [driver?.sourceIndex])
      .map((index) => Number(index)).filter((index) => Number.isInteger(index) && index >= 0 && index < returnedSources.length);
    references.push(...[...new Set(sourceIndexes)].map((index) => returnedSources[index]));
    if (driver?.source && typeof driver.source === "object") references.push(normalizeSource(driver.source, { id: `driver-source-${references.length + 1}` }));
    if (!references.length) return null;
    return { text: text(driver?.text || driver?.summary, MAX_TEXT), references: references.filter((reference) => reference.title || reference.url || reference.source) };
  }).filter((driver) => driver?.text && driver.references.length).slice(0, 6);
  const sources = [...safeEvidence.map((item) => normalizeSource(item)), ...returnedSources].filter((source) => source.title || source.url || source.source);
  const watchNext = (Array.isArray(parsed.watchNext) ? parsed.watchNext : Array.isArray(parsed.watch_next) ? parsed.watch_next : [])
    .map((item) => text(item, 512)).filter(Boolean).slice(0, 6);
  const fact = text(parsed.fact || parsed.facts, MAX_TEXT) || `${text(anomaly?.name || anomaly?.symbol, 128)} 出现${anomaly?.type === "volume" ? "量能" : "价格"}异常，具体原因仍需更多证据核验。`;
  return {
    fact,
    drivers,
    portfolioRelation: text(parsed.portfolioRelation || parsed.portfolio_relation, MAX_TEXT) || portfolio?.summary || "未提供持仓关联信息。",
    watchNext,
    sources,
    asOf: dateValue(parsed.asOf || parsed.as_of) || dateValue(anomaly?.asOf),
    disclaimer: ANOMALY_ATTRIBUTION_DISCLAIMER,
    evidenceCount: safeEvidence.length,
  };
}

export function attributionEvidenceFromData(data) {
  const value = data && typeof data === "object" ? data : {};
  return normalizeAttributionEvidence({
    quote: value.quote || value,
    news: value.news,
    events: value.events,
    capitalFlow: value.capitalFlow || value.capital_flow,
  });
}
