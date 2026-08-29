import { strategyFor } from "../data/monitorStrategies.js";

export const CONDITION_OPERATORS = Object.freeze([
  { id: "abs_gte", label: "绝对值大于等于" },
  { id: "gte", label: "大于等于" },
  { id: "lte", label: "小于等于" },
  { id: "eq", label: "等于" },
]);

export const CONDITION_TYPES = Object.freeze([
  {
    id: "price_change",
    name: "价格触发",
    description: "涨跌幅达到阈值",
    field: "changePercent",
    fieldLabel: "涨跌幅",
    unit: "%",
    valueType: "number",
    operators: ["abs_gte", "gte", "lte", "eq"],
    defaultOperator: "abs_gte",
    defaultValue: 3,
    strategyId: "price_change",
  },
  {
    id: "volume_spike",
    name: "量能异动",
    description: "量比超过近期基准",
    field: "volumeRatio",
    fieldLabel: "量比",
    unit: "倍",
    valueType: "number",
    operators: ["gte", "lte", "eq"],
    defaultOperator: "gte",
    defaultValue: 2.5,
    strategyId: "volume_spike",
  },
  {
    id: "technical",
    name: "技术形态",
    description: "均线交叉或创新高低",
    field: "technicalSignal",
    fieldLabel: "形态",
    unit: "",
    valueType: "select",
    operators: ["eq"],
    options: [
      { value: "golden_cross", label: "均线金叉" },
      { value: "death_cross", label: "均线死叉" },
      { value: "new_high", label: "创新高" },
      { value: "new_low", label: "创新低" },
    ],
    defaultOperator: "eq",
    defaultValue: "golden_cross",
    strategyId: "price_change",
  },
  {
    id: "core_event",
    name: "核心事件",
    description: "公告、财报或股东变动",
    field: "eventCount",
    fieldLabel: "新事件数",
    unit: "条",
    valueType: "number",
    operators: ["gte", "lte", "eq"],
    defaultOperator: "gte",
    defaultValue: 1,
    strategyId: "news_risk",
  },
  {
    id: "capital_flow",
    name: "主力资金",
    description: "主力净流入或流出",
    field: "mainNetInflow",
    fieldLabel: "主力净流入",
    unit: "元",
    valueType: "number",
    operators: ["gte", "lte", "eq"],
    defaultOperator: "gte",
    defaultValue: 100000000,
    strategyId: "volume_spike",
  },
  {
    id: "sentiment",
    name: "产业舆情",
    description: "行业政策和产业链舆情",
    field: "sentiment",
    fieldLabel: "舆情方向",
    unit: "",
    valueType: "select",
    operators: ["eq"],
    options: [
      { value: "negative", label: "负面" },
      { value: "neutral", label: "中性" },
      { value: "positive", label: "正面" },
    ],
    defaultOperator: "eq",
    defaultValue: "negative",
    strategyId: "news_risk",
  },
]);

const CONDITION_TYPE_MAP = new Map(CONDITION_TYPES.map((type) => [type.id, type]));
const OPERATOR_MAP = new Map(CONDITION_OPERATORS.map((operator) => [operator.id, operator]));
const LEGACY_TYPE_ALIAS = Object.freeze({ news_risk: "core_event" });

