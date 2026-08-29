import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowsClockwise, Bell, BellRinging, Briefcase, CheckCircle, DownloadSimple, Funnel, Info, MagnifyingGlass, Play, Plus, ShieldCheck, Trash, UploadSimple, Warning, X } from "@phosphor-icons/react";
import { monitorEvents, skills } from "../data/market.js";
import { monitorStrategies, strategyFor } from "../data/monitorStrategies.js";
import { apiKeyPrefix, applyIntegrationSettings, clearQVerisCredential, defaultIntegrationSettings, loadIntegrationStatus, saveQVerisCredential, syncQVerisModels } from "../lib/integrations.js";
import { formatPercent, formatPrice, formatQuoteFreshness, quoteFreshness } from "../lib/quoteFormatting.js";
import { portfolioMetrics, portfolioReportCsv, portfolioRiskMetrics } from "../lib/portfolio.js";
import { friendlySettingsMessage } from "../lib/friendlyMessages.js";
import { requestSystemNotificationPermission, setSystemNotificationsEnabled, systemNotificationsEnabled } from "../lib/systemNotifications.js";
import packageJson from "../../package.json";
import { checkLatestRelease, compareVersions, RELEASES_PAGE_URL } from "../lib/updateCheck.js";
import { parseUserStateBackup, serializeUserStateBackup } from "../lib/userState.js";
import { useLabStore } from "../store/useLabStore.js";
import { CopilotPanel } from "./CopilotPanel.jsx";

const normalizeEndpoint = (value) => String(value ?? "").trim().replace(/\/+$/, "");
const errorMessage = (error) => friendlySettingsMessage(error);

const portfolioFormDefaults = { symbol: "", name: "", market: "", quantity: "", averageCost: "" };

