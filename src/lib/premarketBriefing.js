import { eventDateKey } from "./eventCalendar.js";
import { quoteSymbolKey } from "./quoteFormatting.js";
import { safeExternalUrl } from "./urlSafety.js";

const MAX_NEWS = 60;
const MAX_EVENTS = 40;
const MAX_TEXT = 512;

function text(value, max = MAX_TEXT) {
  return String(value ?? "").trim().slice(0, max);
}

function unwrap(value) {
  let current = value;
  for (let index = 0; index < 3; index += 1) {
    if (Array.isArray(current) || !current || typeof current !== "object") break;
    if (current.data && typeof current.data === "object") current = current.data;
    else if (current.result && typeof current.result === "object") current = current.result;
    else break;
  }
  return current;
}

function arrayField(value, fields) {
  const source = unwrap(value);
  if (Array.isArray(source)) return source;
  for (const field of fields) if (Array.isArray(source?.[field])) return source[field];
  return [];
}

function parsedTime(value) {
  const time = Date.parse(String(value || ""));
  return Number.isFinite(time) ? time : -Infinity;
}

export function normalizePremarketNews(value, { symbol = "", name = "" } = {}) {
  const fallbackSymbol = text(symbol, 64).toUpperCase();
  const fallbackName = text(name, 128);
  return arrayField(value, ["news", "articles", "items", "data"])
    .map((item) => ({
      symbol: text(item?.symbol || item?.code || fallbackSymbol, 64).toUpperCase(),
      name: text(item?.name || fallbackName, 128),
      title: text(item?.title || item?.headline || item?.name || item?.description, 256),
      summary: text(item?.summary || item?.detail || item?.description || item?.content, 1_000),
      publishedAt: text(item?.publishedAt || item?.published_at || item?.time || item?.timestamp, 128),
      source: text(item?.source || item?.sourceName || item?.publisher || "数据服务", 128),
      url: safeExternalUrl(item?.url || item?.link),
      sentiment: text(item?.sentimentLabel || item?.sentiment_label || item?.sentiment, 64),
    }))
    .filter((item) => item.title || item.summary)
    .slice(0, MAX_NEWS);
}

export function normalizePremarketEvents(value, { symbol = "", name = "" } = {}) {
  const fallbackSymbol = text(symbol, 64).toUpperCase();
  const fallbackName = text(name, 128);
  return arrayField(value, ["events", "items", "data"])
    .map((item) => ({
      symbol: text(item?.symbol || item?.code || fallbackSymbol, 64).toUpperCase(),
      name: text(item?.name || fallbackName, 128),
      date: text(item?.date || item?.event_date || item?.effective_date, 64),
      type: text(item?.type || item?.event_type || "公司事件", 64),
      title: text(item?.title || item?.description || item?.name, 256),
      detail: text(item?.detail || item?.description || item?.title, 1_000),
      source: text(item?.source || item?.sourceName || "数据服务", 128),
      url: safeExternalUrl(item?.url || item?.link),
    }))
    .filter((item) => item.date || item.title)
    .slice(0, MAX_EVENTS);
}

function unique(items, key) {
  return [...new Map(items.map((item) => [key(item), item])).values()];
}

function section(id, title, items, emptyCopy) {
  return { id, title, status: items.length ? "available" : "empty", items, emptyCopy };
}

/**
 * Build a premarket data brief from real CAP responses already fetched by the
 * caller. This is deliberately a data aggregation contract, not an AI
 * prediction: unsupported sections remain explicit empty states.
 */
export function buildPremarketBriefing({ positions = [], newsBySymbol = {}, events = [], createdAt = new Date().toISOString(), id = "" } = {}) {
  const held = (Array.isArray(positions) ? positions : []).map((position) => ({
    symbol: text(position?.symbol, 64).toUpperCase(),
    symbolKey: quoteSymbolKey(position?.symbol),
    name: text(position?.name || position?.symbol, 128),
  })).filter((position) => position.symbol && position.symbolKey);
  if (!held.length) throw new Error("请先添加持仓，再生成盘前摘要");
  const symbols = new Map(held.map((position) => [position.symbolKey, position]));
  const news = Object.entries(newsBySymbol || {}).flatMap(([key, values]) => {
    const position = symbols.get(quoteSymbolKey(key));
    return normalizePremarketNews(values, position || { symbol: key }).map((item) => ({ ...item, symbol: item.symbol || position?.symbol || key, name: item.name || position?.name || key }));
  });
  const normalizedEvents = [
    ...events,
    ...Object.entries(newsBySymbol || {}).flatMap(([key, values]) => {
      const position = symbols.get(quoteSymbolKey(key));
      return normalizePremarketEvents(values, position || { symbol: key });
    }),
  ];
  const holdingNews = unique(news.filter((item) => symbols.has(quoteSymbolKey(item.symbol))), (item) => `${quoteSymbolKey(item.symbol)}|${item.title}|${item.publishedAt}`)
    .sort((left, right) => parsedTime(right.publishedAt) - parsedTime(left.publishedAt))
    .slice(0, MAX_NEWS);
  const holdingEvents = unique(normalizedEvents.filter((item) => symbols.has(quoteSymbolKey(item.symbol)) && eventDateKey(item.date)), (item) => `${quoteSymbolKey(item.symbol)}|${item.date}|${item.type}|${item.title}`)
    .sort((left, right) => eventDateKey(left.date).localeCompare(eventDateKey(right.date)) || left.title.localeCompare(right.title))
    .slice(0, MAX_EVENTS);
  const asOfValues = holdingNews.map((item) => item.publishedAt).filter(Boolean);
  const latest = asOfValues.sort((left, right) => parsedTime(right) - parsedTime(left))[0] || "";
  return {
    id: text(id || `premarket-${createdAt}`, 128), kind: "premarket", createdAt: text(createdAt, 64), asOf: latest,
    sections: {
      holdings: section("holdings", "持仓公告与事件", [...holdingNews, ...holdingEvents], "当前持仓暂无已返回的公告或排期事件。"),
      industry: section("industry", "行业动态", [], "暂未接入独立行业动态能力，不显示推测内容。"),
      macro: section("macro", "宏观事件", [], "暂未接入独立宏观事件能力，不显示推测内容。"),
      overseas: section("overseas", "隔夜外盘", [], "暂未接入独立外盘能力，不显示推测内容。"),
    },
    sources: unique([...holdingNews, ...holdingEvents].map((item) => item.source).filter(Boolean), (item) => item).slice(0, 12),
    disclaimer: "本摘要仅整理已返回的真实数据，不构成投资建议或交易指令。",
  };
}
