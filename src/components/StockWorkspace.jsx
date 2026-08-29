import { BookmarkSimple, DotsThree, SlidersHorizontal, Sparkle } from "@phosphor-icons/react";
import { useEffect } from "react";
import { stocks } from "../data/market.js";
import { formatPercent, formatPrice, formatQuoteField } from "../lib/quoteFormatting.js";
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
  const userStateLoaded = useLabStore((state) => state.userStateLoaded);
  const refreshQuoteDetails = useLabStore((state) => state.refreshQuoteDetails);
  const refreshQuoteSeries = useLabStore((state) => state.refreshQuoteSeries);
  const retryQuoteDetails = useLabStore((state) => state.retryQuoteDetails);
  const retryQuoteSeries = useLabStore((state) => state.retryQuoteSeries);
  const quoteDetailsLoading = useLabStore((state) => state.quoteDetailsLoading);
  const quoteDetailsLoaded = useLabStore((state) => state.quoteDetailsLoaded);
  const quoteDetailsError = useLabStore((state) => state.quoteDetailsError);
  const quoteSeriesLoading = useLabStore((state) => state.quoteSeriesLoading);
  const quoteSeriesLoaded = useLabStore((state) => state.quoteSeriesLoaded);
  const quoteSeriesError = useLabStore((state) => state.quoteSeriesError);
  const liveDataLoading = useLabStore((state) => state.liveDataLoading);
  const liveDataLastRefreshAt = useLabStore((state) => state.liveDataLastRefreshAt);
  const integrationStatus = useLabStore((state) => state.integrationStatus);
  const sendMessage = useLabStore((state) => state.sendMessage);
  const setActiveView = useLabStore((state) => state.setActiveView);
  const stock = stocks[symbol] ?? watchlist.find((item) => item.symbol === symbol) ?? { symbol, name: symbol, market: "", category: "" };
  const quote = liveQuotes[symbol];
  const realDataMode = Boolean(integrationStatus?.credentialConfigured && integrationStatus?.settings?.modelId);
  useEffect(() => { if (realDataMode && userStateLoaded && liveDataLastRefreshAt && !liveDataLoading && !quoteDetailsLoading[symbol] && !quoteDetailsLoaded[symbol]) void refreshQuoteDetails(symbol); }, [realDataMode, userStateLoaded, liveDataLastRefreshAt, liveDataLoading, symbol, refreshQuoteDetails, quoteDetailsLoading, quoteDetailsLoaded]);
  useEffect(() => { if (realDataMode && userStateLoaded && liveDataLastRefreshAt && !liveDataLoading && quoteDetailsLoaded[symbol] && !quoteSeriesLoading[symbol]?.[chartRange] && !quoteSeriesLoaded[symbol]?.[chartRange]) void refreshQuoteSeries(symbol, chartRange); }, [realDataMode, userStateLoaded, liveDataLastRefreshAt, liveDataLoading, symbol, chartRange, refreshQuoteSeries, quoteDetailsLoaded, quoteSeriesLoading, quoteSeriesLoaded]);
  const hasQuote = Number.isFinite(quote?.price);
  const price = hasQuote ? quote.price : null;
  const change = hasQuote && Number.isFinite(quote.change) ? quote.change : null;
  const changeAmount = hasQuote && Number.isFinite(quote.changeAmount) ? quote.changeAmount : change != null && Number.isFinite(quote.previousClose) ? price - Number(quote.previousClose) : null;
  const series = quote?.seriesByRange?.[chartRange] || (chartRange === "分时" ? quote?.series : []) || [];
  return (
    <main className="stock-workspace">
      <header className="stock-header">
        <div><div className="stock-mark">{stock.name.slice(0, 1)}</div><h1>{stock.name}<span>{stock.symbol}</span></h1><small>{stock.market}</small><small>{stock.category}</small></div>
        <div><button className="live-data-button" aria-label="获取实时数据" onClick={() => { setActiveView("chat"); void sendMessage(`请使用已配置的金融数据工具，严格按 Search → Inspect → Call 查询 ${stock.name}（${stock.symbol}）的最新行情、数据截至时间和来源，并明确区分实时或延迟数据。`); }}><Sparkle size={18} />实时数据</button><button aria-label="收藏"><BookmarkSimple size={20} /></button><button aria-label="更多"><DotsThree size={22} /></button></div>
      </header>
      <section className="quote-overview">
        <div className={change == null || change >= 0 ? "primary-price up" : "primary-price down"}>{price == null ? "—" : formatPrice(price)} <span>{change == null ? (realDataMode ? "尚未查询真实行情" : "预览模式") : `${changeAmount == null ? "" : `${changeAmount >= 0 ? "+" : ""}${formatPrice(changeAmount)}　`}${formatPercent(change)}`}</span><small>{hasQuote ? `数据源 · ${quote.source || "真实数据"}${quote.asOf ? ` · 截至 ${quote.asOf}` : ""}` : realDataMode ? liveDataLoading ? "正在查询真实行情" : "暂无已查询数据 · 点击实时数据获取" : "配置模型后显示真实行情"}</small></div>
        <div className="quote-stats">{quoteFields.map(([label, key]) => <dl key={key}><dt>{label}</dt><dd>{formatQuoteField(key, quote?.[key])}</dd></dl>)}</div>
      </section>
      <section className="chart-section">
        <div className="range-tabs">{ranges.map((range) => <button key={range} className={chartRange === range ? "active" : ""} onClick={() => setChartRange(range)}>{range}</button>)}<button className="chart-settings"><SlidersHorizontal size={18} /></button></div>
        <MarketChart series={series} range={chartRange} loading={Boolean(quoteDetailsLoading[symbol] || quoteSeriesLoading[symbol]?.[chartRange])} error={quoteSeriesError[symbol]?.[chartRange] || ""} onRetry={() => { void retryQuoteSeries(symbol, chartRange); }} />
      </section>
      <section className="fundamentals"><h3>关键指标 <small>{quote?.reportPeriod ? `报告期 ${quote.reportPeriod}` : "真实财务数据"}</small></h3><div>{[["营业收入", "revenue"], ["净利润", "netProfit"], ["毛利率", "grossMargin"], ["净利率", "netMargin"], ["ROE", "roe"]].map(([label, key]) => <dl key={key}><dt>{label}</dt><dd>{formatQuoteField(key, quote?.fundamentals?.[key] ?? quote?.fundamentals?.[label])}</dd><small>{quote?.reportPeriod ? `报告期 ${quote.reportPeriod}` : "查询详情后显示"}</small></dl>)}</div></section>
      <section className="company-intro"><h3>公司简介</h3><p>{quote?.companyDescription || (quoteDetailsError[symbol] ? "公司资料暂时未返回，系统会稍后自动重试。" : realDataMode ? liveDataLoading || !liveDataLastRefreshAt ? "正在获取公司简介；没有返回时保持空状态。" : "暂无已返回的真实公司简介。" : "配置数据服务后显示真实公司简介。")}</p>{quoteDetailsError[symbol] && <button onClick={() => { void retryQuoteDetails(symbol); }}>重新获取详情</button>}</section>
      <footer className="source-line">{realDataMode ? "仅显示已返回的真实数据；空值不会以示例数据填充。" : "当前为界面预览；配置模型后将只显示真实数据。"}</footer>
    </main>
  );
}
