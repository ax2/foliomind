import { DotsThree, Plus, X } from "@phosphor-icons/react";
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
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const realDataMode = Boolean(integrationStatus?.credentialConfigured && integrationStatus?.settings?.modelId);
  const previewMode = integrationStatus?.demo === true;
  const suggestions = useMemo(() => {
    const value = query.trim().toLocaleLowerCase("zh-CN");
    if (!value) return [];
    return Object.values(stocks).filter((item) => `${item.name} ${item.symbol}`.toLocaleLowerCase("zh-CN").includes(value) && !watchlist.some((entry) => entry.symbol === item.symbol)).slice(0, 6);
  }, [query, watchlist]);
  const closeDialog = () => { setDialogOpen(false); setQuery(""); setError(""); };
  const chooseSuggestion = async (item) => { try { await addWatchlist(item); closeDialog(); } catch (value) { setError(value instanceof Error ? value.message : String(value)); } };
  const submit = async (event) => {
    event.preventDefault(); setError("");
    const value = query.trim();
    if (!value) return;
    const suggestion = suggestions[0];
    try { await addWatchlist(suggestion || { symbol: value.toUpperCase(), name: value, market: "自定义", category: "自选" }); closeDialog(); } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
  };
  return <aside className="watchlist-sidebar">
    <div className="sidebar-heading"><h2>自选</h2><div><button aria-label="添加自选" onClick={() => setDialogOpen(true)}><Plus size={19} /></button><button aria-label="更多"><DotsThree size={20} /></button></div></div>
    <div className="watch-groups">{watchlist.map((item) => { const quote = liveQuotes[item.symbol] || (previewMode ? stocks[item.symbol] : null); const hasQuote = Number.isFinite(quote?.price); return <div className={selectedSymbol === item.symbol ? "watch-row selected" : "watch-row"} key={item.symbol}><button className="watch-row-main" onClick={() => selectSymbol(item.symbol)}><span><strong>{item.name}</strong><small>{item.symbol}</small></span><span className={quote?.change >= 0 ? "quote up" : "quote down"}><strong>{hasQuote ? quote.price.toFixed(2) : "—"}</strong><small>{hasQuote && Number.isFinite(quote.change) ? `${quote.change >= 0 ? "+" : ""}${quote.change.toFixed(2)}%` : realDataMode ? "尚未查询" : previewMode ? "预览模式" : "加载中"}</small></span></button><button className="watch-remove" aria-label="移除自选" onClick={() => { void removeWatchlist(item.symbol); }}><X size={12} /></button></div>; })}</div>
    <div className="sidebar-status"><span className="status-dot" />{liveDataLoading ? "正在获取实时行情…" : realDataMode ? "实时行情已启用 · 每分钟更新" : "等待配置真实数据"}</div>
    {dialogOpen && <div className="modal-backdrop" role="presentation"><form className="modal-card sidebar-modal" onSubmit={submit}><div className="modal-heading"><h2>添加自选标的</h2><button type="button" className="icon-button" aria-label="关闭" onClick={closeDialog}><X size={18} /></button></div><p className="modal-help">输入名称或代码即可，选择推荐项可自动补齐市场信息；自定义输入只需填写一个字段。</p><label>搜索名称或代码<input autoFocus required value={query} onChange={(event) => setQuery(event.target.value)} placeholder="例如 茅台、600519、AAPL" aria-label="搜索名称或代码" /></label>{suggestions.length > 0 && <div className="watch-suggestions" role="listbox" aria-label="自选推荐">{suggestions.map((item) => <button type="button" key={item.symbol} onClick={() => { void chooseSuggestion(item); }}><span><strong>{item.name}</strong><small>{item.symbol} · {item.market}</small></span><Plus size={15} /></button>)}</div>}{error && <p className="form-error" role="alert">{error}</p>}<button className="primary-action" type="submit">添加到自选</button></form></div>}
  </aside>;
}
