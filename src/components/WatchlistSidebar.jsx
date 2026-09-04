import { CaretDown, CaretUp, DownloadSimple, DotsThree, Plus, UploadSimple, X } from "@phosphor-icons/react";
import { memo, useCallback, useMemo, useRef, useState } from "react";
import { stocks } from "../data/market.js";
import { normalizeWatchlistItem, parseWatchlistImport, sortWatchlistItems, watchlistCsv, WATCHLIST_SORT_OPTIONS } from "../lib/watchlist.js";
import { hasRealDataAccess } from "../lib/dataStatus.js";
import { changeToneClass, formatCompactQuoteFreshness, formatQuoteFreshness, isValidQuotePrice, quoteForSymbol, quoteFreshness } from "../lib/quoteFormatting.js";
import { useLabStore } from "../store/useLabStore.js";

async function readTextFile(file) {
  if (typeof file?.text === "function") return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("无法读取自选文件"));
    reader.readAsText(file);
  });
}

const WatchlistRow = memo(function WatchlistRow({ item, selected, quote, realDataMode, previewMode, sortKey, canMoveUp, canMoveDown, onSelect, onRemove, onMove }) {
  const hasQuote = isValidQuotePrice(quote?.price);
  const hasChange = Number.isFinite(quote?.change);
  const market = item.market;
  const freshness = hasQuote ? quoteFreshness(quote.asOf) : null;
  const freshnessLabel = hasQuote ? formatQuoteFreshness(quote.asOf, Date.now(), market) : "";
  return <div className={selected ? "watch-row selected" : "watch-row"}>
    <button className="watch-row-main" onClick={() => onSelect(item.symbol)} title={item.name}>
      <span><strong title={item.name}>{item.name}</strong><small>{item.symbol}{item.category ? ` · ${item.category}` : ""}</small></span>
      <span className={`quote ${changeToneClass(quote?.change)}`}><strong>{hasQuote ? quote.price.toFixed(2) : "—"}</strong><small>{hasChange ? `${quote.change >= 0 ? "+" : ""}${quote.change.toFixed(2)}%` : realDataMode ? "尚未查询" : previewMode ? "预览模式" : "等待配置"}</small>{hasQuote && <small className={`quote-freshness quote-source-${freshness.state}`} title={`${quote.source || "数据服务"} · ${freshnessLabel}`}>{formatCompactQuoteFreshness(quote.asOf, Date.now(), market)}</small>}</span>
    </button>
    <span className="watch-row-actions">
      {sortKey === "custom" && <>
        <button className="watch-order-button" disabled={!canMoveUp} aria-label={`上移${item.symbol}`} title={canMoveUp ? `上移${item.name || item.symbol}` : "已经是本组第一项"} onClick={() => { void onMove(item.symbol, "up"); }}><CaretUp size={12} /></button>
        <button className="watch-order-button" disabled={!canMoveDown} aria-label={`下移${item.symbol}`} title={canMoveDown ? `下移${item.name || item.symbol}` : "已经是本组最后一项"} onClick={() => { void onMove(item.symbol, "down"); }}><CaretDown size={12} /></button>
      </>}
      <button className="watch-remove" aria-label={`移除${item.symbol}自选`} title={`移除${item.name || item.symbol}自选`} onClick={() => { void onRemove(item.symbol); }}><X size={12} /></button>
    </span>
  </div>;
});

