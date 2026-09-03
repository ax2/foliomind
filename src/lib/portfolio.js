import { quoteSymbolKey } from "./quoteFormatting.js";

export const PORTFOLIO_PLAN_HORIZONS = Object.freeze([
  { id: "short", label: "短线（1–5 个交易日）" },
  { id: "swing", label: "波段（1–8 周）" },
  { id: "medium", label: "中线（2–12 个月）" },
  { id: "long", label: "长线（12 个月以上）" },
]);

export const PORTFOLIO_PLAN_STATUSES = Object.freeze([
  { id: "none", label: "未建立计划" },
  { id: "active", label: "执行中" },
  { id: "executed", label: "已执行" },
  { id: "archived", label: "已归档" },
]);

export const PORTFOLIO_SORT_OPTIONS = Object.freeze([
  { id: "default", label: "默认顺序", field: null },
  { id: "marketValue", label: "市值", field: "marketValue" },
  { id: "pnl", label: "未实现盈亏", field: "pnl" },
  { id: "weight", label: "组合占比", field: "weight" },
]);

function parseDelimitedLine(line) {
  const fields = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && line[index + 1] === '"' && quoted) { field += '"'; index += 1; continue; }
    if (char === '"') { quoted = !quoted; continue; }
    if (char === "," && !quoted) { fields.push(field.trim()); field = ""; continue; }
    field += char;
  }
  fields.push(field.trim());
  return fields;
}

function headerKey(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[ _-]/g, "");
}

function importedPlanStatus(value) {
  const text = String(value ?? "").trim();
  return ({ "执行中": "active", "跟踪中": "active", "已执行": "executed", "已归档": "archived", "未建立": "none", "未建立计划": "none" })[text] || text;
}

/**
 * Parse a FolioMind portfolio report (or a minimal symbol/name/quantity/cost
 * CSV) without mutating state. Live quote and audit fields are intentionally
 * ignored so imported files cannot smuggle runtime data into user state.
 */
export function parsePortfolioImport(raw, { maxItems = 500 } = {}) {
  const source = String(raw ?? "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (source.length > 2_000_000) throw new Error("持仓文件过大，请拆分后再导入（最大 2 MB）");
  const lines = source.split("\n");
  const firstIndex = lines.findIndex((line) => line.trim());
  if (firstIndex < 0) return { items: [], skipped: 0, errors: [] };
  const firstFields = parseDelimitedLine(lines[firstIndex]);
  const headerNames = firstFields.map(headerKey);
  const aliases = {
    symbol: ["symbol", "ticker", "代码", "证券代码"],
    name: ["name", "名称"],
    market: ["market", "市场"],
    quantity: ["quantity", "数量", "持仓数量"],
    averageCost: ["averagecost", "average_cost", "平均成本", "成本"],
    takeProfitPrice: ["takeprofitprice", "止盈价"],
    stopLossPrice: ["stoplossprice", "止损价"],
    planThesis: ["planthesis", "plan_thesis", "买入逻辑"],
    planHorizon: ["planhorizon", "plan_horizon", "计划周期"],
    planStatus: ["planstatus", "plan_status", "计划状态"],
  };
  const findIndex = (keys) => headerNames.findIndex((key) => keys.includes(key));
  const hasHeader = findIndex(aliases.symbol) >= 0 && findIndex(aliases.quantity) >= 0;
  const indexes = hasHeader ? Object.fromEntries(Object.entries(aliases).map(([key, keys]) => [key, findIndex(keys)])) : null;
  const items = [];
  const errors = [];
  const seen = new Set();
  const itemIndexBySymbol = new Map();
  let skipped = 0;
  for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
    const line = lines[lineNumber].trim();
    if (!line || line.startsWith("#") || (hasHeader && lineNumber === firstIndex)) continue;
    const fields = parseDelimitedLine(line);
    const value = (key, fallbackIndex) => indexes ? fields[indexes[key]] : fields[fallbackIndex];
    const candidate = {
      symbol: value("symbol", 0), name: value("name", 1), market: value("market", 2),
      quantity: value("quantity", 3), averageCost: value("averageCost", 4),
      takeProfitPrice: value("takeProfitPrice", 5), stopLossPrice: value("stopLossPrice", 6),
      planThesis: value("planThesis", 9), planHorizon: value("planHorizon", 10), planStatus: importedPlanStatus(value("planStatus", 11)),
    };
    const normalized = normalizePortfolioPosition(candidate);
    if (!normalized) { errors.push({ line: lineNumber + 1, reason: "代码、数量或平均成本无效" }); continue; }
    if (seen.has(normalized.symbol)) {
      skipped += 1;
      items[itemIndexBySymbol.get(normalized.symbol)] = normalized;
      continue;
    }
    if (items.length >= maxItems) { errors.push({ line: lineNumber + 1, reason: `最多导入 ${maxItems} 个持仓` }); continue; }
    seen.add(normalized.symbol);
    itemIndexBySymbol.set(normalized.symbol, items.length);
    items.push(normalized);
  }
  return { items, skipped, errors };
}

