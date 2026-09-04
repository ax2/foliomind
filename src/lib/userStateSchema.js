import { normalizeConditions } from "./monitorConditions.js";
import { normalizeWatchlistItem } from "./watchlist.js";
import { normalizeBriefingSchedule } from "./briefingSchedule.js";
import { normalizeMonitorExpiresAt, normalizeMonitorTriggerMode } from "./monitorLifecycle.js";
import { safeExternalUrl } from "./urlSafety.js";

const text = (value, max = 512) => String(value ?? "").trim().slice(0, max);
const finiteNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const PLAN_HORIZONS = new Set(["short", "swing", "medium", "long"]);
const PLAN_STATUSES = new Set(["none", "active", "executed", "archived"]);
const LEGACY_SEED_RULES = Object.freeze([
  { id: "r1", symbol: "600519", strategyId: "price_change", threshold: 3, intervalSeconds: 300 },
  { id: "r2", symbol: "300750", strategyId: "news_risk", threshold: 1, intervalSeconds: 600 },
]);
// Skill metadata ships with the application; only the selected IDs belong in
// the persisted, portable state. Keep legacy defaults so older state files do
// not uninstall the two built-in skills on their first reload.
export const DEFAULT_INSTALLED_SKILL_IDS = Object.freeze(["fundamental", "monitor"]);

function sanitizeInstalledSkillIds(value) {
  const source = Array.isArray(value) ? value : DEFAULT_INSTALLED_SKILL_IDS;
  return [...new Set(source
    .map((item) => text(item, 64))
    .filter((item) => item && /^[A-Za-z0-9._-]+$/.test(item)))]
    .slice(0, 100);
}

function sanitizeWatchlist(items) {
  return (Array.isArray(items) ? items : []).slice(0, 200).map((item) => normalizeWatchlistItem({
    symbol: text(item?.symbol, 64), name: text(item?.name, 128), market: text(item?.market, 64), category: text(item?.category, 64), group: text(item?.group ?? item?.groupId, 64),
  })).filter((item) => item.symbol && item.name);
}

function isLegacySeedRule(rule, seed) {
  const condition = rule.conditions?.[0];
  const seedCondition = seed.id === "r1"
    ? { type: "price_change", operator: "abs_gte", value: 3 }
    : { type: "core_event", operator: "gte", value: 1 };
  return rule.id === seed.id
    && rule.symbol === seed.symbol
    && rule.strategyId === seed.strategyId
    && rule.threshold === seed.threshold
    && rule.intervalSeconds === seed.intervalSeconds
    && rule.enabled === true
    && rule.lastCheckedAt === null
    && rule.lastTriggeredAt === null
    && rule.lastSignalTriggered === null
    && Object.keys(rule.lastSignalBySymbol || {}).length === 0
    && rule.triggerMode === "edge"
    && rule.expiresAt === null
    && rule.logic === "AND"
    && condition?.type === seedCondition.type
    && condition?.operator === seedCondition.operator
    && condition?.value === seedCondition.value;
}

function sanitizeRules(items) {
  const normalized = (Array.isArray(items) ? items : []).slice(0, 500).map((rule) => {
    const scope = rule?.scope === "watchlist" ? "watchlist" : "symbol";
    const symbol = scope === "watchlist" ? "*" : text(rule?.symbol, 64).toUpperCase();
    const lastSignalBySymbol = Object.fromEntries(Object.entries(rule?.lastSignalBySymbol || {})
      .map(([key, value]) => [text(key, 64).toUpperCase(), value])
      .filter(([key, value]) => key && typeof value === "boolean")
      .slice(0, 200));
    return {
      id: text(rule?.id, 128), scope, symbol, strategyId: text(rule?.strategyId, 64), threshold: finiteNumber(rule?.threshold), conditions: normalizeConditions(rule?.conditions, text(rule?.strategyId, 64)), logic: String(rule?.logic || "AND").toUpperCase() === "OR" ? "OR" : "AND", intervalSeconds: finiteNumber(rule?.intervalSeconds), enabled: rule?.enabled !== false, lastCheckedAt: rule?.lastCheckedAt ? text(rule.lastCheckedAt, 64) : null, lastTriggeredAt: rule?.lastTriggeredAt ? text(rule.lastTriggeredAt, 64) : null, lastSignalTriggered: typeof rule?.lastSignalTriggered === "boolean" ? rule.lastSignalTriggered : null, lastSignalBySymbol, triggerMode: normalizeMonitorTriggerMode(rule?.triggerMode), expiresAt: normalizeMonitorExpiresAt(rule?.expiresAt),
    };
  }).filter((rule) => rule.id && rule.symbol && rule.strategyId && rule.threshold !== null && rule.intervalSeconds !== null);
  return normalized;
}

