import { memo } from "react";
import { useLabStore } from "../store/useLabStore.js";
import { hasRealDataAccess, liveDataStateCopy, resolveLiveDataState } from "../lib/dataStatus.js";
import { changeToneClass, formatPercent, formatPrice, formatQuoteFreshness, formatRefreshTime, isValidQuotePrice, quoteFreshness } from "../lib/quoteFormatting.js";
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
  const liveDataError = useLabStore((state) => state.liveDataError);
  const liveDataLastRefreshAt = useLabStore((state) => state.liveDataLastRefreshAt);
  const retryLiveData = useLabStore((state) => state.retryLiveData);
  const realDataMode = hasRealDataAccess(integrationStatus);
  const returnedCount = watchlist.filter((item) => isValidQuotePrice(liveQuotes[item.symbol]?.price)).length;
  const errorState = resolveLiveDataState({ configured: true, loading: false, error: liveDataError, receivedCount: returnedCount, totalCount: watchlist.length });
  const errorCopy = liveDataStateCopy(errorState, { receivedCount: returnedCount, totalCount: watchlist.length });
  if (!realDataMode) return null;
  return <section className="live-quotes-strip" aria-label="实时行情"><div className="live-quotes-heading"><strong>实时行情</strong><span>{liveDataLoading ? "正在更新…" : `${formatRefreshTime(liveDataLastRefreshAt)} · 自动更新`}</span></div><div className="live-quotes-grid">{watchlist.map((item) => <LiveQuoteCard key={item.symbol} item={item} quote={liveQuotes[item.symbol]} />)}</div>{liveDataError ? <DataState compact state={errorState} title={errorCopy.title} description={errorCopy.description} actionLabel="立即重试" actionDisabled={liveDataLoading} onAction={() => { void retryLiveData(); }} /> : null}</section>;
}