const PLAN_HORIZON_IDS = new Set(PORTFOLIO_PLAN_HORIZONS.map((item) => item.id));
const PLAN_STATUS_IDS = new Set(PORTFOLIO_PLAN_STATUSES.map((item) => item.id));

function planText(value, max = 2_000) { return String(value ?? "").trim().slice(0, max); }
function planHorizon(value) { const id = String(value ?? "").trim(); return PLAN_HORIZON_IDS.has(id) ? id : null; }
function planStatus(value) { const id = String(value ?? "").trim(); return PLAN_STATUS_IDS.has(id) ? id : null; }

function normalizePlanActions(value) {
  return (Array.isArray(value) ? value : []).slice(0, 20).map((action) => ({
    id: planText(action?.id, 128),
    type: planText(action?.type, 32),
    at: planText(action?.at, 64),
    note: planText(action?.note, 512),
  })).filter((action) => action.id && action.type && action.at);
}

export function normalizePortfolioPosition(value) {
  if (!value || typeof value !== "object") return null;
  const symbol = String(value.symbol ?? "").trim().toUpperCase();
  const name = String(value.name ?? symbol).trim();
  const market = String(value.market ?? "").trim();
  const quantity = Number(value.quantity);
  const averageCost = Number(value.averageCost ?? value.average_cost);
  if (!symbol || !name || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(averageCost) || averageCost <= 0) return null;
  const takeProfitPrice = finitePositive(value.takeProfitPrice ?? value.take_profit_price);
  const stopLossPrice = finitePositive(value.stopLossPrice ?? value.stop_loss_price);
  const planThesis = planText(value.planThesis ?? value.plan_thesis);
  const planHorizonValue = planHorizon(value.planHorizon ?? value.plan_horizon);
  const planActions = normalizePlanActions(value.planActions ?? value.plan_actions);
  const hasPlan = Boolean(planThesis || planHorizonValue || takeProfitPrice != null || stopLossPrice != null || planActions.length);
  const normalizedStatus = planStatus(value.planStatus ?? value.plan_status);
  return {
    id: String(value.id ?? "").trim(),
    symbol,
    name,
    market,
    quantity,
    averageCost,
    takeProfitPrice,
    stopLossPrice,
    takeProfitTriggered: takeProfitPrice == null ? false : value.takeProfitTriggered === true,
    stopLossTriggered: stopLossPrice == null ? false : value.stopLossTriggered === true,
    planThesis,
    planHorizon: planHorizonValue,
    planStatus: normalizedStatus || (hasPlan ? "active" : "none"),
    planCreatedAt: planText(value.planCreatedAt ?? value.plan_created_at, 64) || null,
    planUpdatedAt: planText(value.planUpdatedAt ?? value.plan_updated_at, 64) || null,
    planActions,
  };
}

