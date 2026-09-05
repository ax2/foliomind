import { memo } from "react";
import { useLabStore } from "../store/useLabStore.js";
import { DATA_STATES, hasRealDataAccess, liveDataStateCopy, resolveLiveDataState } from "../lib/dataStatus.js";
import { changeToneClass, formatPercent, formatPrice, formatQuoteFreshness, formatRefreshTime, isValidQuotePrice, quoteForSymbol, quoteFreshness } from "../lib/quoteFormatting.js";
import { DataState } from "./DataState.jsx";

const LiveQuoteCard = memo(function LiveQuoteCard({ item, quote }) {
  const hasQuote = isValidQuotePrice(quote?.price);
  const freshness = quoteFreshness(quote?.asOf);
  return <article>
    <div><strong title={item.name}>{item.name}</strong><small>{item.symbol}</small></div>
    <b>{hasQuote ? formatPrice(quote.price) : "—"}</b>
    <span className={changeToneClass(quote?.change)}>{Number.isFinite(quote?.change) ? formatPercent(quote.change) : hasQuote ? "涨跌幅暂无" : "等待数据"}</span>
    {hasQuote && <small className={`quote-source quote-source-${freshness.state}`} title={`${quote.source || "数据服务"} · ${formatQuoteFreshness(quote.asOf, Date.now(), item.market)}`}>{quote.source || "数据服务"} · {formatQuoteFreshness(quote.asOf, Date.now(), item.market)}</small>}
  </article>;
});

export function LiveQuotesStrip() {
  const watchlist = useLabStore((state) => state.watchlist);
  const liveQuotes = useLabStore((state) => state.liveQuotes);
  const integrationStatus = useLabStore((state) => state.integrationStatus);
  const liveDataLoading = useLabStore((state) => state.liveDataLoading);
  const liveDataCompletedCount = useLabStore((state) => state.liveDataCompletedCount);
  const liveDataReceivedCount = useLabStore((state) => state.liveDataReceivedCount);
  const liveDataTotalCount = useLabStore((state) => state.liveDataTotalCount);
  const liveDataError = useLabStore((state) => state.liveDataError);
  const liveDataLastRefreshAt = useLabStore((state) => state.liveDataLastRefreshAt);
  const retryLiveData = useLabStore((state) => state.retryLiveData);
  const realDataMode = hasRealDataAccess(integrationStatus);
  const returnedCount = watchlist.filter((item) => isValidQuotePrice(quoteForSymbol(liveQuotes, item.symbol)?.price)).length;
  const staleQuoteCount = watchlist.reduce((count, item) => {
    const quote = quoteForSymbol(liveQuotes, item.symbol);
    return count + (isValidQuotePrice(quote?.price) && quoteFreshness(quote?.asOf).state === "stale" ? 1 : 0);
  }, 0);
  const errorState = resolveLiveDataState({ configured: true, loading: false, error: liveDataError, receivedCount: returnedCount, totalCount: watchlist.length, staleCount: staleQuoteCount });
  const errorCopy = liveDataStateCopy(errorState, { receivedCount: returnedCount, totalCount: watchlist.length });
  if (!realDataMode) return null;
  const progressCopy = liveDataLoading && liveDataTotalCount ? `正在更新 · ${liveDataCompletedCount}/${liveDataTotalCount} 完成 · ${liveDataReceivedCount} 个成功` : liveDataLoading ? "正在更新…" : `${formatRefreshTime(liveDataLastRefreshAt)} · 自动更新`;
  return <section className="live-quotes-strip" aria-label="实时行情"><div className="live-quotes-heading"><strong>实时行情</strong><span aria-live="polite">{progressCopy}</span></div><div className="live-quotes-grid">{watchlist.map((item) => <LiveQuoteCard key={item.symbol} item={item} quote={quoteForSymbol(liveQuotes, item.symbol)} />)}</div>{(liveDataError || errorState === DATA_STATES.STALE) ? <DataState compact state={errorState} title={errorCopy.title} description={errorCopy.description} actionLabel="立即重试" actionDisabled={liveDataLoading} onAction={() => { void retryLiveData(); }} /> : null}</section>;
}