export function PortfolioView() {
  const positions = useLabStore((state) => state.portfolioPositions);
  const watchlist = useLabStore((state) => state.watchlist);
  const liveQuotes = useLabStore((state) => state.liveQuotes);
  const integrationStatus = useLabStore((state) => state.integrationStatus);
  const savePortfolioPosition = useLabStore((state) => state.savePortfolioPosition);
  const removePortfolioPosition = useLabStore((state) => state.removePortfolioPosition);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [form, setForm] = useState(portfolioFormDefaults);
  const metrics = portfolioMetrics(positions, liveQuotes);
  const risk = portfolioRiskMetrics(positions, liveQuotes);
  const realDataMode = Boolean(integrationStatus?.credentialConfigured && integrationStatus?.settings?.modelId);
  const money = (value) => value == null ? "—" : formatPrice(value);
  const openCreate = () => {
    const first = watchlist[0];
    setEditing(null);
    setError("");
    setForm(first ? { ...portfolioFormDefaults, symbol: first.symbol, name: first.name, market: first.market } : portfolioFormDefaults);
    setDialogOpen(true);
  };
  const openEdit = (position) => {
    setEditing(position);
    setError("");
    setForm({ symbol: position.symbol, name: position.name, market: position.market, quantity: String(position.quantity), averageCost: String(position.averageCost) });
    setDialogOpen(true);
  };
  const selectSymbol = (symbol) => {
    const item = watchlist.find((entry) => entry.symbol === symbol);
    setForm((value) => ({ ...value, symbol, name: item?.name || value.name || symbol, market: item?.market || value.market }));
  };
  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await savePortfolioPosition({ ...form, id: editing?.id || "" });
      setDialogOpen(false);
    } catch (submitError) {
      setError(submitError?.message || "暂时无法保存这笔持仓，请检查输入后重试。");
    } finally {
      setBusy(false);
    }
  };
  const deletePosition = async (position) => {
    await removePortfolioPosition(position.id);
  };
  const exportReport = () => {
    const blob = new Blob([portfolioReportCsv(positions, liveQuotes)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `foliomind-portfolio-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  return <div className="secondary-page portfolio-page"><header><div><h1>投资组合</h1><p>持仓、市值与未实现盈亏</p></div><div className="page-header-actions"><button className="secondary-button" onClick={exportReport} disabled={!positions.length}><DownloadSimple size={17} />导出报告</button><button className="primary-action" onClick={openCreate}><Plus size={17} />添加持仓</button></div></header>
    <p className="security-note">只使用已返回的真实行情计算；缺少现价的持仓会显示为“—”，不会用预览数字填充。</p>
    <section className="portfolio-summary" aria-label="组合概览">
      <article className="portfolio-card"><span>当前市值</span><strong>{money(metrics.totalMarketValue)}</strong><small>{metrics.pricedCount ? `${metrics.pricedCount}/${metrics.totalCount} 个持仓有行情` : "等待真实行情"}</small></article>
      <article className="portfolio-card"><span>持仓成本</span><strong>{money(metrics.totalCost)}</strong><small>{metrics.totalCount ? `${metrics.totalCount} 个持仓` : "尚未添加持仓"}</small></article>
      <article className={`portfolio-card ${metrics.totalPnl == null ? "" : metrics.totalPnl >= 0 ? "positive" : "negative"}`}><span>未实现盈亏</span><strong>{money(metrics.totalPnl)}</strong><small>{metrics.totalPnlPercent == null ? "等待真实行情" : formatPercent(metrics.totalPnlPercent)}</small></article>
      <article className="portfolio-card"><span>行情覆盖</span><strong>{metrics.totalCount ? `${metrics.pricedCount}/${metrics.totalCount}` : "—"}</strong><small>{realDataMode ? "自动定时更新" : "配置数据模型后更新"}</small></article>
    </section>
    <section className="risk-overview" aria-label="组合风险洞察">
      <div className="risk-overview-heading"><div><h2>风险洞察</h2><small>只基于已返回的真实行情；数据不足时不生成风险评分。</small></div><ShieldCheck size={22} /></div>
      {positions.length === 0 ? <p className="risk-empty">添加持仓并获取真实行情后，这里会显示集中度与数据覆盖情况。</p> : <><div className="risk-metrics"><article><span>最大持仓</span><strong>{risk.topPosition?.name || "—"}</strong><small>{risk.topWeight == null ? "等待真实行情" : `${formatPercent(risk.topWeight)} 组合占比`}</small></article><article><span>行情覆盖</span><strong>{risk.pricedCoverage == null ? "—" : formatPercent(risk.pricedCoverage)}</strong><small>{metrics.pricedCount}/{metrics.totalCount} 个持仓</small></article><article><span>未计价成本</span><strong>{risk.missingCostWeight == null ? "—" : formatPercent(risk.missingCostWeight)}</strong><small>{risk.missingCostWeight == null ? "等待真实行情" : "暂未纳入市值计算"}</small></article></div><div className="risk-signal-list">{risk.signals.length ? risk.signals.map((signal) => <article className={`risk-signal ${signal.level}`} key={`${signal.level}-${signal.title}`}><span>{signal.level === "critical" ? <Warning size={17} /> : signal.level === "warning" ? <Warning size={17} /> : <Info size={17} />}</span><div><strong>{signal.title}</strong><p>{signal.detail}</p></div></article>) : <p className="risk-empty">当前没有可确认的风险信号；补齐历史行情后才会计算波动率与相关性。</p>}</div></>}
    </section>
    {!realDataMode && positions.length > 0 && <div className="settings-notice">配置数据凭据并同步模型后，组合会自动使用真实行情计算。</div>}
    {realDataMode && positions.length > 0 && metrics.pricedCount < metrics.totalCount && <div className="settings-notice">已覆盖 {metrics.pricedCount}/{metrics.totalCount} 个持仓；缺少现价的项目暂不计入市值和盈亏。</div>}
    {positions.length === 0 ? <div className="empty-state portfolio-empty"><Briefcase size={30} /><strong>还没有持仓</strong><p>添加持仓后，这里会汇总真实行情与盈亏。</p><button className="primary-action" onClick={openCreate}><Plus size={16} />添加第一笔持仓</button></div> : <section className="portfolio-table" aria-label="持仓明细"><div className="portfolio-table-head"><span>标的</span><span>数量</span><span>成本</span><span>现价</span><span>市值</span><span>未实现盈亏</span><span>占比</span><span>操作</span></div>{metrics.rows.map((row) => <div className="portfolio-row" key={row.id}><span><strong>{row.name}</strong><small>{row.symbol}{row.market ? ` · ${row.market}` : ""}</small></span><span>{row.quantity}</span><span>{money(row.averageCost)}</span><span>{money(row.currentPrice)}</span><span>{money(row.marketValue)}</span><span className={row.pnl == null ? "" : row.pnl >= 0 ? "up" : "down"}>{money(row.pnl)}{row.pnlPercent == null ? "" : ` (${formatPercent(row.pnlPercent)})`}</span><span>{row.weight == null ? "—" : formatPercent(row.weight)}</span><span className="portfolio-actions"><button className="icon-button" aria-label={`编辑${row.symbol}持仓`} onClick={() => openEdit(row)}>编辑</button><button className="icon-button" aria-label={`删除${row.symbol}持仓`} onClick={() => { void deletePosition(row); }}>删除</button></span></div>)}</section>}
    {dialogOpen && <div className="modal-backdrop" role="presentation"><form className="modal-card portfolio-modal" onSubmit={submit}><div className="modal-heading"><h2>{editing ? "编辑持仓" : "添加持仓"}</h2><button type="button" className="icon-button" aria-label="关闭" onClick={() => setDialogOpen(false)}><X size={18} /></button></div><p className="modal-help">保存后会使用真实行情计算市值与未实现盈亏。</p><label>标的<select aria-label="持仓标的" value={form.symbol} onChange={(event) => selectSymbol(event.target.value)} required>{!form.symbol && <option value="">请选择标的</option>}{watchlist.map((item) => <option key={item.symbol} value={item.symbol}>{item.name}（{item.symbol}）</option>)}{editing && !watchlist.some((item) => item.symbol === editing.symbol) && <option value={editing.symbol}>{editing.name}（{editing.symbol}）</option>}</select></label><label>持仓数量<input aria-label="持仓数量" type="number" min="0.0001" step="any" value={form.quantity} onChange={(event) => setForm((value) => ({ ...value, quantity: event.target.value }))} required /></label><label>平均成本<input aria-label="平均成本" type="number" min="0.01" step="0.01" value={form.averageCost} onChange={(event) => setForm((value) => ({ ...value, averageCost: event.target.value }))} required /></label>{error && <p className="form-error" role="alert">{error}</p>}<button className="primary-action" type="submit" disabled={busy}>{busy ? "保存中…" : "保存持仓"}</button></form></div>}
  </div>;
}

export function MarketView() {
  const watchlist = useLabStore((state) => state.watchlist);
  const liveQuotes = useLabStore((state) => state.liveQuotes);
  const integrationStatus = useLabStore((state) => state.integrationStatus);
  const refreshLiveData = useLabStore((state) => state.refreshLiveData);
  const liveDataLoading = useLabStore((state) => state.liveDataLoading);
  const liveDataLastRefreshAt = useLabStore((state) => state.liveDataLastRefreshAt);
  const realDataMode = Boolean(integrationStatus?.credentialConfigured && integrationStatus?.settings?.modelId);
  const returnedQuotes = watchlist.filter((item) => Number.isFinite(liveQuotes[item.symbol]?.price));
  return <div className="secondary-page"><header><div><h1>市场行情</h1><p>跨市场指数、自选与异动概览</p></div><span>{realDataMode ? "仅显示已返回的真实数据" : "配置模型后显示真实行情"}</span></header><div className="index-board">{realDataMode && returnedQuotes.length ? returnedQuotes.map((item) => { const quote = liveQuotes[item.symbol]; const freshness = quoteFreshness(quote.asOf); return <article key={item.symbol}><span>{item.name} <small>{item.symbol}</small></span><strong>{formatPrice(quote.price)}</strong><small className={quote.change >= 0 ? "up" : "down"}>{formatPercent(quote.change)}</small><em className={`quote-source quote-source-${freshness.state}`}>{quote.source || "数据服务"} · {formatQuoteFreshness(quote.asOf)}</em></article>; }) : <div className="empty-state"><strong>{realDataMode ? "暂无已查询的市场数据" : "行情预览"}</strong><p>{realDataMode ? "数据正在获取中，返回后将显示在这里。" : "当前未配置真实模型，预览数据不会用于投资判断。"}</p></div>}</div><section className="market-table"><h2>我的自选</h2><div className="table-head"><span>名称 / 代码</span><span>最新价</span><span>涨跌幅</span><span>市场</span></div>{watchlist.map((item) => { const quote = liveQuotes[item.symbol]; return <div className="table-row" key={item.symbol}><span><strong>{item.name}</strong><small>{item.symbol}</small></span><span>{Number.isFinite(quote?.price) ? formatPrice(quote.price) : "—"}</span><span className={quote?.change >= 0 ? "up" : "down"}>{formatPercent(quote?.change)}</span><span>{item.market}</span></div>; })}</section></div>;
}

export function ResearchView() {
  const watchlist = useLabStore((state) => state.watchlist);
  const liveQuotes = useLabStore((state) => state.liveQuotes);
  const integrationStatus = useLabStore((state) => state.integrationStatus);
  const refreshLiveData = useLabStore((state) => state.refreshLiveData);
  const liveDataLoading = useLabStore((state) => state.liveDataLoading);
  const liveDataLastRefreshAt = useLabStore((state) => state.liveDataLastRefreshAt);
  const [query, setQuery] = useState("");
  const [direction, setDirection] = useState("all");
  const [onlyPriced, setOnlyPriced] = useState(false);
  const realDataMode = Boolean(integrationStatus?.credentialConfigured && integrationStatus?.settings?.modelId);
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const filtered = watchlist.filter((item) => {
    const quote = liveQuotes[item.symbol];
    const change = Number(quote?.change);
    const matchesQuery = !normalizedQuery || `${item.name} ${item.symbol} ${item.market} ${item.category}`.toLocaleLowerCase("zh-CN").includes(normalizedQuery);
    const matchesDirection = direction === "all" || (direction === "up" && change >= 0) || (direction === "down" && change < 0);
    return matchesQuery && matchesDirection && (!onlyPriced || Number.isFinite(quote?.price));
  });
  const returnedCount = watchlist.filter((item) => Number.isFinite(liveQuotes[item.symbol]?.price)).length;
  return <div className="secondary-page research-page"><header><div><h1>研究筛选</h1><p>在我的自选中按真实行情筛选标的，不用示例数据填充。</p></div><button className="secondary-button" disabled={!realDataMode || liveDataLoading} onClick={() => { void refreshLiveData(); }}><ArrowsClockwise size={16} />{liveDataLoading ? "更新中…" : "刷新真实数据"}</button></header>
    <div className="research-toolbar"><label className="search-box"><MagnifyingGlass size={18} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称、代码或市场…" aria-label="搜索标的" /></label><div className="filter-group" aria-label="涨跌方向"><button className={direction === "all" ? "active" : ""} onClick={() => setDirection("all")}>全部</button><button className={direction === "up" ? "active" : ""} onClick={() => setDirection("up")}>上涨</button><button className={direction === "down" ? "active" : ""} onClick={() => setDirection("down")}>下跌</button></div><button className={`filter-toggle${onlyPriced ? " active" : ""}`} aria-pressed={onlyPriced} onClick={() => setOnlyPriced((value) => !value)}><Funnel size={15} />仅显示有行情</button></div>
    {!realDataMode ? <div className="empty-state research-empty"><Funnel size={30} /><strong>需要真实数据才能筛选</strong><p>请先在设置中配置凭据、同步模型并应用，筛选器不会使用预览价格。</p></div> : returnedCount === 0 ? <div className="empty-state research-empty"><ArrowsClockwise size={30} /><strong>尚无可用行情</strong><p>数据服务尚未返回自选行情，可点击右上角刷新，或检查设置。</p><button className="primary-action" disabled={liveDataLoading} onClick={() => { void refreshLiveData(); }}>重新获取</button></div> : filtered.length === 0 ? <div className="empty-state research-empty"><MagnifyingGlass size={30} /><strong>没有符合条件的标的</strong><p>调整搜索词或筛选条件后再试。</p></div> : <section className="research-table" aria-label="真实行情筛选结果"><div className="research-table-head"><span>标的</span><span>最新价</span><span>涨跌幅</span><span>市盈率</span><span>市净率</span><span>数据时间</span></div>{filtered.map((item) => { const quote = liveQuotes[item.symbol]; const hasQuote = Number.isFinite(quote?.price); const freshness = quoteFreshness(quote?.asOf); return <div className="research-row" key={item.symbol}><span><strong>{item.name}</strong><small>{item.symbol} · {item.market || item.category}</small></span><span>{hasQuote ? formatPrice(quote.price) : "—"}</span><span className={Number.isFinite(quote?.change) ? quote.change >= 0 ? "up" : "down" : ""}>{formatPercent(quote?.change)}</span><span>{quote?.pe == null ? "—" : String(quote.pe)}</span><span>{quote?.pb == null ? "—" : String(quote.pb)}</span><span className={`quote-source quote-source-${freshness.state}`}>{hasQuote ? formatQuoteFreshness(quote.asOf) : "—"}</span></div>; })}</section>}
    <p className="security-note">范围：我的自选 · {returnedCount}/{watchlist.length} 个标的已返回行情{liveDataLastRefreshAt ? ` · 最近更新 ${new Date(liveDataLastRefreshAt).toLocaleTimeString("zh-CN")}` : ""}。估值字段缺失时保持空值。</p>
  </div>;
}

export function MonitorView() {
  const rules = useLabStore((state) => state.rules);
  const watchlist = useLabStore((state) => state.watchlist);
  const toggleRule = useLabStore((state) => state.toggleRule);
  const addRule = useLabStore((state) => state.addRule);
  const deleteRule = useLabStore((state) => state.deleteRule);
  const runMonitorCheck = useLabStore((state) => state.runMonitorCheck);
  const monitorBusy = useLabStore((state) => state.monitorBusy);
  const setActiveView = useLabStore((state) => state.setActiveView);
  const sendMessage = useLabStore((state) => state.sendMessage);
  const integrationStatus = useLabStore((state) => state.integrationStatus);
  const realDataMode = Boolean(integrationStatus?.credentialConfigured && integrationStatus?.settings?.modelId);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState({ symbol: watchlist[0]?.symbol || "600519", strategyId: monitorStrategies[0].id, threshold: monitorStrategies[0].defaultThreshold, intervalSeconds: 300 });
  useEffect(() => { if (!watchlist.some((item) => item.symbol === form.symbol) && watchlist[0]) setForm((value) => ({ ...value, symbol: watchlist[0].symbol })); }, [watchlist, form.symbol]);
  const selectedStrategy = strategyFor(form.strategyId);
  const createRule = async (event) => { event.preventDefault(); await addRule({ ...form, threshold: Number(form.threshold), intervalSeconds: Number(form.intervalSeconds) }); setDialogOpen(false); };
  const analyzeEvent = (event) => {
    setActiveView("chat");
    void sendMessage(`请把以下界面示例信号作为待核实线索，不要直接当作事实：${event.title}——${event.detail}。请使用已配置的金融数据工具按 Search → Inspect → Call 查询最新真实数据，给出来源、截至时间，并判断该信号是否成立。`);
  };
  return <div className="secondary-page"><header><div><h1>个股盯盘</h1><p>Pi Agent 按策略定时检查真实市场数据，并在消息中心提醒</p></div><button className="primary-action" disabled={!realDataMode} onClick={() => setDialogOpen(true)}><Plus size={17} />新建盯盘</button></header>{!realDataMode && <div className="settings-notice">请先配置数据凭据、同步模型并保存，盯盘只接受真实数据。</div>}<section className="strategy-strip"><strong>内置策略</strong>{monitorStrategies.map((strategy) => <span key={strategy.id}>{strategy.name}</span>)}</section><section className="rule-list"><h2>运行中的规则</h2>{rules.map((rule) => { const strategy = strategyFor(rule.strategyId); return <article key={rule.id}><Bell size={20} /><div><strong>{strategy.name}</strong><small>{rule.symbol} · 阈值 {rule.threshold}{strategy.unit} · {rule.intervalSeconds} 秒检查</small></div><button className="rule-run" disabled={!realDataMode || monitorBusy || !rule.enabled} onClick={() => { void runMonitorCheck(rule.id); }} aria-label={`立即检查${rule.symbol}`}><Play size={14} weight="fill" /></button><button className={rule.enabled ? "toggle on" : "toggle"} onClick={() => toggleRule(rule.id)} aria-label={`${rule.enabled ? "停用" : "启用"}${strategy.name}`} aria-pressed={rule.enabled}><span /></button><button className="icon-button" aria-label={`删除${strategy.name}`} onClick={() => { void deleteRule(rule.id); }}><Trash size={15} /></button></article>; })}</section>{realDataMode ? <p className="security-note">没有已返回的真实信号。运行规则后，结果将出现在消息中心。</p> : <section className="event-list"><h2>预览线索（不会作为事实）</h2>{monitorEvents.map((event) => <article key={event.id}><time>{event.time}</time><span className="timeline-dot" /><div><strong>{event.title}</strong><p>{event.detail}</p></div><button onClick={() => analyzeEvent(event)}>核实并分析</button></article>)}</section>}{dialogOpen && <div className="modal-backdrop" role="presentation"><form className="modal-card" onSubmit={createRule}><div className="modal-heading"><h2>新建盯盘策略</h2><button type="button" className="icon-button" aria-label="关闭" onClick={() => setDialogOpen(false)}><X size={18} /></button></div><p className="modal-help">默认策略包含成交量异常监控、价格异动和公告与舆情。</p><label>标的<select value={form.symbol} onChange={(event) => setForm((value) => ({ ...value, symbol: event.target.value }))}>{watchlist.map((item) => <option key={item.symbol} value={item.symbol}>{item.name}（{item.symbol}）</option>)}</select></label><label>策略<select value={form.strategyId} onChange={(event) => { const next = strategyFor(event.target.value); setForm((value) => ({ ...value, strategyId: next.id, threshold: next.defaultThreshold })); }}>{monitorStrategies.map((strategy) => <option key={strategy.id} value={strategy.id}>{strategy.name} · {strategy.description}</option>)}</select></label><label>阈值<input type="number" min="0" step="0.1" value={form.threshold} onChange={(event) => setForm((value) => ({ ...value, threshold: event.target.value }))} /><small>{selectedStrategy.unit}</small></label><label>检查间隔<select value={form.intervalSeconds} onChange={(event) => setForm((value) => ({ ...value, intervalSeconds: event.target.value }))}><option value="60">每 60 秒</option><option value="300">每 5 分钟</option><option value="600">每 10 分钟</option><option value="1800">每 30 分钟</option></select></label><button className="primary-action" type="submit">保存并启用</button></form></div>}</div>;
}

export function NotificationsView() {
  const notifications = useLabStore((state) => state.notifications);
  const markNotificationRead = useLabStore((state) => state.markNotificationRead);
  const markAllNotificationsRead = useLabStore((state) => state.markAllNotificationsRead);
  const [systemEnabled, setSystemEnabled] = useState(() => systemNotificationsEnabled());
  const [systemNotice, setSystemNotice] = useState("");
  const toggleSystemNotifications = async () => {
    setSystemNotice("");
    if (systemEnabled) {
      setSystemNotificationsEnabled(false);
      setSystemEnabled(false);
      return;
    }
    const granted = await requestSystemNotificationPermission();
    if (!granted) {
      setSystemNotice("未获得系统通知权限；站内消息仍会正常保存。请在系统设置中允许后重试。");
      return;
    }
    setSystemNotificationsEnabled(true);
    setSystemEnabled(true);
    setSystemNotice("系统通知已开启，新的盯盘触发会同时显示在系统通知中心。");
  };
  return <div className="secondary-page notifications-page"><header><div><h1>站内消息</h1><p>盯盘触发、数据查询结果与运行状态都会保存在这里</p></div><div className="notification-actions"><label className="notification-preference"><input type="checkbox" checked={systemEnabled} onChange={() => { void toggleSystemNotifications(); }} />系统通知</label><button className="secondary-button" disabled={!notifications.some((item) => !item.read)} onClick={markAllNotificationsRead}>全部标为已读</button></div></header>{systemNotice && <p className="settings-notice" role="status">{systemNotice}</p>}{notifications.length === 0 ? <div className="empty-state"><BellRinging size={30} /><strong>还没有盯盘消息</strong><p>启用一条策略后，Pi 会按间隔检查真实数据。</p></div> : <div className="notification-list">{notifications.map((item) => <article className={item.read ? "notification read" : "notification unread"} key={item.id} onClick={() => markNotificationRead(item.id)}><div className={`notification-severity ${item.severity}`} /><div><strong>{item.title}</strong><p>{item.body}</p><small>{new Date(item.createdAt).toLocaleString("zh-CN")} · {item.source === "data-service" ? "真实数据服务" : "浏览器预览"}</small></div>{!item.read && <span className="unread-dot" />}</article>)}</div>}</div>;
}

export function SkillsView() {
  const [query, setQuery] = useState("");
  const items = useLabStore((state) => state.skillItems);
  const toggleSkill = useLabStore((state) => state.toggleSkill);
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const filteredItems = normalizedQuery ? items.filter((skill) => `${skill.name} ${skill.description} ${skill.category}`.toLocaleLowerCase("zh-CN").includes(normalizedQuery)) : items;
  return <div className="secondary-page"><header><div><h1>Skill 市场</h1><p>为 Pi 安装经过审核的金融研究能力</p></div><label className="search-box"><MagnifyingGlass size={18} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 Skills…" aria-label="搜索 Skills" /></label></header><div className="skill-grid">{filteredItems.map((skill) => <article key={skill.id}><div className="skill-icon"><CheckCircle size={24} weight={skill.installed ? "fill" : "regular"} /></div><div><span>{skill.category}</span><h2>{skill.name}</h2><p>{skill.description}</p></div><button className={skill.installed ? "installed" : ""} aria-pressed={skill.installed} onClick={() => toggleSkill(skill.id)}>{skill.installed ? "已安装" : "安装"}</button></article>)}</div>{filteredItems.length === 0 && <p className="security-note" role="status">没有匹配“{query.trim()}”的 Skill。</p>}<p className="security-note">第三方 Skill 在安装前会显示权限、来源和签名状态；工具调用由 Host 白名单控制。</p></div>;
}

export function SettingsView() {
  const runtimeMode = useLabStore((state) => state.runtimeMode);
  const runtimeConfiguring = useLabStore((state) => state.runtimeConfiguring);
  const runtimeCancelPending = useLabStore((state) => state.runtimeCancelPending);
  const beginRuntimeConfiguration = useLabStore((state) => state.beginRuntimeConfiguration);
  const endRuntimeConfiguration = useLabStore((state) => state.endRuntimeConfiguration);
  const setSettingsNotice = useLabStore((state) => state.setSettingsNotice);
  const setIntegrationStatus = useLabStore((state) => state.setIntegrationStatus);
  const refreshLiveData = useLabStore((state) => state.refreshLiveData);
  const watchlist = useLabStore((state) => state.watchlist);
  const rules = useLabStore((state) => state.rules);
  const notifications = useLabStore((state) => state.notifications);
  const portfolioPositions = useLabStore((state) => state.portfolioPositions);
  const replaceUserState = useLabStore((state) => state.replaceUserState);
  const integrationStatus = useLabStore((state) => state.integrationStatus);
  const integrationStatusLoading = useLabStore((state) => state.integrationStatusLoading);
  const integrationStatusError = useLabStore((state) => state.integrationStatusError);
  const [status, setStatus] = useState({ credentialConfigured: false, settings: defaultIntegrationSettings, demo: false });
  const [form, setForm] = useState(defaultIntegrationSettings);
  const [apiKey, setApiKey] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadState, setLoadState] = useState("loading");
  const [loadError, setLoadError] = useState("");
  const [updateState, setUpdateState] = useState("idle");
  const [latestRelease, setLatestRelease] = useState(null);
  const [updateError, setUpdateError] = useState("");
  const [backupBusy, setBackupBusy] = useState(false);
  const backupInput = useRef(null);
  const loadRequest = useRef(0);

  const loadSettings = useCallback(async () => {
    const request = ++loadRequest.current;
    setLoadState("loading"); setLoadError("");
    try {
      const value = await loadIntegrationStatus();
      if (request !== loadRequest.current) return;
      setStatus(value); setIntegrationStatus(value); setForm(value.settings); setLoadState("ready");
    } catch (error) {
      if (request !== loadRequest.current) return;
      setLoadError(errorMessage(error)); setLoadState("error");
    }
  }, []);

  useEffect(() => {
    if (integrationStatusLoading) {
      setLoadState("loading");
      return undefined;
    }
    if (integrationStatusError) {
      setLoadError(friendlySettingsMessage(integrationStatusError));
      setLoadState("error");
      return undefined;
    }
    if (integrationStatus) {
      setStatus(integrationStatus);
      setForm(integrationStatus.settings || defaultIntegrationSettings);
      setLoadState("ready");
      return undefined;
    }
    void loadSettings();
    return () => { loadRequest.current += 1; };
  }, [integrationStatus, integrationStatusError, integrationStatusLoading, loadSettings]);

  const run = async (action, success, persistNotice = false) => {
    setBusy(true); setNotice("");
    try {
      const value = await action();
      if (value?.models) setForm(value);
      setNotice(success);
      if (persistNotice) setSettingsNotice({ type: "success", text: success });
    } catch (error) {
      const message = friendlySettingsMessage(error);
      setNotice(message);
      if (persistNotice) setSettingsNotice({ type: "error", text: message });
    }
    finally { setBusy(false); }
  };
  const saveKey = () => run(async () => { await saveQVerisCredential(apiKey); const next = { ...status, credentialConfigured: true, keyPrefix: apiKeyPrefix(apiKey) }; setApiKey(""); setStatus(next); setIntegrationStatus(next); }, "数据服务密钥已保存");
  const clearKey = () => run(async () => { await clearQVerisCredential(); const next = { ...status, credentialConfigured: false, keyPrefix: "" }; setStatus(next); setIntegrationStatus(next); }, "数据服务密钥已清除");
  const syncModels = () => run(async () => { const value = await syncQVerisModels(form); const next = { ...status, settings: value }; setStatus(next); setIntegrationStatus(next); return value; }, "模型目录已同步");
  const saveAll = async () => {
    if (!beginRuntimeConfiguration()) {
      const message = "当前分析尚未结束，请等待完成或停止后再应用设置";
      setNotice(message);
      setSettingsNotice({ type: "error", text: message });
      return;
    }
    try {
      await run(async () => { const value = await applyIntegrationSettings(form); const next = { ...status, settings: value }; setStatus(next); setIntegrationStatus(next); return value; }, "设置已保存，Pi Runtime 已应用新模型", true);
    } finally {
      endRuntimeConfiguration();
      window.setTimeout(() => { void refreshLiveData(); }, 0);
    }
  };

  const modelOptions = form.models ?? [];
  const analysisActive = runtimeCancelPending || ["running", "cancelling"].includes(runtimeMode);
  const gatewayChanged = normalizeEndpoint(form.modelGatewayBaseUrl) !== normalizeEndpoint(status.settings.modelGatewayBaseUrl);
  const selectedModelAvailable = modelOptions.some((model) => model.id === form.modelId);
  const modelStatus = gatewayChanged ? "网关地址已变化，请先同步模型" : modelOptions.length ? `${modelOptions.length} 个可用模型` : "尚未同步模型";
  const formDisabled = busy || runtimeConfiguring || runtimeCancelPending || loadState !== "ready";
  const localDevHost = status.environment === "local-host";
  const environmentLabel = loadState === "loading" ? "正在加载" : loadState === "error" ? "加载失败" : status.demo ? "浏览器预览" : localDevHost ? "本地开发 Host" : "桌面端";
  const credentialLabel = loadState === "loading" ? "读取中" : loadState === "error" ? "状态未知" : status.credentialConfigured ? `已配置 · ${status.keyPrefix || "前缀未知"}` : "未配置";
  const currentVersion = packageJson.version;
  const checkForUpdates = async () => {
    setUpdateState("loading"); setUpdateError("");
    try {
      setLatestRelease(await checkLatestRelease());
      setUpdateState("ready");
    } catch {
      setLatestRelease(null);
      setUpdateState("error");
      setUpdateError("暂时无法检查更新，请稍后重试或打开发布页查看。");
    }
  };
  const updateLabel = updateState === "loading" ? "检查中…" : "检查更新";
  const updateMessage = updateState === "error" ? updateError : latestRelease ? compareVersions(latestRelease.version, currentVersion) > 0 ? `发现新版本 ${latestRelease.version}` : `当前已是最新版本（${currentVersion}）` : `当前版本 ${currentVersion}；发布页可查看安装包与校验和。`;
  const exportBackup = () => {
    try {
      const content = serializeUserStateBackup({ watchlist, rules, notifications, portfolioPositions });
      const blob = new Blob([content], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `foliomind-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setNotice("本地数据备份已导出（不包含 API Key 和模型设置）");
    } catch { setNotice("暂时无法导出备份，请稍后重试"); }
  };
  const importBackup = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBackupBusy(true); setNotice("");
    try {
      const snapshot = parseUserStateBackup(await file.text());
      await replaceUserState(snapshot);
      setNotice("本地数据已导入，行情缓存已清空并会重新获取真实数据");
    } catch (error) { setNotice(error instanceof Error ? error.message : "备份文件暂时无法导入"); }
    finally { setBackupBusy(false); }
  };
  return <div className="secondary-page settings-page" aria-busy={loadState === "loading" || busy || runtimeConfiguring}><header><div><h1>设置</h1><p>真实数据、模型网关与本地凭据</p></div><span>{environmentLabel}</span></header>
    {loadError && <div className="settings-notice error" role="alert"><span>{loadError}</span><button className="secondary-button" onClick={() => { void loadSettings(); }}>重试加载</button></div>}
    <section className="settings-card"><div className="settings-card-title"><div><strong>数据与模型凭证</strong><small>{localDevHost ? "本地开发 Host 将密钥保存到用户配置目录（权限 0600）；浏览器不保存长期密钥。" : "密钥只保存在系统凭据库。FolioMind 是独立开源项目，不代表任何数据服务商。"}</small></div><span className={loadState === "ready" && status.credentialConfigured ? "status-pill ok" : "status-pill"}>{credentialLabel}</span></div><div className="settings-inline"><input type="password" autoComplete="new-password" value={apiKey} disabled={formDisabled} onChange={(event) => setApiKey(event.target.value)} placeholder="粘贴数据服务 API Key" aria-label="数据服务 API Key" /><button disabled={formDisabled || !apiKey.trim()} onClick={saveKey}>保存密钥</button>{status.credentialConfigured && <button className="secondary-button" disabled={formDisabled} onClick={clearKey}>清除</button>}</div></section>
    <section className="settings-card"><div className="settings-card-title"><div><strong>金融数据能力</strong><small>默认直连 QVeris CAP 的 qveris_finance 能力目录；首次固化后按稳定 tool schema 调用，避免每次重新搜索。</small></div><span className="status-pill ok">CAP</span></div><label>数据能力 API<input value={form.capabilityBaseUrl} disabled={formDisabled} onChange={(event) => setForm((value) => ({ ...value, capabilityBaseUrl: event.target.value }))} aria-label="数据能力 API" /></label><div className="settings-inline-note">Provider：{form.dataProvider || "qveris_finance"} · 渠道：{form.dataChannel || "qveris-cap"}</div></section>
    <section className="settings-card"><div className="settings-card-title"><div><strong>Pi 模型 · 模型网关</strong><small>通过运行时短期令牌访问本机回环代理，长期 API Key 不会交给 Pi。</small></div><button className="secondary-button" disabled={formDisabled || !status.credentialConfigured} onClick={syncModels}>同步模型</button></div><label>Gateway Base URL<input value={form.modelGatewayBaseUrl} disabled={formDisabled} onChange={(event) => setForm((value) => ({ ...value, modelGatewayBaseUrl: event.target.value }))} aria-label="Gateway Base URL" /></label><label>默认模型<select value={form.modelId} disabled={formDisabled} onChange={(event) => setForm((value) => ({ ...value, modelId: event.target.value }))} aria-label="默认模型"><option value="">请先同步模型目录</option>{modelOptions.map((model) => <option value={model.id} key={model.id}>{model.name || model.id}</option>)}</select></label><div className="settings-actions"><span>{analysisActive ? "请等待当前分析结束后再应用设置" : modelStatus}</span><button disabled={formDisabled || analysisActive || status.demo || gatewayChanged || !selectedModelAvailable} onClick={() => { void saveAll(); }}>{busy || runtimeConfiguring ? "处理中…" : "保存并应用"}</button></div></section>
    <section className="settings-card update-card"><div className="settings-card-title"><div><strong>应用更新</strong><small>当前版本 {currentVersion} · 从 FolioMind 官方 GitHub 发布页检查公开版本。</small></div><button className="secondary-button" disabled={updateState === "loading"} onClick={() => { void checkForUpdates(); }}>{updateLabel}</button></div><div className="update-status" aria-live="polite"><span>{updateMessage}</span>{latestRelease && compareVersions(latestRelease.version, currentVersion) > 0 && <a href={latestRelease.url || RELEASES_PAGE_URL} target="_blank" rel="noopener noreferrer">查看新版本</a>}{!latestRelease && <a href={RELEASES_PAGE_URL} target="_blank" rel="noopener noreferrer">打开发布页</a>}</div><small className="update-note">安装包更新仍需从发布页下载安装；正式自动更新还需要平台签名密钥。</small></section>
    <section className="settings-card backup-card"><div className="settings-card-title"><div><strong>本地数据备份</strong><small>迁移自选、盯盘、消息和持仓到另一台设备。凭据、模型网关、缓存和运行日志永远不会写入备份。</small></div><span className="status-pill">可导入导出</span></div><div className="backup-actions"><button className="secondary-button" disabled={formDisabled || backupBusy} onClick={exportBackup}><DownloadSimple size={15} />导出 JSON</button><button className="secondary-button" disabled={formDisabled || backupBusy} onClick={() => backupInput.current?.click()}><UploadSimple size={15} />{backupBusy ? "导入中…" : "导入 JSON"}</button><input ref={backupInput} className="visually-hidden" type="file" accept="application/json,.json" onChange={(event) => { void importBackup(event); }} /></div></section>
    {notice && <p className="settings-notice" role="status">{notice}</p>}
  </div>;
}

export function ChatView() { return <CopilotPanel standalone />; }