function finite(value) {
  if (value == null || (typeof value === "string" && value.trim() === "")) return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function finitePositiveValue(value) {
  const number = finite(value);
  return number != null && number > 0 ? number : null;
}

function finitePositive(value) {
  const number = finite(value);
  return number != null && number > 0 ? number : null;
}

/**
 * Evaluate optional take-profit/stop-loss plans against one real quote.
 * Missing quotes never produce an alert and never clear a previous edge state.
 */
export function portfolioAlertChecks(position, quote) {
  const currentPrice = finitePositiveValue(quote?.price);
  const checks = [
    { type: "take-profit", label: "止盈", field: "takeProfitPrice", stateField: "takeProfitTriggered", reached: (price, target) => price >= target, severity: "warning" },
    { type: "stop-loss", label: "止损", field: "stopLossPrice", stateField: "stopLossTriggered", reached: (price, target) => price <= target, severity: "critical" },
  ];
  const updates = {};
  const alerts = [];
  for (const check of checks) {
    const target = finitePositive(position?.[check.field]);
    if (target == null) {
      updates[check.stateField] = false;
      continue;
    }
    if (currentPrice == null) continue;
    const reached = check.reached(currentPrice, target);
    updates[check.stateField] = reached;
    if (reached && position?.[check.stateField] !== true) {
      alerts.push({ type: check.type, label: check.label, target, currentPrice, severity: check.severity, asOf: String(quote?.asOf || ""), source: String(quote?.source || "数据服务") });
    }
  }
  return { updates, alerts };
}

/**
 * Calculate plan progress from a real quote only. Percentages are measured
 * from the current price, so a missing quote never creates a misleading
 * distance or reward/risk ratio.
 */
export function portfolioPlanProgress(position, quote) {
  const currentPrice = finitePositiveValue(quote?.price);
  const takeProfitPrice = finitePositive(position?.takeProfitPrice);
  const stopLossPrice = finitePositive(position?.stopLossPrice);
  const hasPlan = Boolean(planText(position?.planThesis) || planHorizon(position?.planHorizon) || takeProfitPrice != null || stopLossPrice != null);
  const targetDistancePercent = currentPrice != null && takeProfitPrice != null && currentPrice !== 0
    ? ((takeProfitPrice - currentPrice) / currentPrice) * 100
    : null;
  const stopDistancePercent = currentPrice != null && stopLossPrice != null && currentPrice !== 0
    ? ((currentPrice - stopLossPrice) / currentPrice) * 100
    : null;
  const rewardRisk = currentPrice != null && takeProfitPrice != null && stopLossPrice != null && currentPrice > stopLossPrice
    ? (takeProfitPrice - currentPrice) / (currentPrice - stopLossPrice)
    : null;
  return { hasPlan, currentPrice, takeProfitPrice, stopLossPrice, targetDistancePercent, stopDistancePercent, rewardRisk };
}

export function portfolioMetrics(positions, liveQuotes) {
  const quotesByKey = new Map();
  for (const [symbol, quote] of Object.entries(liveQuotes && typeof liveQuotes === "object" ? liveQuotes : {})) {
    const key = quoteSymbolKey(symbol);
    if (!key) continue;
    const candidates = quotesByKey.get(key) || [];
    candidates.push(quote);
    quotesByKey.set(key, candidates);
  }
  const rows = (Array.isArray(positions) ? positions : []).map((position) => {
    const candidates = quotesByKey.get(quoteSymbolKey(position.symbol)) || [];
    const quote = liveQuotes?.[position.symbol] || (candidates.length === 1 ? candidates[0] : undefined);
    const currentPrice = finitePositiveValue(quote?.price);
    const costValue = position.quantity * position.averageCost;
    const marketValue = currentPrice == null ? null : position.quantity * currentPrice;
    const pnl = marketValue == null ? null : marketValue - costValue;
    const pnlPercent = pnl == null || costValue === 0 ? null : (pnl / costValue) * 100;
    return { ...position, quote, currentPrice, costValue, marketValue, pnl, pnlPercent, hasQuote: currentPrice != null, planProgress: portfolioPlanProgress(position, quote) };
  });
  const pricedRows = rows.filter((row) => row.hasQuote);
  const marketValue = pricedRows.reduce((total, row) => total + row.marketValue, 0);
  const costValue = rows.reduce((total, row) => total + row.costValue, 0);
  return {
    rows: rows.map((row) => ({ ...row, weight: marketValue > 0 && row.marketValue != null ? (row.marketValue / marketValue) * 100 : null })),
    totalCost: costValue,
    totalMarketValue: pricedRows.length ? marketValue : null,
    totalPnl: pricedRows.length ? pricedRows.reduce((total, row) => total + row.pnl, 0) : null,
    totalPnlPercent: pricedRows.length && costValue > 0 ? (pricedRows.reduce((total, row) => total + row.pnl, 0) / costValue) * 100 : null,
    pricedCount: pricedRows.length,
    totalCount: rows.length,
  };
}

/** Return stable, display-ready allocation rows derived only from real market values. */
export function portfolioAllocationRows(positions, liveQuotes) {
  return portfolioMetrics(positions, liveQuotes).rows
    .filter((row) => row.hasQuote && Number.isFinite(row.weight))
    .map((row, index) => ({
      id: row.id || `${row.symbol}-${index}`,
      symbol: row.symbol,
      name: row.name,
      marketValue: row.marketValue,
      weight: row.weight,
      index,
    }))
    .sort((left, right) => (right.weight - left.weight) || left.index - right.index)
    .map(({ index, ...row }) => row);
}

/**
 * Return a stable, display-ready performance series from saved close reviews.
 * Only snapshots with a parseable date and real P/L percentage are included;
 * duplicate trading days keep the latest snapshot and missing values remain
 * absent rather than being interpolated.
 */
export function portfolioPerformanceSeries(reviews, limit = 60) {
  const safeLimit = Number.isInteger(limit) ? Math.min(120, Math.max(1, limit)) : 60;
  const byDay = new Map();
  for (const review of Array.isArray(reviews) ? reviews : []) {
    const pnlPercent = finite(review?.totalPnlPercent);
    if (pnlPercent == null) continue;
    const rawDate = String(review?.createdAt || review?.tradingDate || "").trim();
    const timestamp = Date.parse(rawDate);
    if (!Number.isFinite(timestamp)) continue;
    const day = /^\d{4}-\d{2}-\d{2}/.test(String(review?.tradingDate || ""))
      ? String(review.tradingDate).slice(0, 10)
      : new Date(timestamp).toISOString().slice(0, 10);
    const point = {
      id: String(review?.id || `${day}-${timestamp}`),
      tradingDate: day,
      createdAt: rawDate,
      timestamp,
      totalPnlPercent: pnlPercent,
      totalMarketValue: finitePositiveValue(review?.totalMarketValue),
      pricedCount: Number.isFinite(Number(review?.pricedCount)) ? Number(review.pricedCount) : null,
      totalCount: Number.isFinite(Number(review?.totalCount)) ? Number(review.totalCount) : null,
    };
    const previous = byDay.get(day);
    if (!previous || timestamp >= previous.timestamp) byDay.set(day, point);
  }
  return [...byDay.values()].sort((left, right) => left.timestamp - right.timestamp).slice(-safeLimit);
}

function riskTimestamp(rawTime) {
  if (typeof rawTime === "number" && Number.isFinite(rawTime)) return rawTime > 10_000_000_000 ? Math.floor(rawTime / 1000) : Math.floor(rawTime);
  const text = String(rawTime ?? "").trim();
  if (!text) return null;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const number = Number(text);
    return Number.isFinite(number) ? (number > 10_000_000_000 ? Math.floor(number / 1000) : Math.floor(number)) : null;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

/**
 * Build percentage returns from the longest real historical series available
 * for a quote. The range is intentionally not annualized because provider
 * series can be daily, weekly, or intraday; the UI labels the result as a
 * sample statistic instead of implying a fixed frequency.
 */
export function portfolioRiskReturns(quote = {}) {
  const candidates = [];
  if (Array.isArray(quote?.series)) candidates.push(quote.series);
  if (quote?.seriesByRange && typeof quote.seriesByRange === "object") {
    for (const series of Object.values(quote.seriesByRange)) if (Array.isArray(series)) candidates.push(series);
  }
  let best = [];
  for (const series of candidates) {
    const byTime = new Map();
    for (const point of series) {
      const time = riskTimestamp(point?.time ?? point?.timestamp ?? point?.date);
      const price = finitePositiveValue(point?.close ?? point?.value ?? point?.price);
      if (time == null || price == null) continue;
      byTime.set(time, price);
    }
    const points = [...byTime.entries()].sort((left, right) => left[0] - right[0]);
    if (points.length > best.length) best = points;
  }
  const returns = new Map();
  for (let index = 1; index < best.length; index += 1) {
    const previous = best[index - 1][1];
    const current = best[index][1];
    if (!Number.isFinite(previous) || previous <= 0 || !Number.isFinite(current) || current <= 0) continue;
    returns.set(best[index][0], ((current - previous) / previous) * 100);
  }
  return returns;
}

function sampleStandardDeviation(values) {
  if (!Array.isArray(values) || values.length < 3) return null;
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + ((value - average) ** 2), 0) / (values.length - 1);
  return Number.isFinite(variance) && variance >= 0 ? Math.sqrt(variance) : null;
}

function correlationFor(left, right) {
  const overlap = [...left.keys()].filter((time) => right.has(time));
  if (overlap.length < 3) return null;
  const leftValues = overlap.map((time) => left.get(time));
  const rightValues = overlap.map((time) => right.get(time));
  const leftAverage = leftValues.reduce((sum, value) => sum + value, 0) / overlap.length;
  const rightAverage = rightValues.reduce((sum, value) => sum + value, 0) / overlap.length;
  let numerator = 0;
  let leftVariance = 0;
  let rightVariance = 0;
  for (let index = 0; index < overlap.length; index += 1) {
    const leftDelta = leftValues[index] - leftAverage;
    const rightDelta = rightValues[index] - rightAverage;
    numerator += leftDelta * rightDelta;
    leftVariance += leftDelta ** 2;
    rightVariance += rightDelta ** 2;
  }
  const denominator = Math.sqrt(leftVariance * rightVariance);
  return denominator > 0 && Number.isFinite(denominator) ? numerator / denominator : null;
}

/** Sort portfolio rows for comparison; missing real quote values always stay last. */
export function sortPortfolioRows(rows, sortKey = "default", direction = "desc") {
  const values = Array.isArray(rows) ? rows : [];
  const option = PORTFOLIO_SORT_OPTIONS.find((candidate) => candidate.id === sortKey);
  if (!option?.field) return [...values];
  const multiplier = direction === "asc" ? 1 : -1;
  return values.map((row, index) => ({ row, index })).sort((left, right) => {
    const leftRaw = left.row?.[option.field];
    const rightRaw = right.row?.[option.field];
    const leftNumber = leftRaw == null || String(leftRaw).trim() === "" ? null : Number(leftRaw);
    const rightNumber = rightRaw == null || String(rightRaw).trim() === "" ? null : Number(rightRaw);
    const leftValue = Number.isFinite(leftNumber) ? leftNumber : null;
    const rightValue = Number.isFinite(rightNumber) ? rightNumber : null;
    if (leftValue === null && rightValue === null) return left.index - right.index;
    if (leftValue === null) return 1;
    if (rightValue === null) return -1;
    return (leftValue - rightValue) * multiplier || left.index - right.index;
  }).map(({ row }) => row);
}

function csvCell(value) {
  const text = value == null ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Return an export-safe snapshot of the current portfolio, preserving blanks for missing real quotes. */
export function portfolioReportRows(positions, liveQuotes) {
  const metrics = portfolioMetrics(positions, liveQuotes);
  return metrics.rows.map((row) => ({
    symbol: row.symbol,
    name: row.name,
    market: row.market,
    quantity: row.quantity,
    averageCost: row.averageCost,
    takeProfitPrice: row.takeProfitPrice,
    stopLossPrice: row.stopLossPrice,
    takeProfitTriggered: row.takeProfitTriggered,
    stopLossTriggered: row.stopLossTriggered,
    planThesis: row.planThesis,
    planHorizon: row.planHorizon,
    planStatus: row.planStatus,
    planUpdatedAt: row.planUpdatedAt,
    planActionCount: Array.isArray(row.planActions) ? row.planActions.length : 0,
    currentPrice: row.currentPrice,
    marketValue: row.marketValue,
    unrealizedPnl: row.pnl,
    unrealizedPnlPercent: row.pnlPercent,
    weightPercent: row.weight,
    quoteAsOf: row.quote?.asOf || "",
    quoteSource: row.quote?.source || "",
  }));
}

export function portfolioReportCsv(positions, liveQuotes) {
  const columns = [
    ["symbol", "代码"],
    ["name", "名称"],
    ["market", "市场"],
    ["quantity", "数量"],
    ["averageCost", "平均成本"],
    ["takeProfitPrice", "止盈价"],
    ["stopLossPrice", "止损价"],
    ["takeProfitTriggered", "止盈已触发"],
    ["stopLossTriggered", "止损已触发"],
    ["planThesis", "买入逻辑"],
    ["planHorizon", "计划周期"],
    ["planStatus", "计划状态"],
    ["planUpdatedAt", "计划更新时间"],
    ["planActionCount", "计划操作次数"],
    ["currentPrice", "现价"],
    ["marketValue", "市值"],
    ["unrealizedPnl", "未实现盈亏"],
    ["unrealizedPnlPercent", "未实现盈亏百分比"],
    ["weightPercent", "组合占比百分比"],
    ["quoteAsOf", "行情截至"],
    ["quoteSource", "行情来源"],
  ];
  const lines = [columns.map(([, label]) => csvCell(label)).join(",")];
  for (const row of portfolioReportRows(positions, liveQuotes)) lines.push(columns.map(([key]) => csvCell(row[key])).join(","));
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

/**
 * Returns transparent portfolio risk signals derived only from values that
 * have actually been returned by the data channel. No risk score is emitted
 * when the inputs are incomplete.
 */
export function portfolioRiskMetrics(positions, liveQuotes) {
  const metrics = portfolioMetrics(positions, liveQuotes);
  const pricedRows = metrics.rows.filter((row) => row.hasQuote);
  const missingRows = metrics.rows.filter((row) => !row.hasQuote);
  const topPosition = [...pricedRows].sort((left, right) => (right.weight ?? 0) - (left.weight ?? 0))[0] || null;
  const totalCost = metrics.totalCost;
  const missingCost = missingRows.reduce((total, row) => total + row.costValue, 0);
  const missingCostWeight = totalCost > 0 ? (missingCost / totalCost) * 100 : null;
  const pricedCoverage = metrics.totalCount > 0 ? (metrics.pricedCount / metrics.totalCount) * 100 : null;
  const returnsBySymbol = new Map(pricedRows.map((row) => [row.symbol, portfolioRiskReturns(row.quote)]));
  const historicalRows = pricedRows.filter((row) => (returnsBySymbol.get(row.symbol)?.size || 0) >= 3);
  const volatilityRows = historicalRows.map((row) => ({ row, volatility: sampleStandardDeviation([...returnsBySymbol.get(row.symbol).values()]) })).filter((entry) => entry.volatility != null);
  const weightedVolatility = volatilityRows.length && metrics.totalMarketValue > 0
    ? volatilityRows.reduce((total, entry) => total + entry.volatility * ((entry.row.weight || 0) / 100), 0)
    : null;
  const correlations = [];
  for (let leftIndex = 0; leftIndex < historicalRows.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < historicalRows.length; rightIndex += 1) {
      const left = returnsBySymbol.get(historicalRows[leftIndex].symbol);
      const right = returnsBySymbol.get(historicalRows[rightIndex].symbol);
      const correlation = correlationFor(left, right);
      if (correlation != null) correlations.push(correlation);
    }
  }
  const averageCorrelation = correlations.length ? correlations.reduce((sum, value) => sum + value, 0) / correlations.length : null;
  const historicalSampleCount = historicalRows.length ? Math.min(...historicalRows.map((row) => returnsBySymbol.get(row.symbol).size)) : 0;
  const signals = [];
  if (topPosition?.weight >= 50) {
    signals.push({ level: "critical", title: "单一标的集中度较高", detail: `${topPosition.name} 占已计价组合 ${topPosition.weight.toFixed(1)}%，建议确认是否符合你的风险上限。` });
  } else if (topPosition?.weight >= 30) {
    signals.push({ level: "warning", title: "存在集中度暴露", detail: `${topPosition.name} 占已计价组合 ${topPosition.weight.toFixed(1)}%，可以考虑设置单标的上限。` });
  }
  if (missingRows.length > 0) {
    signals.push({ level: "info", title: "部分持仓缺少现价", detail: `${missingRows.length} 个持仓暂未返回真实行情，${missingCostWeight == null ? "暂无法计算" : `约 ${missingCostWeight.toFixed(1)}% 成本暴露`}未纳入市值和盈亏。` });
  }
  if (pricedRows.length >= 2 && historicalRows.length < 2) {
    signals.push({ level: "info", title: "波动率与相关性尚未计算", detail: "当前没有足够的真实历史序列；补齐历史数据后才会计算波动率和相关性。" });
  }
  if (historicalRows.length >= 2 && historicalSampleCount >= 3 && correlations.length > 0) {
    signals.push({ level: "info", title: "历史风险指标已计算", detail: `基于 ${historicalRows.length} 个持仓；每个可计算持仓至少有 ${historicalSampleCount} 个历史收益点，${correlations.length} 组序列存在重叠。指标为样本统计，不构成投资建议。` });
  }
  return {
    topPosition,
    topWeight: topPosition?.weight ?? null,
    pricedCoverage,
    missingCostWeight,
    weightedVolatility,
    averageCorrelation,
    correlationPairs: correlations.length,
    historicalCount: historicalRows.length,
    historicalSampleCount,
    historicalCoverage: metrics.pricedCount > 0 ? (historicalRows.length / metrics.pricedCount) * 100 : null,
    signals,
    hasEnoughDataForRiskModel: historicalRows.length >= 2 && historicalSampleCount >= 3 && correlations.length > 0,
  };
}
