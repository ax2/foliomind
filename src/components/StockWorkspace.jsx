import { BookmarkSimple, DotsThree, SlidersHorizontal, Sparkle } from "@phosphor-icons/react";
import { stocks } from "../data/market.js";
import { useLabStore } from "../store/useLabStore.js";
import { MarketChart } from "./MarketChart.jsx";

const ranges = ["分时", "5日", "日K", "周K", "月K", "季K", "年K"];
const quoteFields = [["今开", "open"], ["昨收", "previousClose"], ["最高", "high"], ["最低", "low"], ["成交量", "volume"], ["成交额", "turnover"], ["换手率", "turnoverRate"], ["量比", "volumeRatio"], ["市盈率(TTM)", "pe"], ["市净率(LF)", "pb"], ["总市值", "marketCap"], ["流通市值", "floatMarketCap"]];

export function StockWorkspace() {
  const symbol = useLabStore((state) => state.selectedSymbol);
  const chartRange = useLabStore((state) => state.chartRange);
  const setChartRange = useLabStore((state) => state.setChartRange);
  const watchlist = useLabStore((state) => state.watchlist);
  const liveQuotes = useLabStore((state) => state.liveQuotes);
  const integrationStatus = useLabStore((state) => state.integrationStatus);
  const sendMessage = useLabStore((state) => state.sendMessage);
  const setActiveView = useLabStore((state) => state.setActiveView);
  const stock = stocks[symbol] ?? watchlist.find((item) => item.symbol === symbol) ?? { symbol, name: symbol, market: "", category: "" };
  const quote = liveQuotes[symbol];
  const realDataMode = Boolean(integrationStatus?.credentialConfigured && integrationStatus?.settings?.modelId);
  const hasQuote = Number.isFinite(quote?.price);
  const price = hasQuote ? quote.price : null;
  const change = hasQuote && Number.isFinite(quote.change) ? quote.change : null;
  return (
    <main className="stock-workspace">
      <header className="stock-header">
        <div><div className="stock-mark">{stock.name.slice(0, 1)}</div><h1>{stock.name}<span>{stock.symbol}</span></h1><small>{stock.market}</small><small>{stock.category}</small></div>
        <div><button className="live-data-button" aria-label="用 QVeris 获取实时数据" onClick={() => { setActiveView("chat"); void sendMessage(`请使用内置 qveris-finance-research Skill，严格按 Search → Inspect → Call 查询 ${stock.name}（${stock.symbol}）的最新行情、数据截至时间和来源，并明确区分实时或延迟数据。`); }}><Sparkle size={18} />实时数据</button><button aria-label="收藏"><BookmarkSimple size={20} /></button><button aria-label="更多"><DotsThree size={22} /></button></div>
      </header>
      <section className="quote-overview">
        <div className={change == null || change >= 0 ? "primary-price up" : "primary-price down"}>{price == null ? "—" : price.toFixed(2)} <span>{change == null ? (realDataMode ? "尚未查询真实行情" : "预览模式") : `${change >= 0 ? "+" : ""}${(price * change / 100).toFixed(2)}　${change >= 0 ? "+" : ""}${change.toFixed(2)}%`}</span><small>{hasQuote ? `QVeris · ${quote.source || "真实数据"}${quote.asOf ? ` · 截至 ${quote.asOf}` : ""}` : realDataMode ? "暂无已查询数据 · 点击实时数据获取" : "配置模型后显示真实行情"}</small></div>
        <div className="quote-stats">{quoteFields.map(([label, key]) => <dl key={key}><dt>{label}</dt><dd>{quote?.[key] ?? "—"}</dd></dl>)}</div>
      </section>
      <section className="chart-section">
        <div className="range-tabs">{ranges.map((range) => <button key={range} className={chartRange === range ? "active" : ""} onClick={() => setChartRange(range)}>{range}</button>)}<button className="chart-settings"><SlidersHorizontal size={18} /></button></div>
        <MarketChart series={quote?.series} />
      </section>
      <section className="fundamentals"><h3>关键指标</h3><div>{["营业收入(元)", "净利润(元)", "毛利率", "净利率", "ROE"].map((label) => <dl key={label}><dt>{label}</dt><dd>{quote?.fundamentals?.[label] ?? "—"}</dd><small>{quote?.asOf ? `截至 ${quote.asOf}` : "查询真实数据后显示"}</small></dl>)}</div></section>
      <section className="company-intro"><h3>公司简介</h3><p>{quote?.companyDescription || "尚未获取公司简介。点击“实时数据”后，Agent 会从 QVeris 返回可核验内容。"}</p></section>
      <footer className="source-line">{realDataMode ? "仅显示 QVeris 已返回的真实数据；空值不会以示例数据填充。" : "当前为界面预览；配置模型后将只显示 QVeris 返回的真实数据。"}</footer>
    </main>
  );
}
