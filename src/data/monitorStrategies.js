export const monitorStrategies = [
  {
    id: "price_change",
    name: "价格异动",
    description: "当最新涨跌幅达到阈值时提醒",
    defaultThreshold: 3,
    unit: "%",
    prompt: "检查最新涨跌幅是否达到阈值，并给出最新价格、涨跌幅、数据截至时间和来源。",
  },
  {
    id: "price_level",
    name: "价格水平",
    description: "当最新价达到或突破指定价位时提醒",
    defaultThreshold: 100,
    unit: "",
    prompt: "检查最新价是否达到或突破指定价位；说明比较方向、最新价、目标价、数据截至时间和来源。",
  },
  {
    id: "volume_spike",
    name: "成交量异常监控",
    description: "当成交量超过近期均值时提醒",
    defaultThreshold: 1.8,
    unit: "倍",
    prompt: "检查成交量相对近期均值是否达到阈值，并给出比较口径、数据截至时间和来源。",
  },
  {
    id: "news_risk",
    name: "公告与舆情",
    description: "发现可能影响标的的公告或重大新闻时提醒",
    defaultThreshold: 1,
    unit: "条",
    prompt: "检查最近是否有可能影响标的的公告、监管信息或重大新闻，并给出发布时间、来源和影响判断。",
  },
  {
    id: "technical",
    name: "技术形态",
    description: "基于真实历史序列识别均线交叉与新高/新低",
    defaultThreshold: 0,
    unit: "",
    prompt: "仅基于真实历史序列检查均线金叉、死叉、新高或新低，不足数据时返回未知并说明覆盖范围。",
  },
  {
    id: "core_event",
    name: "核心事件",
    description: "发现财报、公告和公司事件",
    defaultThreshold: 1,
    unit: "条",
    prompt: "检查最近是否有真实公司公告、财报或股东事件，并给出发布时间、来源和影响判断。",
  },
  {
    id: "capital_flow",
    name: "主力资金",
    description: "监控真实资金流向变化",
    defaultThreshold: 100000000,
    unit: "元",
    prompt: "检查真实资金流字段是否达到阈值，并给出统计口径、数据截至时间和来源。",
  },
  {
    id: "sentiment",
    name: "产业舆情",
    description: "监控行业政策与产业链舆情",
    defaultThreshold: 0,
    unit: "",
    prompt: "检查真实标注新闻与产业舆情方向，不得从缺失新闻推断情绪。",
  },
];

// New installations must not create billable background checks before the
// user explicitly configures an alert. Existing persisted rules are kept by
// the state migration in userStateSchema.js.
export const defaultMonitorRules = [];

export const monitorTemplates = [
  { id: "workday", name: "上班族盯盘", description: "价格大幅波动或公告出现", logic: "OR", conditions: [{ type: "price_change", operator: "abs_gte", value: 3 }, { type: "core_event", operator: "gte", value: 1 }], intervalSeconds: 300 },
  { id: "midterm", name: "中线持仓", description: "价格波动且量能放大", logic: "AND", conditions: [{ type: "price_change", operator: "abs_gte", value: 4 }, { type: "volume_spike", operator: "gte", value: 2.5 }], intervalSeconds: 600 },
  { id: "risk", name: "回撤防守", description: "跌幅达到风控阈值", logic: "AND", conditions: [{ type: "price_change", operator: "lte", value: -5 }], intervalSeconds: 300 },
  { id: "events", name: "事件雷达", description: "公告、财报和产业舆情", logic: "OR", conditions: [{ type: "core_event", operator: "gte", value: 1 }, { type: "sentiment", operator: "eq", value: "negative" }], intervalSeconds: 1800 },
];

export function strategyFor(id) {
  return monitorStrategies.find((strategy) => strategy.id === id) ?? monitorStrategies[0];
}