function migrateLegacySeedRules(rules, notifications, monitorHistory) {
  // Versions before the explicit-alert onboarding seeded two enabled rules.
  // Remove only an untouched exact pair with no activity; any user edit,
  // notification, history, or additional rule is preserved during upgrade.
  if (notifications.length === 0 && monitorHistory.length === 0
    && rules.length === LEGACY_SEED_RULES.length
    && LEGACY_SEED_RULES.every((seed) => rules.some((rule) => isLegacySeedRule(rule, seed)))) return [];
  return rules;
}

function sanitizeNotifications(items) {
  return (Array.isArray(items) ? items : []).slice(0, 500).map((item) => ({
    id: text(item?.id, 128), kind: text(item?.kind, 32), symbol: text(item?.symbol, 64).toUpperCase(), name: text(item?.name, 128), ruleId: text(item?.ruleId, 128), title: text(item?.title, 256), body: text(item?.body, 4096), severity: ["info", "warning", "critical"].includes(item?.severity) ? item.severity : "info", createdAt: text(item?.createdAt, 64), read: item?.read === true, source: text(item?.source, 64), eventKey: text(item?.eventKey ?? item?.event_key, 512), reminderPhase: text(item?.reminderPhase ?? item?.reminder_phase, 32),
  })).filter((item) => item.id && item.title);
}

function sanitizePositions(items) {
  return (Array.isArray(items) ? items : []).slice(0, 500).map((item) => ({
    id: text(item?.id, 128), symbol: text(item?.symbol, 64).toUpperCase(), name: text(item?.name, 128), market: text(item?.market, 64), quantity: finiteNumber(item?.quantity), averageCost: finiteNumber(item?.averageCost), takeProfitPrice: finiteNumber(item?.takeProfitPrice ?? item?.take_profit_price), stopLossPrice: finiteNumber(item?.stopLossPrice ?? item?.stop_loss_price), takeProfitTriggered: item?.takeProfitTriggered === true, stopLossTriggered: item?.stopLossTriggered === true, planThesis: text(item?.planThesis ?? item?.plan_thesis, 2_000), planHorizon: PLAN_HORIZONS.has(String(item?.planHorizon ?? item?.plan_horizon ?? "")) ? String(item?.planHorizon ?? item?.plan_horizon) : null, planStatus: PLAN_STATUSES.has(String(item?.planStatus ?? item?.plan_status ?? "")) ? String(item?.planStatus ?? item?.plan_status) : null, planCreatedAt: item?.planCreatedAt ? text(item.planCreatedAt, 64) : null, planUpdatedAt: item?.planUpdatedAt ? text(item.planUpdatedAt, 64) : null,
    planActions: (Array.isArray(item?.planActions ?? item?.plan_actions) ? (item.planActions ?? item.plan_actions) : []).slice(0, 20).map((action) => ({ id: text(action?.id, 128), type: text(action?.type, 32), at: text(action?.at, 64), note: text(action?.note, 512) })).filter((action) => action.id && action.type && action.at),
  })).filter((item) => item.id && item.symbol && item.name && item.quantity !== null && item.averageCost !== null && item.quantity > 0 && item.averageCost >= 0);
}

function sanitizeMonitorHistory(items) {
  return (Array.isArray(items) ? items : []).slice(0, 500).map((item) => ({
    id: text(item?.id, 128), ruleId: text(item?.ruleId, 128), symbol: text(item?.symbol, 64).toUpperCase(), checkedAt: text(item?.checkedAt, 64), outcome: ["triggered", "not_triggered", "unknown", "error"].includes(item?.outcome) ? item.outcome : "unknown", triggered: typeof item?.triggered === "boolean" ? item.triggered : null, title: text(item?.title, 256), summary: text(item?.summary, 4096), severity: ["info", "warning", "critical"].includes(item?.severity) ? item.severity : "info", source: text(item?.source, 64), asOf: text(item?.asOf, 128), conditionResults: Array.isArray(item?.conditionResults) ? item.conditionResults.slice(0, 6).map((value) => typeof value === "boolean" ? value : null) : [], audits: Array.isArray(item?.audits) ? item.audits.slice(0, 12).map((audit) => ({ operation: text(audit?.operation, 64), outcome: text(audit?.outcome, 64), toolId: text(audit?.toolId ?? audit?.tool_id, 160), capability: text(audit?.capability, 128) })).filter((audit) => audit.operation || audit.outcome || audit.toolId || audit.capability) : [],
  })).filter((item) => item.id && item.ruleId && item.symbol && item.checkedAt);
}

