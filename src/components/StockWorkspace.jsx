import { ArrowsClockwise, BookmarkSimple, DotsThree, SlidersHorizontal, Sparkle } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { stocks } from "../data/market.js";
import { changeToneClass, formatPercent, formatPrice, formatQuoteField, formatQuoteFreshness, formatRefreshTime, quoteFreshness } from "../lib/quoteFormatting.js";
import { hasRealDataAccess } from "../lib/dataStatus.js";
import { useLabStore } from "../store/useLabStore.js";
import { EvidenceDrawer } from "./EvidenceDrawer.jsx";
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
  const selectedQuoteLoading = useLabStore((state) => state.selectedQuoteLoading);
  const liveDataError = useLabStore((state) => state.liveDataError);
  const liveDataLastRefreshAt = useLabStore((state) => state.liveDataLastRefreshAt);
  const refreshLiveData = useLabStore((state) => state.refreshLiveData);
  const refreshSelectedQuote = useLabStore((state) => state.refreshSelectedQuote);
  const addWatchlist = useLabStore((state) => state.addWatchlist);
  const removeWatchlist = useLabStore((state) => state.removeWatchlist);
  const integrationStatus = useLabStore((state) => state.integrationStatus);
  const sendMessage = useLabStore((state) => state.sendMessage);
  const setActiveView = useLabStore((state) => state.setActiveView);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [chartSettingsOpen, setChartSettingsOpen] = useState(false);
  const [showGrid, setShowGrid] = useState(true);
  const [showMovingAverage, setShowMovingAverage] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionNotice, setActionNotice] = useState("");
  const stock = watchlist.find((item) => item.symbol === symbol) ?? stocks[symbol] ?? { symbol, name: symbol, market: "", category: "" };
  const quote = liveQuotes[symbol];
  const realDataMode = hasRealDataAccess(integrationStatus);
  const isWatched = watchlist.some((item) => item.symbol === symbol);
  useEffect(() => { if (realDataMode && userStateLoaded && liveDataLastRefreshAt && !liveDataLoading && !quoteDetailsLoading[symbol] && !quoteDetailsLoaded[symbol]) void refreshQuoteDetails(symbol); }, [realDataMode, userStateLoaded, liveDataLastRefreshAt, liveDataLoading, symbol, refreshQuoteDetails, quoteDetailsLoading, quoteDetailsLoaded]);
  useEffect(() => { if (realDataMode && userStateLoaded && liveDataLastRefreshAt && !liveDataLoading && quoteDetailsLoaded[symbol] && !quoteSeriesLoading[symbol]?.[chartRange] && !quoteSeriesLoaded[symbol]?.[chartRange]) void refreshQuoteSeries(symbol, chartRange); }, [realDataMode, userStateLoaded, liveDataLastRefreshAt, liveDataLoading, symbol, chartRange, refreshQuoteSeries, quoteDetailsLoaded, quoteSeriesLoading, quoteSeriesLoaded]);
  const hasQuote = Number.isFinite(quote?.price);
  const price = hasQuote ? quote.price : null;
  const change = hasQuote && Number.isFinite(quote.change) ? quote.change : null;
  const changeAmount = hasQuote && Number.isFinite(quote.changeAmount) ? quote.changeAmount : change != null && Number.isFinite(quote.previousClose) ? price - Number(quote.previousClose) : null;
  const freshness = quoteFreshness(quote?.asOf);
  const series = quote?.seriesByRange?.[chartRange] || (chartRange === "分时" ? quote?.series : []) || [];
  const provider = integrationStatus?.settings?.dataProvider || "qveris_finance";
  const channel = integrationStatus?.settings?.dataChannel || "qveris-cap";
  const healthState = !realDataMode ? "preview" : liveDataLoading ? "loading" : hasQuote ? freshness.state : liveDataError ? "error" : "empty";
  const healthTitle = { preview: "预览模式", loading: "正在获取真实行情", fresh: "真实行情 · 数据新鲜", stale: "真实行情 · 可能已延迟", unknown: "真实行情 · 数据时间未知", error: "暂未获取到行情", empty: "等待真实行情" }[healthState];
  const healthDetail = hasQuote ? `${provider} · MKT.L1.RT · ${formatQuoteFreshness(quote.asOf)}` : realDataMode ? `${provider} · ${channel}${liveDataLastRefreshAt ? ` · 最近尝试 ${formatRefreshTime(liveDataLastRefreshAt)}` : ""}` : "保存 API Key 后显示真实行情";
  const requestAgentAnalysis = () => {
    setMoreOpen(false);
    setActiveView("chat");
    void sendMessage(`请使用内置 foliomind_data 直连 ${provider} CAP 查询 ${stock.name}（${stock.symbol}）的最新行情、数据截至时间和来源；只返回真实数据，不要编造。`);
  };
  const toggleWatchlist = async () => {
    if (actionBusy) return;
    setActionBusy(true);
    setActionNotice("");
    try {
      if (isWatched) {
        await removeWatchlist(symbol);
        setActionNotice("已从自选移除");
      } else {
        await addWatchlist(stock);
        setActionNotice("已加入自选");
      }
    } catch (error) {
      setActionNotice(error?.message || "收藏操作暂时失败");
    } finally {
      setActionBusy(false);
    }
  };
  const copySymbol = async () => {
    setMoreOpen(false);
    try {
      if (!navigator.clipboard?.writeText) throw new Error("当前环境不支持复制");
      await navigator.clipboard.writeText(symbol);
      setActionNotice(`已复制 ${symbol}`);
    } catch (error) {
      setActionNotice(error?.message || "复制失败，请手动选择代码");
    }
  };
  const refreshCurrentQuote = () => {
    setMoreOpen(false);
    if (realDataMode) void refreshSelectedQuote(symbol);
    else setActiveView("settings");
  };
  const openEvidence = () => {
    setMoreOpen(false);
    setEvidenceOpen(true);
  };
  const openMonitor = () => {
    setMoreOpen(false);
    setActiveView("monitor");
  };
  return (
    <main className="stock-workspace">
      <header className="stock-header">
        <div><div className="stock-mark">{stock.name.slice(0, 1)}</div><h1>{stock.name}<span>{stock.symbol}</span></h1><small>{stock.market}</small><small>{stock.category}</small></div>
        <div className="stock-header-actions"><button className="live-data-button" aria-label="获取实时数据" disabled={Boolean(selectedQuoteLoading?.[symbol])} onClick={() => { if (realDataMode) void refreshSelectedQuote(symbol); else setActiveView("settings"); }}><ArrowsClockwise size={17} />{!realDataMode ? "去设置" : selectedQuoteLoading?.[symbol] ? "获取中…" : liveDataLoading ? "后台更新中" : hasQuote ? "刷新行情" : "获取实时数据"}</button><button className="agent-data-button" aria-label="交给 Agent 查询" onClick={requestAgentAnalysis}><Sparkle size={16} />交给 Agent</button><button className={isWatched ? "stock-bookmark active" : "stock-bookmark"} aria-label={isWatched ? "取消收藏" : "收藏"} aria-pressed={isWatched} disabled={actionBusy} onClick={() => { void toggleWatchlist(); }}><BookmarkSimple size={20} weight={isWatched ? "fill" : "regular"} /></button><div className="stock-more-wrap"><button className="stock-more-button" aria-label="更多" aria-expanded={moreOpen} aria-controls="stock-more-menu" onClick={() => setMoreOpen((value) => !value)}><DotsThree size={22} /></button>{moreOpen && <div className="stock-more-menu" id="stock-more-menu" role="menu" aria-label="更多操作"><button type="button" role="menuitem" onClick={refreshCurrentQuote}>刷新当前行情</button><button type="button" role="menuitem" onClick={openEvidence}>查看来源与证据</button><button type="button" role="menuitem" onClick={openMonitor}>打开盯盘</button><button type="button" role="menuitem" onClick={copySymbol}>复制证券代码</button></div>}</div>{actionNotice && <span className="stock-action-notice" role="status">{actionNotice}</span>}</div>
      </header>
      <section className={`data-health-strip data-health-${healthState}`} aria-label="行情数据状态">
        <span className="data-health-dot" aria-hidden="true" />
        <div className="data-health-copy"><strong>{healthTitle}</strong><small>{healthDetail}</small></div>
        <button className="data-health-action" disabled={healthState === "loading"} onClick={() => { if (realDataMode) void refreshLiveData(); else setActiveView("settings"); }}><ArrowsClockwise size={14} />{realDataMode ? healthState === "loading" ? "更新中…" : hasQuote ? "刷新" : "重新获取" : "去设置"}</button><button className="data-health-evidence" type="button" onClick={() => setEvidenceOpen(true)}>来源与证据</button>
      </section>
      <section className="quote-overview">
        <div className={`primary-price ${changeToneClass(change)}`}>{price == null ? "—" : formatPrice(price)} <span>{change == null ? (realDataMode ? "尚未查询真实行情" : "预览模式") : `${changeAmount == null ? "" : `${changeAmount >= 0 ? "+" : ""}${formatPrice(changeAmount)}　`}${formatPercent(change)}`}</span><small className={hasQuote ? `quote-source quote-source-${freshness.state}` : ""}>{hasQuote ? `数据源 · ${quote.source || "真实数据"} · ${formatQuoteFreshness(quote.asOf)}` : realDataMode ? liveDataLoading ? "正在查询真实行情" : "暂无已查询数据 · 点击实时数据获取" : "配置模型后显示真实行情"}</small></div>
        <div className="quote-stats">{quoteFields.map(([label, key]) => <dl key={key}><dt>{label}</dt><dd>{formatQuoteField(key, quote?.[key])}</dd></dl>)}</div>
      </section>
      <section className="chart-section">
        <div className="range-tabs">{ranges.map((range) => <button key={range} className={chartRange === range ? "active" : ""} onClick={() => setChartRange(range)}>{range}</button>)}<div className="chart-settings-wrap"><button type="button" className="chart-settings" aria-label="图表设置" aria-expanded={chartSettingsOpen} aria-controls="chart-settings-popover" onClick={() => setChartSettingsOpen((value) => !value)}><SlidersHorizontal size={18} /></button>{chartSettingsOpen && <div id="chart-settings-popover" className="chart-settings-popover" role="group" aria-label="图表设置"><strong>图表设置</strong><label><input type="checkbox" checked={showGrid} onChange={(event) => setShowGrid(event.target.checked)} />显示网格线</label><label><input type="checkbox" checked={showMovingAverage} onChange={(event) => setShowMovingAverage(event.target.checked)} />显示 MA5</label><button type="button" className="notification-link" onClick={() => { setShowGrid(true); setShowMovingAverage(false); }}>恢复默认</button></div>}</div></div>
        <MarketChart series={series} range={chartRange} showGrid={showGrid} showMovingAverage={showMovingAverage} loading={Boolean(quoteDetailsLoading[symbol] || quoteSeriesLoading[symbol]?.[chartRange])} error={quoteSeriesError[symbol]?.[chartRange] || ""} onRetry={() => { void retryQuoteSeries(symbol, chartRange); }} />
      </section>
      <section className="fundamentals"><h3>关键指标 <small>{quote?.reportPeriod ? `报告期 ${quote.reportPeriod}` : "真实财务数据"}</small></h3><div>{[["营业收入", "revenue"], ["净利润", "netProfit"], ["毛利率", "grossMargin"], ["净利率", "netMargin"], ["ROE", "roe"]].map(([label, key]) => <dl key={key}><dt>{label}</dt><dd>{formatQuoteField(key, quote?.fundamentals?.[key] ?? quote?.fundamentals?.[label])}</dd><small>{quote?.reportPeriod ? `报告期 ${quote.reportPeriod}` : "查询详情后显示"}</small></dl>)}</div></section>
      <section className="company-intro"><h3>公司简介</h3><p>{quote?.companyDescription || (quoteDetailsError[symbol] ? "公司资料暂时未返回，系统会稍后自动重试。" : realDataMode ? liveDataLoading || !liveDataLastRefreshAt ? "正在获取公司简介；没有返回时保持空状态。" : "暂无已返回的真实公司简介。" : "配置数据服务后显示真实公司简介。")}</p>{quoteDetailsError[symbol] && <button onClick={() => { void retryQuoteDetails(symbol); }}>重新获取详情</button>}</section>
      <footer className="source-line">{realDataMode ? "仅显示已返回的真实数据；空值不会以示例数据填充。" : "当前为界面预览；保存 API Key 后将只显示真实数据。"}</footer>
      <EvidenceDrawer open={evidenceOpen} onClose={() => setEvidenceOpen(false)} quote={quote} symbol={symbol} name={stock.name} provider={realDataMode ? provider : "未配置"} channel={realDataMode ? channel : "未配置"} lastRefreshAt={liveDataLastRefreshAt} loading={Boolean(selectedQuoteLoading?.[symbol])} refreshLabel={realDataMode ? "重新获取当前行情" : "去设置"} onRefresh={() => realDataMode ? refreshSelectedQuote(symbol) : setActiveView("settings")} />
    </main>
  );
}