function createConditionId() {
  if (typeof globalThis.crypto?.randomUUID === "function") return `condition-${globalThis.crypto.randomUUID()}`;
  return `condition-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function conditionTypeFor(id) {
  return CONDITION_TYPE_MAP.get(LEGACY_TYPE_ALIAS[id] || id) || CONDITION_TYPES[0];
}

export function conditionOperatorFor(id) {
  return OPERATOR_MAP.get(id) || CONDITION_OPERATORS[0];
}

export function conditionOperatorsFor(typeId) {
  const type = conditionTypeFor(typeId);
  const allowed = type.operators || CONDITION_OPERATORS.map((operator) => operator.id);
  return CONDITION_OPERATORS.filter((operator) => allowed.includes(operator.id));
}

export function defaultConditionFor(typeId = "price_change") {
  const type = conditionTypeFor(typeId);
  return { id: createConditionId(), type: type.id, field: type.field, operator: type.defaultOperator, value: type.defaultValue };
}

function normalizeValue(type, value) {
  if (type.valueType === "number") {
    const number = Number(value);
    return Number.isFinite(number) ? number : type.defaultValue;
  }
  const string = String(value ?? "");
  return type.options?.some((option) => option.value === string) ? string : type.defaultValue;
}

export function normalizeCondition(input = {}, index = 0) {
  const type = conditionTypeFor(input.type);
  const operator = conditionOperatorsFor(type.id).some((candidate) => candidate.id === input.operator) ? input.operator : type.defaultOperator;
  return {
    id: String(input.id || `condition-${index + 1}`),
    type: type.id,
    field: type.field,
    operator,
    value: normalizeValue(type, input.value),
  };
}

export function conditionsForRule(rule = {}) {
  if (Array.isArray(rule.conditions) && rule.conditions.length) return rule.conditions.map(normalizeCondition);
  const strategy = strategyFor(rule.strategyId);
  return [normalizeCondition({ type: LEGACY_TYPE_ALIAS[strategy.id] || strategy.id, value: rule.threshold }, 0)];
}

export function normalizeConditions(input, fallbackStrategyId = "price_change") {
  const values = Array.isArray(input) && input.length ? input : [{ type: fallbackStrategyId }];
  return values.slice(0, 6).map(normalizeCondition);
}

export function conditionSummary(condition = {}) {
  const normalized = normalizeCondition(condition);
  const type = conditionTypeFor(normalized.type);
  const operator = conditionOperatorFor(normalized.operator);
  const value = type.valueType === "select" ? type.options.find((option) => option.value === normalized.value)?.label || normalized.value : `${normalized.value}${type.unit}`;
  return `${type.fieldLabel} ${operator.label} ${value}`;
}

export function ruleConditionSummary(rule = {}) {
  const conditions = conditionsForRule(rule);
  const logic = String(rule.logic || "AND").toUpperCase() === "OR" ? "或" : "且";
  return conditions.map(conditionSummary).join(` ${logic} `);
}

function comparison(left, operator, right) {
  if (operator === "abs_gte") return Math.abs(left) >= right;
  if (operator === "gte") return left >= right;
  if (operator === "lte") return left <= right;
  return left === right;
}

function technicalSignalFromSeries(series) {
  const values = (Array.isArray(series) ? series : []).map((point) => Number(point?.close ?? point?.value ?? point?.price)).filter(Number.isFinite);
  if (values.length < 2) return null;
  const latest = values.at(-1);
  const previous = values.slice(0, -1);
  if (latest > Math.max(...previous)) return "new_high";
  if (latest < Math.min(...previous)) return "new_low";
  if (values.length < 20) return null;
  const average = (items) => items.reduce((sum, value) => sum + value, 0) / items.length;
  const shortNow = average(values.slice(-5));
  const longNow = average(values.slice(-20));
  const shortBefore = average(values.slice(-6, -1));
  const longBefore = average(values.slice(-21, -1));
  if (shortBefore <= longBefore && shortNow > longNow) return "golden_cross";
  if (shortBefore >= longBefore && shortNow < longNow) return "death_cross";
  return null;
}

/**
 * Evaluate only fields already present in a real quote response. Missing fields
 * return null so the caller can defer to the data/AI channel instead of
 * treating missing data as a false or fabricated signal.
 */
export function evaluateCondition(condition, quote = {}) {
  const normalized = normalizeCondition(condition);
  const type = conditionTypeFor(normalized.type);
  const value = type.field === "changePercent"
    ? quote?.changePercent ?? quote?.change
    : type.field === "technicalSignal"
      ? quote?.technicalSignal ?? technicalSignalFromSeries(quote?.series)
      : quote?.[type.field];
  if (value === null || value === undefined || value === "") return null;
  if (type.valueType === "number") {
    const left = Number(value);
    const right = Number(normalized.value);
    return Number.isFinite(left) && Number.isFinite(right) ? comparison(left, normalized.operator, right) : null;
  }
  return normalized.operator === "eq" ? String(value) === String(normalized.value) : null;
}

export function evaluateRuleConditions(rule = {}, quote = {}) {
  const results = conditionsForRule(rule).map((condition) => evaluateCondition(condition, quote));
  const logic = String(rule.logic || "AND").toUpperCase() === "OR" ? "OR" : "AND";
  const triggered = logic === "OR"
    ? results.some((result) => result === true) ? true : results.every((result) => result === false) ? false : null
    : results.some((result) => result === false) ? false : results.every((result) => result === true) ? true : null;
  return { known: typeof triggered === "boolean", triggered, results, logic };
}

export function conditionPrompt(rule = {}) {
  const conditions = conditionsForRule(rule).map((condition) => ({
    type: conditionTypeFor(condition.type).id,
    field: conditionTypeFor(condition.type).field,
    operator: condition.operator,
    value: condition.value,
  }));
  const logic = String(rule.logic || "AND").toUpperCase() === "OR" ? "OR" : "AND";
  return `按以下真实数据条件${logic === "AND" ? "全部满足（AND）" : "任一满足（OR）"}判断：${JSON.stringify(conditions)}。缺少条件所需字段时返回 triggered=null，不要用示例数据推断。`;
}