function sanitizePortfolioReviews(items) {
  return (Array.isArray(items) ? items : []).slice(0, 90).map((review) => ({
    id: text(review?.id, 128), kind: review?.kind === "close" ? "close" : "close", tradingDate: text(review?.tradingDate, 32), createdAt: text(review?.createdAt, 64), asOf: text(review?.asOf, 128),
    pricedCount: finiteNumber(review?.pricedCount), totalCount: finiteNumber(review?.totalCount), totalCost: finiteNumber(review?.totalCost), totalMarketValue: finiteNumber(review?.totalMarketValue), totalPnl: finiteNumber(review?.totalPnl), totalPnlPercent: finiteNumber(review?.totalPnlPercent),
    topGainer: sanitizeReviewPosition(review?.topGainer), topLoser: sanitizeReviewPosition(review?.topLoser),
    positions: (Array.isArray(review?.positions) ? review.positions : []).slice(0, 200).map(sanitizeReviewPosition).filter(Boolean),
    riskSignals: (Array.isArray(review?.riskSignals) ? review.riskSignals : []).slice(0, 8).map((signal) => ({ level: ["info", "warning", "critical"].includes(signal?.level) ? signal.level : "info", title: text(signal?.title, 256), detail: text(signal?.detail, 1024) })).filter((signal) => signal.title),
    upcomingEvents: (Array.isArray(review?.upcomingEvents) ? review.upcomingEvents : []).slice(0, 12).map((event) => ({ symbol: text(event?.symbol, 64).toUpperCase(), name: text(event?.name, 128), date: text(event?.date, 64), type: text(event?.type, 64), title: text(event?.title, 256), source: text(event?.source, 128), url: text(event?.url, 1024) })).filter((event) => event.symbol && event.date && event.title),
    sources: (Array.isArray(review?.sources) ? review.sources : []).slice(0, 12).map((source) => text(source, 128)).filter(Boolean), disclaimer: text(review?.disclaimer, 512),
  })).filter((review) => review.id && review.tradingDate && review.createdAt && review.pricedCount != null && review.pricedCount > 0 && review.totalCount != null && review.totalCount >= review.pricedCount);
}

const PREMARKET_ITEM_LIMIT = 20;

function sanitizePremarketItem(value) {
  if (!value || typeof value !== "object") return null;
  const item = {
    symbol: text(value.symbol, 64).toUpperCase(), name: text(value.name, 128), title: text(value.title, 256), summary: text(value.summary, 1_000), detail: text(value.detail, 1_000),
    date: text(value.date, 64), publishedAt: text(value.publishedAt ?? value.published_at, 128), source: text(value.source, 128), url: safeExternalUrl(value.url), sentiment: text(value.sentiment, 64),
  };
  return item.title || item.summary || item.detail ? item : null;
}

function sanitizePremarketBriefing(value) {
  if (!value || typeof value !== "object") return null;
  const sections = Object.fromEntries(["holdings", "industry", "macro", "overseas"].map((id) => {
    const section = value.sections?.[id];
    const items = (Array.isArray(section?.items) ? section.items : []).slice(0, PREMARKET_ITEM_LIMIT).map(sanitizePremarketItem).filter(Boolean);
    return [id, { id, title: text(section?.title || id, 128), status: items.length ? "available" : "empty", items, emptyCopy: text(section?.emptyCopy || "当前没有返回可展示的真实数据。", 256) }];
  }));
  const normalized = {
    id: text(value.id, 128), kind: "premarket", createdAt: text(value.createdAt, 64), asOf: text(value.asOf, 128), sections,
    sources: [...new Set((Array.isArray(value.sources) ? value.sources : []).slice(0, 12).map((source) => text(source, 128)).filter(Boolean))], disclaimer: text(value.disclaimer, 512),
  };
  return normalized.id && normalized.createdAt ? normalized : null;
}

function sanitizeReviewPosition(value) {
  if (!value || typeof value !== "object") return null;
  const position = { symbol: text(value.symbol, 64).toUpperCase(), name: text(value.name, 128), currentPrice: finiteNumber(value.currentPrice), pnl: finiteNumber(value.pnl), pnlPercent: finiteNumber(value.pnlPercent), weight: finiteNumber(value.weight), asOf: text(value.asOf, 128), source: text(value.source, 128) };
  return position.symbol && position.name && position.currentPrice != null ? position : null;
}

export function normalizeUserState(state = {}) {
  const value = state && typeof state === "object" ? state : {};
  const revision = Number(value.revision);
  const notifications = sanitizeNotifications(value.notifications);
  const monitorHistory = sanitizeMonitorHistory(value.monitorHistory);
  const monitorRules = migrateLegacySeedRules(sanitizeRules(value.monitorRules ?? value.rules), notifications, monitorHistory);
  return { revision: Number.isSafeInteger(revision) && revision >= 0 ? revision : 0, watchlist: sanitizeWatchlist(value.watchlist), monitorRules, notifications, portfolioPositions: sanitizePositions(value.portfolioPositions), monitorHistory, portfolioReviews: sanitizePortfolioReviews(value.portfolioReviews), briefingSchedule: normalizeBriefingSchedule(value.briefingSchedule), premarketBriefing: sanitizePremarketBriefing(value.premarketBriefing), installedSkillIds: sanitizeInstalledSkillIds(value.installedSkillIds ?? value.installedSkills) };
}

export { sanitizeInstalledSkillIds, sanitizeMonitorHistory, sanitizeNotifications, sanitizePortfolioReviews, sanitizePremarketBriefing, sanitizePositions, sanitizeRules, sanitizeWatchlist, text };
