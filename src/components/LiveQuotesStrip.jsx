import { useLabStore } from "../store/useLabStore.js";
import { formatPercent, formatPrice, formatRefreshTime } from "../lib/quoteFormatting.js";

export function LiveQuotesStrip() {
  const watchlist = useLabStore((state) => state.watchlist);
  const liveQuotes = useLabStore((state) => state.liveQuotes);
  const integrationStatus = useLabStore((state) => state.integrationStatus);
  const liveDataLoading = useLabStore((state) => state.liveDataLoading);
  const liveDataError = useLabStore((state) => state.liveDataError);
  const liveDataLastRefreshAt = useLabStore((state) => state.liveDataLastRefreshAt);
  const retryLiveData = useLabStore((state) => state.retryLiveData);
  const realDataMode = Boolean(integrationStatus?.credentialConfigured && integrationStatus?.settings?.modelId);
  if (!realDataMode) return null;
  return <section className="live-quotes-strip" aria-label="实时行情"><div className="live-quotes-heading"><strong>实时行情</strong><span>{liveDataLoading ? "正在更新…" : `${formatRefreshTime(liveDataLastRefreshAt)} · 自动更新`}</span></div><div className="live-quotes-grid">{watchlist.map((item) => { const quote = liveQuotes[item.symbol]; const hasQuote = Number.isFinite(quote?.price); return <article key={item.symbol}><div><strong>{item.name}</strong><small>{item.symbol}</small></div><b>{hasQuote ? formatPrice(quote.price) : "—"}</b><span className={quote?.change >= 0 ? "up" : "down"}>{Number.isFinite(quote?.change) ? formatPercent(quote.change) : hasQuote ? "涨跌幅暂无" : "等待数据"}</span>{hasQuote && <small>{quote.source || "数据服务"}{quote.asOf ? ` · ${quote.asOf}` : ""}</small>}</article>; })}</div>{liveDataError && <div className="live-quotes-error" role="status"><span>部分标的暂未更新，系统会稍后自动重试。</span><button className="secondary-button" disabled={liveDataLoading} onClick={() => { void retryLiveData(); }}>立即重试</button></div>}</section>;
}
