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
];

export const defaultMonitorRules = [
  { id: "r1", symbol: "600519", strategyId: "price_change", threshold: 3, intervalSeconds: 300, enabled: true },
  { id: "r2", symbol: "300750", strategyId: "news_risk", threshold: 1, intervalSeconds: 600, enabled: true },
];

export function strategyFor(id) {
  return monitorStrategies.find((strategy) => strategy.id === id) ?? monitorStrategies[0];
}
