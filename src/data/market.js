export const watchGroups = [
  {
    label: "A 股",
    items: [
      { symbol: "600519", name: "贵州茅台", price: 1568.88, change: 0.85, market: "沪深", category: "白酒" },
      { symbol: "300750", name: "宁德时代", price: 269.35, change: 1.18, market: "深市", category: "新能源" },
      { symbol: "600036", name: "招商银行", price: 38.7, change: -0.13, market: "沪市", category: "银行" },
      { symbol: "601318", name: "中国平安", price: 49.82, change: 0.06, market: "沪市", category: "保险" },
      { symbol: "000858", name: "五粮液", price: 137.25, change: -0.58, market: "深市", category: "白酒" },
    ],
  },
  {
    label: "美股",
    items: [
      { symbol: "AAPL", name: "Apple Inc.", price: 227.57, change: 0.62, market: "NASDAQ", category: "科技" },
      { symbol: "MSFT", name: "Microsoft", price: 525.45, change: 0.31, market: "NASDAQ", category: "科技" },
      { symbol: "NVDA", name: "NVIDIA", price: 181.35, change: -0.41, market: "NASDAQ", category: "半导体" },
    ],
  },
];

export const stocks = Object.fromEntries(watchGroups.flatMap((group) => group.items).map((item) => [item.symbol, item]));

export const intradaySeries = Array.from({ length: 42 }, (_, index) => {
  const hour = index < 21 ? 9 : 13;
  const minute = index < 21 ? 30 + index * 5 : (index - 21) * 5;
  const time = Date.UTC(2026, 7, 27, hour, minute) / 1000;
  const trend = index * 0.27;
  const wave = Math.sin(index / 2.6) * 4.1 + Math.cos(index / 5.4) * 2.2;
  return { time, value: Number((1552 + trend + wave).toFixed(2)) };
});

export const monitorEvents = [
  { id: "m1", time: "14:48", title: "批价波动监控", detail: "飞天茅台散瓶批价较昨日下跌 10 元，报 2,780 元/瓶。", severity: "warning" },
  { id: "m2", time: "13:35", title: "北向资金变化", detail: "食品饮料板块近 30 分钟净流入转正。", severity: "info" },
  { id: "m3", time: "10:22", title: "成交量放大", detail: "5 分钟成交量达到近 20 日同期均值的 1.8 倍。", severity: "info" },
];

export const skills = [
  { id: "fundamental", name: "基本面透视", description: "财报指标、估值分位与同业对比。", installed: true, category: "研究" },
  { id: "monitor", name: "智能盯盘", description: "用自然语言创建价格、成交量与事件规则。", installed: true, category: "盯盘" },
  { id: "news", name: "公告与舆情", description: "聚合公告、新闻并保留来源与时间。", installed: false, category: "资讯" },
  { id: "macro", name: "宏观日历", description: "跟踪宏观数据和政策事件的市场影响。", installed: false, category: "宏观" },
  { id: "factor", name: "因子选股", description: "透明配置质量、价值、成长与动量因子。", installed: false, category: "选股" },
  { id: "risk", name: "组合风险", description: "分析集中度、波动率与相关性暴露。", installed: false, category: "风险" },
];
