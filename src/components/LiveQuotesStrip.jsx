import { useLabStore } from "../store/useLabStore.js";

export function LiveQuotesStrip() {
  const watchlist = useLabStore((state) => state.watchlist);
  const liveQuotes = useLabStore((state) => state.liveQuotes);
  const integrationStatus = useLabStore((state) => state.integrationStatus);
  const liveDataLoading = useLabStore((state) => state.liveDataLoading);
  const liveDataError = useLabStore((state) => state.liveDataError);
  const realDataMode = Boolean(integrationStatus?.credentialConfigured && integrationStatus?.settings?.modelId);
  if (!realDataMode) return null;
  return <section className="live-quotes-strip" aria-label="QVeris 实时行情"><div className="live-quotes-heading"><strong>QVeris 实时行情</strong><span>{liveDataLoading ? "正在更新…" : liveDataError ? "更新失败" : "仅显示已返回的真实数据"}</span></div><div className="live-quotes-grid">{watchlist.map((item) => { const quote = liveQuotes[item.symbol]; const hasQuote = Number.isFinite(quote?.price); return <article key={item.symbol}><div><strong>{item.name}</strong><small>{item.symbol}</small></div><b>{hasQuote ? quote.price.toFixed(2) : "—"}</b><span className={quote?.change >= 0 ? "up" : "down"}>{Number.isFinite(quote?.change) ? `${quote.change >= 0 ? "+" : ""}${quote.change.toFixed(2)}%` : hasQuote ? "涨跌幅暂无" : "尚未返回"}</span>{hasQuote && <small>{quote.source || "QVeris"}{quote.asOf ? ` · ${quote.asOf}` : ""}</small>}</article>; })}</div>{liveDataError && <p className="live-quotes-error" role="alert">真实行情刷新失败：{liveDataError}</p>}</section>;
}