export function WatchlistSidebar() {
  const selectedSymbol = useLabStore((state) => state.selectedSymbol);
  const watchlist = useLabStore((state) => state.watchlist);
  const liveQuotes = useLabStore((state) => state.liveQuotes);
  const integrationStatus = useLabStore((state) => state.integrationStatus);
  const integrationStatusLoading = useLabStore((state) => state.integrationStatusLoading);
  const integrationStatusError = useLabStore((state) => state.integrationStatusError);
  const liveDataLoading = useLabStore((state) => state.liveDataLoading);
  const selectSymbol = useLabStore((state) => state.selectSymbol);
  const addWatchlist = useLabStore((state) => state.addWatchlist);
  const importWatchlistItems = useLabStore((state) => state.importWatchlistItems);
  const removeWatchlist = useLabStore((state) => state.removeWatchlist);
  const moveWatchlistItem = useLabStore((state) => state.moveWatchlistItem);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [groupFilter, setGroupFilter] = useState("all");
  const [sortKey, setSortKey] = useState("custom");
  const [sortDirection, setSortDirection] = useState("asc");
  const [groupChoice, setGroupChoice] = useState("");
  const [newGroupMode, setNewGroupMode] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [toolsOpen, setToolsOpen] = useState(false);
  const [feedback, setFeedback] = useState("");
  const fileInput = useRef(null);
  const realDataMode = hasRealDataAccess(integrationStatus);
  const previewMode = integrationStatus?.demo === true;
  const normalizedWatchlist = useMemo(() => watchlist.map(normalizeWatchlistItem).filter((item) => item.symbol && item.name), [watchlist]);
  const groups = useMemo(() => [...new Set(normalizedWatchlist.map((item) => item.group))], [normalizedWatchlist]);
  const groupCounts = useMemo(() => new Map(groups.map((group) => [group, normalizedWatchlist.filter((item) => item.group === group).length])), [groups, normalizedWatchlist]);
  const selectedAddGroup = newGroupMode ? newGroupName.trim() : groupChoice || groups[0] || "自选";
  const suggestions = useMemo(() => {
    const value = query.trim().toLocaleLowerCase("zh-CN");
    if (!value) return [];
    return Object.values(stocks).filter((item) => `${item.name} ${item.symbol}`.toLocaleLowerCase("zh-CN").includes(value) && !watchlist.some((entry) => entry.symbol === item.symbol)).slice(0, 6);
  }, [query, watchlist]);
  const groupedItems = useMemo(() => {
    const filtered = groupFilter === "all" ? normalizedWatchlist : normalizedWatchlist.filter((item) => item.group === groupFilter);
    const sortableQuotes = previewMode ? Object.fromEntries(filtered.map((item) => [item.symbol, quoteForSymbol(liveQuotes, item.symbol) || stocks[item.symbol]])) : liveQuotes;
    const sorted = sortWatchlistItems(filtered, sortableQuotes, sortKey, sortDirection);
    const grouped = new Map();
    sorted.forEach((item) => {
      const group = normalizeWatchlistItem(item).group;
      if (!grouped.has(group)) grouped.set(group, []);
      grouped.get(group).push(item);
    });
    return [...grouped.entries()];
  }, [groupFilter, liveQuotes, normalizedWatchlist, previewMode, sortDirection, sortKey]);
  const openDialog = () => {
    setGroupChoice(groups[0] || "自选");
    setNewGroupMode(false);
    setNewGroupName("");
    setDialogOpen(true);
  };
  const exportWatchlist = () => {
    const blob = new Blob([watchlistCsv(watchlist)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `foliomind-watchlist-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    setFeedback(`已导出 ${watchlist.length} 个自选标的`);
    setToolsOpen(false);
  };
  const importFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setError("");
    setFeedback("");
    try {
      const parsed = parseWatchlistImport(await readTextFile(file));
      if (!parsed.items.length) throw new Error(parsed.errors[0]?.reason || "文件中没有可识别的标的");
      const result = await importWatchlistItems(parsed.items);
      const issueText = parsed.errors.length ? `，${parsed.errors.length} 行格式有误` : "";
      setFeedback(`已导入 ${result.added} 个标的${result.skipped ? `，跳过 ${result.skipped} 个重复项` : ""}${issueText}`);
      setToolsOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const closeDialog = () => { setDialogOpen(false); setQuery(""); setError(""); setNewGroupMode(false); setNewGroupName(""); };
  const removeItem = useCallback(async (symbol) => {
    setError("");
    try { await removeWatchlist(symbol); setFeedback("已从自选移除"); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }, [removeWatchlist]);
  const moveItem = useCallback(async (symbol, direction) => {
    setError("");
    try {
      const moved = await moveWatchlistItem(symbol, direction);
      if (moved) setFeedback(direction === "up" ? "已上移自选" : "已下移自选");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [moveWatchlistItem]);
  const selectItem = useCallback((symbol) => selectSymbol(symbol), [selectSymbol]);
  const addItem = async (item) => {
    if (!selectedAddGroup) { setError("请输入分组名称"); return; }
    try { await addWatchlist({ ...item, group: selectedAddGroup }); closeDialog(); } catch (value) { setError(value instanceof Error ? value.message : String(value)); }
  };
  const chooseSuggestion = async (item) => { await addItem(item); };
  const submit = async (event) => {
    event.preventDefault(); setError("");
    const value = query.trim();
    if (!value) return;
    await addItem(suggestions[0] || { symbol: value.toUpperCase(), name: value, market: "自定义", category: "自选" });
  };
  return <aside className="watchlist-sidebar">
    <div className="sidebar-heading"><h2>自选</h2><div className="sidebar-heading-actions"><button aria-label="添加自选" onClick={openDialog}><Plus size={19} /></button><div className="sidebar-tools"><button aria-label="自选工具" aria-expanded={toolsOpen} onClick={() => { setToolsOpen((value) => !value); setError(""); }}><DotsThree size={20} /></button>{toolsOpen && <div className="sidebar-tools-menu" role="menu"><button type="button" role="menuitem" onClick={exportWatchlist}><DownloadSimple size={15} />导出自选 CSV</button><button type="button" role="menuitem" onClick={() => fileInput.current?.click()}><UploadSimple size={15} />导入 CSV / TXT</button><small>支持 FolioMind CSV 或 TradingView 交易所前缀列表</small></div>}<input ref={fileInput} aria-label="导入自选文件" type="file" accept=".csv,.txt,text/csv,text/plain" hidden onChange={(event) => void importFile(event)} /></div></div></div>
    <div className="watchlist-controls" aria-label="自选视图控制">
      <label><span>分组</span><select aria-label="自选分组" value={groupFilter} onChange={(event) => setGroupFilter(event.target.value)}><option value="all">全部（{normalizedWatchlist.length}）</option>{groups.map((group) => <option key={group} value={group}>{group}（{groupCounts.get(group)}）</option>)}</select></label>
      <label><span>排序</span><select aria-label="自选排序" value={sortKey} onChange={(event) => setSortKey(event.target.value)}>{WATCHLIST_SORT_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
      {sortKey !== "custom" && <button type="button" className="watchlist-sort-direction" aria-label={sortDirection === "asc" ? "切换为降序" : "切换为升序"} onClick={() => setSortDirection((value) => value === "asc" ? "desc" : "asc")}>{sortDirection === "asc" ? "升序" : "降序"}</button>}
    </div>
    {sortKey === "custom" && normalizedWatchlist.length > 1 && <p className="watchlist-order-hint">自定义顺序 · 使用每行右侧箭头调整</p>}
    <div className="watch-groups">
      {groupedItems.length ? groupedItems.map(([group, items]) => <section key={group} aria-label={`${group}自选`}><h3><span>{group}</span><small>{items.length}</small></h3>{items.map((item, index) => <WatchlistRow key={item.symbol} item={item} selected={selectedSymbol === item.symbol} quote={quoteForSymbol(liveQuotes, item.symbol) || (previewMode ? stocks[item.symbol] : null)} realDataMode={realDataMode} previewMode={previewMode} sortKey={sortKey} canMoveUp={sortKey === "custom" && index > 0} canMoveDown={sortKey === "custom" && index < items.length - 1} onSelect={selectItem} onRemove={removeItem} onMove={moveItem} />)}</section>) : <div className="watchlist-filter-empty" role="status"><strong>该分组暂无标的</strong><span>切换分组或添加新的自选。</span></div>}
    </div>
    {feedback && <p className="sidebar-feedback" role="status">{feedback}</p>}
    {error && !dialogOpen && <p className="sidebar-feedback error" role="alert">{error}</p>}
    <div className="sidebar-status"><span className="status-dot" />{integrationStatusLoading ? "正在读取数据连接…" : integrationStatusError ? "数据连接暂不可用 · 去设置重试" : liveDataLoading ? "正在获取实时行情…" : realDataMode ? "实时行情已启用 · 重点15秒 / 全量3分钟" : "等待配置真实数据"}</div>
    {dialogOpen && <div className="modal-backdrop" role="presentation"><form className="modal-card sidebar-modal" onSubmit={submit}><div className="modal-heading"><h2>添加自选标的</h2><button type="button" className="icon-button" aria-label="关闭" onClick={closeDialog}><X size={18} /></button></div><p className="modal-help">输入名称或代码即可，选择推荐项可自动补齐市场信息；自定义输入只需填写一个字段。</p><label>搜索名称或代码<input autoFocus required value={query} onChange={(event) => setQuery(event.target.value)} placeholder="例如 茅台、600519、AAPL" aria-label="搜索名称或代码" /></label><label>添加到分组<select aria-label="添加到分组" value={newGroupMode ? "__new__" : groupChoice} onChange={(event) => { if (event.target.value === "__new__") { setNewGroupMode(true); setNewGroupName(""); } else { setNewGroupMode(false); setGroupChoice(event.target.value); } }}><option value="">选择分组</option>{groups.map((group) => <option key={group} value={group}>{group}</option>)}<option value="__new__">新建分组…</option></select></label>{newGroupMode && <label>新分组名称<input autoFocus value={newGroupName} onChange={(event) => setNewGroupName(event.target.value)} maxLength={64} placeholder="例如 核心持仓" aria-label="新分组名称" /></label>}{suggestions.length > 0 && <div className="watch-suggestions" role="listbox" aria-label="自选推荐">{suggestions.map((item) => <button type="button" key={item.symbol} onClick={() => { void chooseSuggestion(item); }}><span><strong>{item.name}</strong><small>{item.symbol} · {item.market}</small></span><Plus size={15} /></button>)}</div>}{error && <p className="form-error" role="alert">{error}</p>}<button className="primary-action" type="submit">添加到自选</button></form></div>}
  </aside>;
}
