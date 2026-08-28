import { CaretDown, DotsThree, Plus, X } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { stocks } from "../data/market.js";
import { useLabStore } from "../store/useLabStore.js";

export function WatchlistSidebar() {
  const selectedSymbol = useLabStore((state) => state.selectedSymbol);
  const watchlist = useLabStore((state) => state.watchlist);
  const liveQuotes = useLabStore((state) => state.liveQuotes);
  const integrationStatus = useLabStore((state) => state.integrationStatus);
  const liveDataLoading = useLabStore((state) => state.liveDataLoading);
  const selectSymbol = useLabStore((state) => state.selectSymbol);
  const addWatchlist = useLabStore((state) => state.addWatchlist);
  const removeWatchlist = useLabStore((state) => state.removeWatchlist);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [error, setError] = useState("");
  const realDataMode = Boolean(integrationStatus?.credentialConfigured && integrationStatus?.settings?.modelId);
  const previewMode = integrationStatus?.demo === true;
  const [form, setForm] = useState({ symbol: "", name: "", market: "沪深", category: "自选" });
  const groups = useMemo(() => Object.entries(watchlist.reduce((result, item) => { const label = item.market === "NASDAQ" ? "美股" : item.market || "自选"; (result[label] ||= []).push(item); return result; }, {})), [watchlist]);
  const submit = async (event) => { event.preventDefault(); setError(""); try { await addWatchlist(form); setForm({ symbol: "", name: "", market: "沪深", category: "自选" }); setDialogOpen(false); } catch (value) { setError(value instanceof Error ? value.message : String(value)); } };
  return <aside className="watchlist-sidebar">
    <div className="sidebar-heading"><h2>自选</h2><div><button aria-label="添加自选" onClick={() => setDialogOpen(true)}><Plus size={19} /></button><button aria-label="更多"><DotsThree size={20} /></button></div></div>
    <div className="watch-groups">{groups.map(([label, items]) => <section key={label}><h3>{label}<CaretDown size={13} /></h3>{items.map((item) => { const quote = liveQuotes[item.symbol] || (previewMode ? stocks[item.symbol] : null); const hasQuote = Number.isFinite(quote?.price); return <div className={selectedSymbol === item.symbol ? "watch-row selected" : "watch-row"} key={item.symbol}><button className="watch-row-main" onClick={() => selectSymbol(item.symbol)}><span><strong>{item.name}</strong><small>{item.symbol}</small></span><span className={quote?.change >= 0 ? "quote up" : "quote down"}><strong>{hasQuote ? quote.price.toFixed(2) : "—"}</strong><small>{hasQuote ? `${quote.change >= 0 ? "+" : ""}${quote.change.toFixed(2)}%` : realDataMode ? "尚未查询" : previewMode ? "预览模式" : "加载中"}</small></span></button><button className="watch-remove" aria-label="移除自选" onClick={() => { void removeWatchlist(item.symbol); }}><X size={12} /></button></div>; })}</section>)}</div>
    <div className="sidebar-status"><span className="status-dot" />{liveDataLoading ? "正在获取 QVeris 实时行情…" : realDataMode ? "Pi / QVeris 实时检查已启用" : "等待配置真实数据"}</div>
    {dialogOpen && <div className="modal-backdrop" role="presentation"><form className="modal-card sidebar-modal" onSubmit={submit}><div className="modal-heading"><h2>添加自选标的</h2><button type="button" className="icon-button" aria-label="关闭" onClick={() => setDialogOpen(false)}><X size={18} /></button></div><p className="modal-help">添加后会保存到本机，并可用于实时查询和盯盘策略。</p><label>股票代码<input autoFocus required value={form.symbol} onChange={(event) => setForm((value) => ({ ...value, symbol: event.target.value }))} placeholder="例如 AAPL / 600519" /></label><label>名称<input required value={form.name} onChange={(event) => setForm((value) => ({ ...value, name: event.target.value }))} placeholder="例如 Apple Inc." /></label><label>市场<select value={form.market} onChange={(event) => setForm((value) => ({ ...value, market: event.target.value }))}><option>沪深</option><option>深市</option><option>沪市</option><option>NASDAQ</option><option>NYSE</option><option>自定义</option></select></label><label>分类<input value={form.category} onChange={(event) => setForm((value) => ({ ...value, category: event.target.value }))} /></label>{error && <p className="form-error" role="alert">{error}</p>}<button className="primary-action" type="submit">保存自选</button></form></div>}
  </aside>;
}
