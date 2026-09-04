import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowsClockwise, Bell, BellRinging, Briefcase, CalendarBlank, CalendarDots, CaretLeft, CaretRight, CheckCircle, DownloadSimple, Funnel, Info, List, MagnifyingGlass, Play, Plus, ShieldCheck, Trash, UploadSimple, Warning, X } from "@phosphor-icons/react";
import { skills } from "../data/market.js";
import { monitorTemplates, strategyFor } from "../data/monitorStrategies.js";
import { apiKeyPrefix, applyIntegrationSettings, clearQVerisCredential, defaultIntegrationSettings, loadIntegrationStatus, queryCapabilityData, saveQVerisCredential, syncQVerisModels, testModelConnection as testModelGateway } from "../lib/integrations.js";
import { changeToneClass, formatPercent, formatPrice, formatQuoteField, formatQuoteFreshness, isValidQuotePrice, quoteForSymbol, quoteFreshness, quoteSymbolKey } from "../lib/quoteFormatting.js";
import { PORTFOLIO_PLAN_HORIZONS, PORTFOLIO_PLAN_STATUSES, PORTFOLIO_SORT_OPTIONS, parsePortfolioImport, portfolioAllocationRows, portfolioMetrics, portfolioPerformanceSeries, portfolioReportCsv, portfolioRiskMetrics, sortPortfolioRows } from "../lib/portfolio.js";
import { friendlyDataMessage, friendlyModelMessage, friendlySettingsMessage } from "../lib/friendlyMessages.js";
import { DATA_STATES, hasRealDataAccess, liveDataStateCopy, resolveLiveDataState } from "../lib/dataStatus.js";
import { requestSystemNotificationPermission, setSystemNotificationMode, setSystemNotificationsEnabled, systemNotificationMode, SYSTEM_NOTIFICATION_MODES, systemNotificationsEnabled } from "../lib/systemNotifications.js";
import packageJson from "../../package.json";
import { checkLatestRelease, compareVersions, RELEASES_PAGE_URL } from "../lib/updateCheck.js";
import { parseUserStateBackup, serializeUserStateBackup } from "../lib/userState.js";
import { useLabStore } from "../store/useLabStore.js";
import { buildMonthGrid, eventDateKey, eventsByDate, monthCursorFromKey, monthKey, monthLabel, shiftMonth } from "../lib/eventCalendar.js";
import { CopilotPanel } from "./CopilotPanel.jsx";
import { DataState } from "./DataState.jsx";
import { CONDITION_TYPES, conditionOperatorsFor, conditionTypeFor, conditionsForRule, defaultConditionFor, normalizeConditions, ruleConditionSummary } from "../lib/monitorConditions.js";
import { anomalyLabel, detectMarketAnomalies } from "../lib/anomalyDetection.js";
import { nextBriefingLabel, nextPremarketLabel } from "../lib/briefingSchedule.js";
import { loadDesktopLifecycleStatus, reconcileDesktopNow } from "../lib/desktopLifecycle.js";
import { askPi, isDesktopRuntime } from "../lib/piRuntime.js";
import { marketBreadth, marketWatchlistSummary } from "../lib/marketBreadth.js";
import { activeResearchFilterCount, DEFAULT_RESEARCH_FILTERS, filterResearchItems, normalizeResearchFilters, RESEARCH_FILTER_FIELDS, RESEARCH_SORT_OPTIONS, sortResearchItems } from "../lib/research.js";
import { isMonitorRuleExpired, MONITOR_TRIGGER_MODES, monitorDateInputValue, monitorLifecycleLabel } from "../lib/monitorLifecycle.js";
import { safeExternalUrl } from "../lib/urlSafety.js";
import { loadRefreshPolicy, REFRESH_POLICIES, refreshPolicyConfig, saveRefreshPolicy } from "../lib/refreshPolicy.js";

const normalizeEndpoint = (value) => String(value ?? "").trim().replace(/\/+$/, "");
const errorMessage = (error, fallback = "") => fallback ? friendlyDataMessage(error, fallback) : friendlySettingsMessage(error);
const readTextFile = (file) => {
  if (typeof file?.text === "function") return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("无法读取文件内容"));
    reader.readAsText(file);
  });
};

const portfolioFormDefaults = { symbol: "", name: "", market: "", quantity: "", averageCost: "", takeProfitPrice: "", stopLossPrice: "", planThesis: "", planHorizon: "" };
const planActionLabels = { created: "建立计划", adjusted: "调整参数", executed: "确认执行", reopened: "重新跟踪", archived: "归档计划" };
const MARKET_COLUMNS_STORAGE_KEY = "foliomind.market-columns.v1";
const MARKET_VIEWS_STORAGE_KEY = "foliomind.market-views.v1";
const CUSTOM_MARKET_VIEW_ID = "custom";
const RESEARCH_SCREENS_STORAGE_KEY = "foliomind.research-screens.v1";
const MARKET_COLUMN_DEFINITIONS = Object.freeze([
  { id: "price", label: "最新价" },
  { id: "change", label: "涨跌幅" },
  { id: "volume", label: "成交量" },
  { id: "turnover", label: "成交额" },
  { id: "turnoverRate", label: "换手率" },
  { id: "pe", label: "市盈率" },
  { id: "pb", label: "市净率" },
  { id: "asOf", label: "数据时间" },
]);
const DEFAULT_MARKET_COLUMNS = Object.freeze(["price", "change", "pe", "pb"]);
const DEFAULT_MARKET_VIEWS = Object.freeze([
  { id: "valuation", name: "核心估值", columns: ["price", "change", "pe", "pb"] },
  { id: "trading", name: "交易盘面", columns: ["price", "change", "volume", "turnoverRate", "asOf"] },
  { id: "full", name: "完整字段", columns: MARKET_COLUMN_DEFINITIONS.map((column) => column.id) },
]);

function loadResearchScreens() {
  if (typeof window === "undefined") return [];
  try {
    const stored = JSON.parse(window.localStorage.getItem(RESEARCH_SCREENS_STORAGE_KEY) || "null");
    if (!Array.isArray(stored)) return [];
    const unique = new Map();
    stored.forEach((screen) => {
      const id = String(screen?.id || "");
      const name = String(screen?.name || "").trim().slice(0, 32);
      if (!id.startsWith("screen-") || !name) return;
      unique.set(id, { id, name, filters: normalizeResearchFilters(screen?.filters) });
    });
    return [...unique.values()].slice(0, 10);
  } catch { return []; }
}

function createResearchScreenId() {
  const suffix = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
  return `screen-${Date.now().toString(36)}-${suffix}`;
}

function normalizeMarketColumns(columns) {
  const allowed = new Set(MARKET_COLUMN_DEFINITIONS.map((column) => column.id));
  const result = Array.isArray(columns) ? [...new Set(columns.filter((column) => allowed.has(column)))] : [];
  return result.length ? result : [...DEFAULT_MARKET_COLUMNS];
}

function loadMarketColumns() {
  if (typeof window === "undefined") return [...DEFAULT_MARKET_COLUMNS];
  try {
    const stored = JSON.parse(window.localStorage.getItem(MARKET_COLUMNS_STORAGE_KEY) || "null");
    return normalizeMarketColumns(stored);
  } catch { return [...DEFAULT_MARKET_COLUMNS]; }
}

function loadMarketViews() {
  if (typeof window === "undefined") return [...DEFAULT_MARKET_VIEWS];
  try {
    const stored = JSON.parse(window.localStorage.getItem(MARKET_VIEWS_STORAGE_KEY) || "null");
    if (!Array.isArray(stored)) return [...DEFAULT_MARKET_VIEWS];
    const allowed = new Set(MARKET_COLUMN_DEFINITIONS.map((column) => column.id));
    const custom = stored.map((view) => {
      const columns = Array.isArray(view?.columns) ? [...new Set(view.columns.filter((column) => allowed.has(column)))] : [];
      return { id: String(view?.id || ""), name: String(view?.name || "").trim().slice(0, 32), columns };
    }).filter((view) => view.id.startsWith("custom-") && view.name && view.columns.length);
    const unique = new Map(custom.map((view) => [view.id, view]));
    return [...DEFAULT_MARKET_VIEWS, ...unique.values()].slice(0, 13);
  } catch { return [...DEFAULT_MARKET_VIEWS]; }
}

function columnsMatch(left, right) {
  return normalizeMarketColumns(left).join("|") === normalizeMarketColumns(right).join("|");
}

function createMarketViewId() {
  const suffix = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
  return `custom-${Date.now().toString(36)}-${suffix}`;
}

function marketColumnValue(item, quote, column) {
  const number = (value) => Number.isFinite(Number(value)) ? formatPrice(Number(value)) : "—";
  if (column === "price") return { value: number(quote?.price) };
  if (column === "change") return { value: Number.isFinite(Number(quote?.change)) ? formatPercent(quote.change) : "—", className: changeToneClass(quote?.change) };
  if (column === "volume") return { value: number(quote?.volume) };
  if (column === "turnover") return { value: number(quote?.turnover) };
  if (column === "turnoverRate") return { value: Number.isFinite(Number(quote?.turnoverRate)) ? formatPercent(quote.turnoverRate, { signed: false }) : "—" };
  if (column === "pe") return { value: quote?.pe == null ? "—" : String(quote.pe) };
  if (column === "pb") return { value: quote?.pb == null ? "—" : String(quote.pb) };
  if (column === "asOf") return { value: quote?.asOf ? formatQuoteFreshness(quote.asOf, Date.now(), item?.market) : "—", className: "quote-source" };
  return { value: "—" };
}

function marketSummaryValue(field, value) {
  if (!Number.isFinite(value)) return "—";
  if (field === "change") return formatPercent(value);
  if (field === "turnoverRate") return formatPercent(value, { signed: false });
  if (field === "volume" || field === "turnover") return formatQuoteField(field, value);
  if (field === "pe" || field === "pb") return formatQuoteField(field, value);
  return formatPrice(value);
}

function LiveDataState({ state, receivedCount = 0, totalCount = 0, onRetry, onSettings, onCancel, compact = false }) {
  const copy = liveDataStateCopy(state, { receivedCount, totalCount });
  const canCancel = state === DATA_STATES.LOADING && typeof onCancel === "function";
  const actionLabel = canCancel ? "停止更新" : copy.action === "settings" ? "去设置" : copy.action === "retry" ? "立即重试" : "";
  const onAction = canCancel ? onCancel : copy.action === "settings" ? onSettings : copy.action === "retry" ? onRetry : undefined;
  return <DataState state={state} title={copy.title} description={copy.description} actionLabel={actionLabel} onAction={onAction} compact={compact} />;
}

export function PortfolioView() {
  const positions = useLabStore((state) => state.portfolioPositions);
  const watchlist = useLabStore((state) => state.watchlist);
  const liveQuotes = useLabStore((state) => state.liveQuotes);
  const portfolioReviews = useLabStore((state) => state.portfolioReviews);
  const premarketBriefing = useLabStore((state) => state.premarketBriefing);
  const premarketBriefingLoading = useLabStore((state) => state.premarketBriefingLoading);
  const premarketBriefingError = useLabStore((state) => state.premarketBriefingError);
  const briefingSchedule = useLabStore((state) => state.briefingSchedule);
  const briefingScheduleBusy = useLabStore((state) => state.briefingScheduleBusy);
  const premarketBriefingScheduleBusy = useLabStore((state) => state.premarketBriefingScheduleBusy);
  const integrationStatus = useLabStore((state) => state.integrationStatus);
  const savePortfolioPosition = useLabStore((state) => state.savePortfolioPosition);
  const importPortfolioItems = useLabStore((state) => state.importPortfolioItems);
  const updatePortfolioPlanStatus = useLabStore((state) => state.updatePortfolioPlanStatus);
  const removePortfolioPosition = useLabStore((state) => state.removePortfolioPosition);
  const createPortfolioReview = useLabStore((state) => state.createPortfolioReview);
  const generatePremarketBriefing = useLabStore((state) => state.generatePremarketBriefing);
  const cancelPremarketBriefing = useLabStore((state) => state.cancelPremarketBriefing);
  const removePortfolioReview = useLabStore((state) => state.removePortfolioReview);
  const updateBriefingSchedule = useLabStore((state) => state.updateBriefingSchedule);
  const runDuePortfolioReview = useLabStore((state) => state.runDuePortfolioReview);
  const runDuePremarketBriefing = useLabStore((state) => state.runDuePremarketBriefing);
  const refreshLiveData = useLabStore((state) => state.refreshLiveData);
  const cancelLiveDataRefresh = useLabStore((state) => state.cancelLiveDataRefresh);
  const liveDataLoading = useLabStore((state) => state.liveDataLoading);
  const liveDataError = useLabStore((state) => state.liveDataError);
  const setActiveView = useLabStore((state) => state.setActiveView);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reviewNotice, setReviewNotice] = useState("");
  const [form, setForm] = useState(portfolioFormDefaults);
  const [portfolioSortKey, setPortfolioSortKey] = useState("default");
  const [portfolioSortDirection, setPortfolioSortDirection] = useState("desc");
  const [portfolioQuery, setPortfolioQuery] = useState("");
  const [portfolioPlanFilter, setPortfolioPlanFilter] = useState("all");
  const [importNotice, setImportNotice] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [importPreview, setImportPreview] = useState(null);
  const portfolioImportInput = useRef(null);
  const metrics = useMemo(() => portfolioMetrics(positions, liveQuotes), [positions, liveQuotes]);
  const allocationRows = useMemo(() => portfolioAllocationRows(positions, liveQuotes), [positions, liveQuotes]);
  const sortedPortfolioRows = useMemo(() => sortPortfolioRows(metrics.rows, portfolioSortKey, portfolioSortDirection), [metrics.rows, portfolioSortKey, portfolioSortDirection]);
  const filteredPortfolioRows = useMemo(() => {
    const query = portfolioQuery.trim().toLocaleLowerCase();
    return sortedPortfolioRows.filter((row) => {
      const matchesQuery = !query || [row.symbol, row.name, row.market, row.planThesis].some((value) => String(value || "").toLocaleLowerCase().includes(query));
      const matchesPlan = portfolioPlanFilter === "all" || (portfolioPlanFilter === "none" ? !row.planStatus || row.planStatus === "none" : row.planStatus === portfolioPlanFilter);
      return matchesQuery && matchesPlan;
    });
  }, [portfolioPlanFilter, portfolioQuery, sortedPortfolioRows]);
  const risk = useMemo(() => portfolioRiskMetrics(positions, liveQuotes), [positions, liveQuotes]);
  const performanceSeries = useMemo(() => portfolioPerformanceSeries(portfolioReviews), [portfolioReviews]);
  const performanceChart = useMemo(() => {
    if (performanceSeries.length < 2) return null;
    const values = performanceSeries.map((point) => point.totalPnlPercent);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    const points = performanceSeries.map((point, index) => ({
      ...point,
      x: performanceSeries.length === 1 ? 320 : 20 + (index / (performanceSeries.length - 1)) * 600,
      y: 148 - ((point.totalPnlPercent - min) / range) * 116,
    }));
    const zeroY = Math.min(148, Math.max(32, 148 - ((0 - min) / range) * 116));
    return { points, min, max, zeroY, first: points[0], latest: points.at(-1) };
  }, [performanceSeries]);
  const realDataMode = hasRealDataAccess(integrationStatus);
  const portfolioDataState = resolveLiveDataState({ configured: realDataMode, loading: liveDataLoading, error: liveDataError, receivedCount: metrics.pricedCount, totalCount: metrics.totalCount });
  const money = (value) => value == null ? "—" : formatPrice(value);
  const generateReview = async () => {
    setReviewNotice("");
    try {
      const review = await createPortfolioReview();
      setReviewNotice(`已保存 ${review.tradingDate} 复盘；仅使用 ${review.pricedCount}/${review.totalCount} 个持仓的真实行情。`);
    } catch (reviewError) { setReviewNotice(errorMessage(reviewError)); }
  };
  const generatePremarket = () => {
    setReviewNotice("");
    void generatePremarketBriefing().then((ok) => {
      if (ok) setReviewNotice("盘前摘要已更新；只展示已返回的真实持仓公告与事件。");
    }).catch((briefingError) => setReviewNotice(errorMessage(briefingError)));
  };
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
    setForm({ symbol: position.symbol, name: position.name, market: position.market, quantity: String(position.quantity), averageCost: String(position.averageCost), takeProfitPrice: position.takeProfitPrice == null ? "" : String(position.takeProfitPrice), stopLossPrice: position.stopLossPrice == null ? "" : String(position.stopLossPrice), planThesis: position.planThesis || "", planHorizon: position.planHorizon || "" });
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
    try { await removePortfolioPosition(position.id); }
    catch (actionError) { setError(actionError?.message || "暂时无法删除这笔持仓，请稍后重试。"); }
  };
  const updateSchedule = (input) => {
    setReviewNotice("");
    void updateBriefingSchedule(input).catch((actionError) => setReviewNotice(errorMessage(actionError)));
  };
  const deleteReview = (id) => {
    setReviewNotice("");
    void removePortfolioReview(id).catch((actionError) => setReviewNotice(errorMessage(actionError)));
  };
  const markPlan = async (position, status) => {
    try { await updatePortfolioPlanStatus(position.id, status, status === "executed" ? "用户确认已执行计划" : "重新开启计划跟踪"); }
    catch (actionError) { setError(actionError?.message || "暂时无法更新交易计划，请稍后重试。"); }
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
  const importPortfolioFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setImportBusy(true);
    setImportNotice("");
    try {
      const parsed = parsePortfolioImport(await readTextFile(file));
      if (!parsed.items.length) throw new Error(parsed.errors.length ? `没有可导入的有效持仓（${parsed.errors[0].reason}）` : "文件中没有持仓记录");
      setImportPreview({ fileName: file.name || "持仓文件", ...parsed });
    } catch (importError) {
      setImportNotice(importError?.message || "暂时无法导入持仓，请检查文件后重试。");
    } finally {
      setImportBusy(false);
    }
  };
  const confirmPortfolioImport = async () => {
    if (!importPreview?.items?.length) return;
    setImportBusy(true);
    setImportNotice("");
    try {
      const imported = await importPortfolioItems(importPreview.items);
      const detail = [importPreview.skipped ? `检测到 ${importPreview.skipped} 条重复记录，已采用最后一条` : "", importPreview.errors?.length ? `另有 ${importPreview.errors.length} 条无效记录` : ""].filter(Boolean).join("；");
      setImportNotice(`已导入 ${imported.length} 个持仓${detail ? ` · ${detail}` : ""}。现价仍需重新获取真实行情。`);
      setImportPreview(null);
    } catch (importError) {
      setImportNotice(importError?.message || "暂时无法导入持仓，请稍后重试。导入预览仍然保留。");
    } finally {
      setImportBusy(false);
    }
  };
  return <div className="secondary-page portfolio-page"><header><div><h1>投资组合</h1><p>持仓、市值与未实现盈亏</p></div><div className="page-header-actions"><button className="secondary-button" onClick={generatePremarket} disabled={!positions.length || premarketBriefingLoading}><CalendarBlank size={17} />{premarketBriefingLoading ? "获取中…" : "盘前摘要"}</button><button className="secondary-button" onClick={() => { void generateReview(); }} disabled={!positions.length}><CalendarDots size={17} />生成复盘</button><button className="secondary-button" onClick={exportReport} disabled={!positions.length}><DownloadSimple size={17} />导出报告</button><button className="secondary-button" onClick={() => portfolioImportInput.current?.click()} disabled={importBusy}><UploadSimple size={17} />{importBusy ? "导入中…" : "导入持仓"}</button><button className="primary-action" onClick={openCreate}><Plus size={17} />添加持仓</button></div></header>
    <input ref={portfolioImportInput} className="visually-hidden" type="file" accept=".csv,text/csv" aria-label="导入持仓文件" onChange={(event) => { void importPortfolioFile(event); }} />
    <p className="security-note">只使用已返回的真实行情计算；缺少现价的持仓会显示为“—”，不会用预览数字填充。导入支持 FolioMind 导出 CSV 或最小字段 CSV（代码、名称、市场、数量、平均成本）。</p>
    {importNotice ? <p className="portfolio-import-notice" role="status">{importNotice}</p> : null}
    {importPreview ? <section className="portfolio-import-preview" role="dialog" aria-modal="false" aria-labelledby="portfolio-import-title"><div className="portfolio-import-preview-heading"><div><h2 id="portfolio-import-title">确认导入持仓</h2><p title={importPreview.fileName}>{importPreview.fileName}</p></div><button type="button" className="icon-button" aria-label="关闭导入预览" onClick={() => setImportPreview(null)} disabled={importBusy}><X size={18} /></button></div><div className="portfolio-import-preview-summary"><strong>{importPreview.items.length} 个持仓将被写入</strong><span>{importPreview.skipped ? `${importPreview.skipped} 条重复记录采用最后一条` : "没有重复记录"}</span><span>{importPreview.errors?.length ? `${importPreview.errors.length} 条无效记录不会写入` : "所有记录均通过校验"}</span></div><p className="portfolio-import-preview-help">同一代码会更新现有持仓并保留其本地 ID；现价、市值、盈亏和数据时间等运行时字段不会导入。取消不会修改当前组合。</p>{importPreview.errors?.length ? <details className="portfolio-import-errors"><summary>查看无效行（显示前 5 条）</summary><ul>{importPreview.errors.slice(0, 5).map((item) => <li key={`${item.line}-${item.reason}`}>第 {item.line} 行：{item.reason}</li>)}</ul></details> : null}<div className="portfolio-import-preview-actions"><button type="button" className="secondary-button" onClick={() => setImportPreview(null)} disabled={importBusy}>取消</button><button type="button" className="primary-action" onClick={() => { void confirmPortfolioImport(); }} disabled={importBusy}>{importBusy ? "保存中…" : "确认导入"}</button></div></section> : null}
    <section className="portfolio-summary" aria-label="组合概览">
      <article className="portfolio-card"><span>当前市值</span><strong>{money(metrics.totalMarketValue)}</strong><small>{metrics.pricedCount ? `${metrics.pricedCount}/${metrics.totalCount} 个持仓有行情` : "等待真实行情"}</small></article>
      <article className="portfolio-card"><span>持仓成本</span><strong>{money(metrics.totalCost)}</strong><small>{metrics.totalCount ? `${metrics.totalCount} 个持仓` : "尚未添加持仓"}</small></article>
      <article className={`portfolio-card ${metrics.totalPnl == null ? "" : metrics.totalPnl >= 0 ? "positive" : "negative"}`}><span>未实现盈亏</span><strong>{money(metrics.totalPnl)}</strong><small>{metrics.totalPnlPercent == null ? "等待真实行情" : formatPercent(metrics.totalPnlPercent)}</small></article>
      <article className="portfolio-card"><span>行情覆盖</span><strong>{metrics.totalCount ? `${metrics.pricedCount}/${metrics.totalCount}` : "—"}</strong><small>{realDataMode ? "自动定时更新" : "配置数据模型后更新"}</small></article>
    </section>
    <section className="allocation-overview" aria-label="组合分布"><div className="allocation-overview-heading"><div><h2>组合分布</h2><small>按已返回的真实市值计算，未计价持仓不会被估算。</small></div><span>{allocationRows.length}/{metrics.totalCount} 个持仓已计价</span></div>{allocationRows.length === 0 ? <p className="risk-empty">获取至少一笔持仓的真实现价后，这里会显示市值占比。</p> : <div className="allocation-list">{allocationRows.map((row) => <div className="allocation-row" key={row.id}><div className="allocation-row-heading"><span><strong>{row.name}</strong><small>{row.symbol}</small></span><b>{formatPercent(row.weight, { signed: false })}</b></div><div className="allocation-track" aria-hidden="true"><span style={{ width: `${Math.min(100, Math.max(0, row.weight))}%` }} /></div><small className="allocation-value">{money(row.marketValue)} 市值</small></div>)}</div>}{allocationRows.length < metrics.totalCount ? <p className="allocation-note">另有 {metrics.totalCount - allocationRows.length} 个持仓暂未返回真实现价，未纳入分布比例。</p> : null}</section>
    <section className="risk-overview" aria-label="组合风险洞察">
      <div className="risk-overview-heading"><div><h2>风险洞察</h2><small>只基于已返回的真实行情；数据不足时不生成风险评分。</small></div><ShieldCheck size={22} /></div>
      {positions.length === 0 ? <p className="risk-empty">添加持仓并获取真实行情后，这里会显示集中度与数据覆盖情况。</p> : <><div className="risk-metrics"><article><span>最大持仓</span><strong>{risk.topPosition?.name || "—"}</strong><small>{risk.topWeight == null ? "等待真实行情" : `${formatPercent(risk.topWeight, { signed: false })} 组合占比`}</small></article><article><span>行情覆盖</span><strong>{risk.pricedCoverage == null ? "—" : formatPercent(risk.pricedCoverage, { signed: false })}</strong><small>{metrics.pricedCount}/{metrics.totalCount} 个持仓</small></article><article><span>未计价成本</span><strong>{risk.missingCostWeight == null ? "—" : formatPercent(risk.missingCostWeight, { signed: false })}</strong><small>{risk.missingCostWeight == null ? "等待真实行情" : "暂未纳入市值计算"}</small></article></div><div className="risk-metrics risk-history-metrics"><article><span>加权波动（样本）</span><strong>{risk.weightedVolatility == null ? "—" : `${risk.weightedVolatility.toFixed(2)}%`}</strong><small>{risk.weightedVolatility == null ? "至少需要 3 个历史收益点" : `${risk.historicalSampleCount} 个历史收益点 · 未年化`}</small></article><article><span>平均相关性</span><strong>{risk.averageCorrelation == null ? "—" : risk.averageCorrelation.toFixed(2)}</strong><small>{risk.correlationPairs ? `${risk.correlationPairs} 组持仓重叠计算` : "至少需要两组重叠序列"}</small></article><article><span>历史数据覆盖</span><strong>{risk.historicalCoverage == null ? "—" : formatPercent(risk.historicalCoverage, { signed: false })}</strong><small>{risk.historicalCount ? `${risk.historicalCount} 个持仓可计算` : "暂无可计算历史"}</small></article></div><div className="risk-signal-list">{risk.signals.length ? risk.signals.map((signal) => <article className={`risk-signal ${signal.level}`} key={`${signal.level}-${signal.title}`}><span>{signal.level === "critical" ? <Warning size={17} /> : signal.level === "warning" ? <Warning size={17} /> : <Info size={17} />}</span><div><strong>{signal.title}</strong><p>{signal.detail}</p></div></article>) : <p className="risk-empty">当前没有可确认的风险信号；补齐历史行情后才会计算波动率与相关性。</p>}</div></>}
    </section>
    <section className="portfolio-performance-overview" aria-label="组合表现趋势">
      <div className="portfolio-performance-heading"><div><h2>组合表现趋势</h2><small>仅连接已保存的真实盘后复盘；按交易日保留最新快照，不补齐缺失日期。</small></div><span>{performanceSeries.length ? `${performanceSeries.length} 个有效快照` : "暂无趋势"}</span></div>
      {!performanceChart ? <p className="portfolio-performance-empty">{portfolioReviews.length < 2 ? "生成至少两次真实复盘后，这里会显示盈亏比例趋势。" : "已有复盘，但有效盈亏比例不足两次，暂不绘制趋势。"}</p> : <><div className="portfolio-performance-chart"><svg viewBox="0 0 640 180" role="img" aria-label={`组合盈亏比例从 ${formatPercent(performanceChart.first.totalPnlPercent)} 变为 ${formatPercent(performanceChart.latest.totalPnlPercent)}`}><line x1="20" y1="148" x2="620" y2="148" /><line x1="20" y1="32" x2="20" y2="148" /><polyline points={performanceChart.points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ")} /><line className="portfolio-performance-zero" x1="20" x2="620" y1={performanceChart.zeroY.toFixed(1)} y2={performanceChart.zeroY.toFixed(1)} />{performanceChart.points.map((point) => <circle key={point.id} cx={point.x} cy={point.y} r="4"><title>{point.tradingDate} · {formatPercent(point.totalPnlPercent)}</title></circle>)}</svg><div className="portfolio-performance-axis"><span>{performanceChart.first.tradingDate} · {formatPercent(performanceChart.first.totalPnlPercent)}</span><span>{performanceChart.latest.tradingDate} · {formatPercent(performanceChart.latest.totalPnlPercent)}</span></div></div><div className="portfolio-performance-summary"><article><span>起点</span><strong>{formatPercent(performanceChart.first.totalPnlPercent)}</strong><small>{performanceChart.first.tradingDate}</small></article><article><span>最近</span><strong className={performanceChart.latest.totalPnlPercent >= 0 ? "up" : "down"}>{formatPercent(performanceChart.latest.totalPnlPercent)}</strong><small>{performanceChart.latest.tradingDate}</small></article><article><span>变化</span><strong className={performanceChart.latest.totalPnlPercent - performanceChart.first.totalPnlPercent >= 0 ? "up" : "down"}>{formatPercent(performanceChart.latest.totalPnlPercent - performanceChart.first.totalPnlPercent)}</strong><small>盈亏比例百分点</small></article></div></>}
    </section>
    <section className="plan-overview" aria-label="交易计划概览">
      <div className="plan-overview-heading"><div><h2>交易计划</h2><small>记录买入逻辑与目标价；只做提醒和留痕，不会自动下单。</small></div><CheckCircle size={22} /></div>
      <div className="plan-metrics"><article><span>跟踪中</span><strong>{positions.filter((position) => position.planStatus === "active").length}</strong><small>需要持续观察</small></article><article><span>已执行</span><strong>{positions.filter((position) => position.planStatus === "executed").length}</strong><small>保留操作记录</small></article><article><span>未建立</span><strong>{positions.filter((position) => !position.planStatus || position.planStatus === "none").length}</strong><small>可在编辑中补充</small></article></div>
    </section>
    <section className="premarket-briefing-overview" aria-label="盘前数据摘要">
      <div className="premarket-briefing-heading"><div><h2>盘前数据摘要</h2><small>聚合持仓新闻、行业与宏观动态、海外指数和大宗商品；仅展示已连接数据服务返回的真实数据。</small></div><div className="premarket-briefing-actions">{premarketBriefing?.asOf ? <span>最近数据 {premarketBriefing.asOf}</span> : null}<button type="button" className="secondary-button" onClick={premarketBriefingLoading ? cancelPremarketBriefing : generatePremarket} disabled={!positions.length}>{premarketBriefingLoading ? "停止更新" : "刷新摘要"}</button></div></div>
      {premarketBriefingError ? <p className="premarket-briefing-status" role="status">{premarketBriefingError}</p> : null}
      {!positions.length ? <p className="risk-empty">添加持仓后，这里会聚合真实公告与事件。</p> : premarketBriefingLoading ? <p className="risk-empty">正在按持仓获取真实新闻与公司事件，请稍候…</p> : !premarketBriefing ? <p className="risk-empty">点击“盘前摘要”获取真实数据；没有返回结果时不会显示示例内容。</p> : <div className="premarket-briefing-grid">{Object.values(premarketBriefing.sections).map((section) => <article className={`premarket-briefing-section ${section.status}`} key={section.id}><div><strong>{section.title}</strong><small>{section.status === "available" ? `${section.items.length} 条真实记录` : "暂无数据"}</small></div>{section.items.length ? <ul>{section.items.slice(0, 12).map((item, index) => { const sourceUrl = safeExternalUrl(item.url); return <li key={`${item.symbol}-${item.title}-${index}`}><div><strong>{item.title || item.detail || "未命名记录"}</strong><small>{item.name || item.symbol}{item.date || item.publishedAt ? ` · ${item.date || item.publishedAt}` : ""} · {item.source || "数据服务"}</small>{item.summary && item.summary !== item.title ? <p>{item.summary}</p> : item.detail && item.detail !== item.title ? <p>{item.detail}</p> : null}</div>{sourceUrl ? <a href={sourceUrl} target="_blank" rel="noreferrer">来源</a> : null}</li>; })}</ul> : <p>{section.emptyCopy}</p>}</article>)}</div>}
      {premarketBriefing ? <small className="security-note">{premarketBriefing.disclaimer}{premarketBriefing.sources.length ? ` · 来源：${premarketBriefing.sources.join("、")}` : ""}</small> : null}
    </section>
    <section className="briefing-automation-overview" aria-label="盘前自动摘要">
      <div className="briefing-schedule-card"><div><strong>自动生成盘前摘要</strong><small>{nextPremarketLabel(briefingSchedule)} · 先核对真实交易日历；休市或无持仓时不会生成。</small>{briefingSchedule.calendarDate ? <small>日历：{briefingSchedule.calendarDate} · {briefingSchedule.calendarStatus === "trading" ? "交易日" : briefingSchedule.calendarStatus === "closed" ? "休市" : "待核实"} · {briefingSchedule.calendarSource || "数据服务"}</small> : null}</div><label className="briefing-time">执行时间<input type="time" aria-label="自动盘前摘要时间" value={briefingSchedule.premarketTime} disabled={!briefingSchedule.premarketEnabled} onChange={(event) => updateBriefingSchedule({ premarketTime: event.target.value })} /></label><label className="briefing-toggle"><input type="checkbox" checked={briefingSchedule.premarketEnabled} onChange={(event) => updateBriefingSchedule({ premarketEnabled: event.target.checked })} />{briefingSchedule.premarketEnabled ? "已启用" : "未启用"}</label><button type="button" className="secondary-button" disabled={!briefingSchedule.premarketEnabled || premarketBriefingScheduleBusy} onClick={() => { void (runDuePremarketBriefing()); }}>{premarketBriefingScheduleBusy ? "执行中…" : "立即检查"}</button></div>
      {briefingSchedule.premarketEnabled && briefingSchedule.premarketLastResult !== "idle" ? <p className={`briefing-schedule-status ${briefingSchedule.premarketLastResult}`} role="status">{briefingSchedule.premarketLastResult === "success" ? "最近一次自动盘前摘要已完成" : briefingSchedule.premarketLastResult === "waiting-data" ? "正在等待真实盘前数据" : briefingSchedule.premarketLastResult === "waiting-calendar" ? "正在等待交易日历恢复" : briefingSchedule.premarketLastResult === "market-closed" ? "交易所休市，本日不会生成盘前摘要" : "最近一次盘前摘要未完成"}{briefingSchedule.premarketLastAttemptAt ? ` · ${new Date(briefingSchedule.premarketLastAttemptAt).toLocaleString("zh-CN")}` : ""}{briefingSchedule.premarketLastError ? ` · ${briefingSchedule.premarketLastError}` : ""}</p> : null}
    </section>
    <section className="portfolio-review-overview" aria-label="盘后复盘记录">
      <div className="portfolio-review-heading"><div><h2>盘后复盘</h2><small>保存当前真实行情快照、组合表现、风险信号和未来 7 天已返回事件。</small></div><span>{portfolioReviews.length} 份记录</span></div>
      <div className="briefing-schedule-card"><div><strong>自动生成盘后复盘</strong><small>{nextBriefingLabel(briefingSchedule)} · 先核对真实交易日历；休市或无当日真实行情不会生成。</small>{briefingSchedule.calendarDate ? <small>日历：{briefingSchedule.calendarDate} · {briefingSchedule.calendarStatus === "trading" ? "交易日" : briefingSchedule.calendarStatus === "closed" ? "休市" : "待核实"} · {briefingSchedule.calendarSource || "数据服务"}</small> : null}</div><label className="briefing-time">执行时间<input type="time" aria-label="自动复盘时间" value={briefingSchedule.closeTime} disabled={!briefingSchedule.enabled} onChange={(event) => updateSchedule({ closeTime: event.target.value })} /></label><label className="briefing-toggle"><input type="checkbox" checked={briefingSchedule.enabled} onChange={(event) => updateSchedule({ enabled: event.target.checked })} />{briefingSchedule.enabled ? "已启用" : "未启用"}</label><button type="button" className="secondary-button" disabled={!briefingSchedule.enabled || briefingScheduleBusy} onClick={() => { void (isDesktopRuntime() ? reconcileDesktopNow() : runDuePortfolioReview()); }}>{briefingScheduleBusy ? "执行中…" : "立即检查"}</button></div>
      {briefingSchedule.enabled && briefingSchedule.lastResult !== "idle" ? <p className={`briefing-schedule-status ${briefingSchedule.lastResult}`} role="status">{briefingSchedule.lastResult === "success" ? "最近一次自动复盘已完成" : briefingSchedule.lastResult === "waiting-data" ? "正在等待可用的当日真实行情" : briefingSchedule.lastResult === "waiting-calendar" ? "正在等待交易日历恢复" : briefingSchedule.lastResult === "market-closed" ? "交易所休市，本日不会生成复盘" : "最近一次执行未完成"}{briefingSchedule.lastAttemptAt ? ` · ${new Date(briefingSchedule.lastAttemptAt).toLocaleString("zh-CN")}` : ""}{briefingSchedule.lastError ? ` · ${briefingSchedule.lastError}` : ""}</p> : null}
      {reviewNotice ? <p className="portfolio-review-notice" role="status">{reviewNotice}</p> : null}
      {portfolioReviews.length === 0 ? <p className="risk-empty">刷新持仓真实行情后生成第一份复盘；缺失行情不会被估算。</p> : <div className="portfolio-review-list">{portfolioReviews.slice(0, 12).map((review) => <details className="portfolio-review-card" key={review.id}><summary><div><strong>{review.tradingDate} 盘后复盘</strong><small>行情覆盖 {review.pricedCount}/{review.totalCount} · 数据截至 {review.asOf || "未知"}</small></div><div className={review.totalPnl == null ? "" : review.totalPnl >= 0 ? "up" : "down"}><strong>{money(review.totalPnl)}</strong><small>{review.totalPnlPercent == null ? "—" : formatPercent(review.totalPnlPercent)}</small></div></summary><div className="portfolio-review-body"><div className="portfolio-review-metrics"><article><span>组合市值</span><strong>{money(review.totalMarketValue)}</strong></article><article><span>表现最好</span><strong>{review.topGainer?.name || "—"}</strong><small>{review.topGainer?.pnlPercent == null ? "—" : formatPercent(review.topGainer.pnlPercent)}</small></article><article><span>表现最弱</span><strong>{review.topLoser?.name || "—"}</strong><small>{review.topLoser?.pnlPercent == null ? "—" : formatPercent(review.topLoser.pnlPercent)}</small></article></div>{review.riskSignals?.length ? <div className="portfolio-review-section"><strong>风险信号</strong>{review.riskSignals.map((signal, index) => <p key={`${review.id}-risk-${index}`}>{signal.title}：{signal.detail}</p>)}</div> : null}{review.upcomingEvents?.length ? <div className="portfolio-review-section"><strong>未来 7 天事件</strong>{review.upcomingEvents.map((event, index) => <p key={`${review.id}-event-${index}`}>{event.date} · {event.name} · {event.title}（{event.source}）</p>)}</div> : <p className="portfolio-review-empty">当前没有已返回的未来 7 天持仓事件。</p>}<p className="portfolio-review-sources">来源：{review.sources?.join("、") || "数据服务"} · {review.disclaimer}</p><button type="button" className="notification-link" onClick={() => deleteReview(review.id)}>删除本条复盘</button></div></details>)}</div>}
    </section>
    {positions.length > 0 && portfolioDataState !== DATA_STATES.SUCCESS ? <LiveDataState compact state={portfolioDataState} receivedCount={metrics.pricedCount} totalCount={metrics.totalCount} onRetry={() => { void refreshLiveData(); }} onCancel={cancelLiveDataRefresh} onSettings={() => setActiveView("settings")} /> : null}
    {positions.length === 0 ? <div className="empty-state portfolio-empty"><Briefcase size={30} /><strong>还没有持仓</strong><p>添加持仓后，这里会汇总真实行情与盈亏。</p><button className="primary-action" onClick={openCreate}><Plus size={16} />添加第一笔持仓</button></div> : <section className="portfolio-table" aria-label="持仓明细"><div className="portfolio-table-toolbar"><div><h2>持仓明细</h2><small>显示 {filteredPortfolioRows.length}/{positions.length} 个持仓；排序只作用于当前结果，缺失值保持在末尾。</small></div><label className="portfolio-search"><span>搜索</span><input type="search" aria-label="搜索持仓" value={portfolioQuery} onChange={(event) => setPortfolioQuery(event.target.value)} placeholder="名称、代码或市场" /></label><label><span>计划</span><select aria-label="计划状态筛选" value={portfolioPlanFilter} onChange={(event) => setPortfolioPlanFilter(event.target.value)}><option value="all">全部</option><option value="active">跟踪中</option><option value="executed">已执行</option><option value="none">未建立</option></select></label><label><span>排序</span><select aria-label="持仓排序" value={portfolioSortKey} onChange={(event) => setPortfolioSortKey(event.target.value)}>{PORTFOLIO_SORT_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label><button className="portfolio-sort-direction" type="button" disabled={portfolioSortKey === "default"} aria-label={portfolioSortDirection === "asc" ? "切换为降序" : "切换为升序"} onClick={() => setPortfolioSortDirection((value) => value === "asc" ? "desc" : "asc")}>{portfolioSortDirection === "asc" ? "升序 ↑" : "降序 ↓"}</button></div>{filteredPortfolioRows.length === 0 ? <div className="portfolio-filter-empty" role="status"><Funnel size={22} /><strong>没有符合条件的持仓</strong><p>调整搜索词或计划筛选；持仓数据没有被删除。</p><button type="button" className="secondary-button" onClick={() => { setPortfolioQuery(""); setPortfolioPlanFilter("all"); }}>清除筛选</button></div> : <><div className="portfolio-table-head"><span>标的</span><span>数量</span><span>成本</span><span>现价</span><span>市值</span><span>未实现盈亏</span><span>占比</span><span>交易计划 / 提醒</span><span>操作</span></div>{filteredPortfolioRows.map((row) => <div className="portfolio-row" key={row.id}><span><strong>{row.name}</strong><small>{row.symbol}{row.market ? ` · ${row.market}` : ""}</small></span><span>{row.quantity}</span><span>{money(row.averageCost)}</span><span>{money(row.currentPrice)}</span><span>{money(row.marketValue)}</span><span className={row.pnl == null ? "" : row.pnl >= 0 ? "up" : "down"}>{money(row.pnl)}{row.pnlPercent == null ? "" : ` (${formatPercent(row.pnlPercent)})`}</span><span>{row.weight == null ? "—" : formatPercent(row.weight, { signed: false })}</span><span className="portfolio-alert-plan"><small className={`portfolio-plan-status ${row.planStatus || "none"}`}>{PORTFOLIO_PLAN_STATUSES.find((status) => status.id === row.planStatus)?.label || "未建立计划"}{row.planHorizon ? ` · ${PORTFOLIO_PLAN_HORIZONS.find((horizon) => horizon.id === row.planHorizon)?.label.split("（")[0] || row.planHorizon}` : ""}</small>{row.planThesis ? <small className="portfolio-plan-thesis" title={row.planThesis}>{row.planThesis}</small> : null}{row.planActions?.[0] ? <small className="portfolio-plan-action">最近：{planActionLabels[row.planActions[0].type] || "更新"} · {new Date(row.planActions[0].at).toLocaleDateString("zh-CN")}</small> : null}{row.takeProfitPrice == null && row.stopLossPrice == null ? <small>未设置价格提醒</small> : <>{row.takeProfitPrice != null && <small className={row.takeProfitTriggered ? "triggered" : ""}>止盈 {money(row.takeProfitPrice)}{row.takeProfitTriggered ? " · 已触发" : row.planProgress.targetDistancePercent == null ? "" : ` · 距 ${formatPercent(row.planProgress.targetDistancePercent)}`}</small>}{row.stopLossPrice != null && <small className={row.stopLossTriggered ? "triggered stop" : "stop"}>止损 {money(row.stopLossPrice)}{row.stopLossTriggered ? " · 已触发" : row.planProgress.stopDistancePercent == null ? "" : ` · 距 ${formatPercent(row.planProgress.stopDistancePercent)}`}</small>}</>}</span><span className="portfolio-actions"><button className="icon-button" aria-label={`编辑${row.symbol}持仓`} onClick={() => openEdit(row)}>编辑</button>{row.planStatus === "active" && <button className="icon-button" aria-label={`标记${row.symbol}计划已执行`} onClick={() => { void markPlan(row, "executed"); }}>已执行</button>}{row.planStatus === "executed" && <button className="icon-button" aria-label={`重新跟踪${row.symbol}计划`} onClick={() => { void markPlan(row, "active"); }}>重启</button>}<button className="icon-button" aria-label={`删除${row.symbol}持仓`} onClick={() => { void deletePosition(row); }}>删除</button></span></div>)}</>}</section>}
    {dialogOpen && <div className="modal-backdrop" role="presentation"><form className="modal-card portfolio-modal" onSubmit={submit}><div className="modal-heading"><h2>{editing ? "编辑持仓" : "添加持仓"}</h2><button type="button" className="icon-button" aria-label="关闭" onClick={() => setDialogOpen(false)}><X size={18} /></button></div><p className="modal-help">保存后会使用真实行情计算市值与未实现盈亏；达到提醒价只通知你，不会自动下单。</p><label>标的<select aria-label="持仓标的" value={form.symbol} onChange={(event) => selectSymbol(event.target.value)} required>{!form.symbol && <option value="">请选择标的</option>}{watchlist.map((item) => <option key={item.symbol} value={item.symbol}>{item.name}（{item.symbol}）</option>)}{editing && !watchlist.some((item) => item.symbol === editing.symbol) && <option value={editing.symbol}>{editing.name}（{editing.symbol}）</option>}</select></label><label>持仓数量<input aria-label="持仓数量" type="number" min="0.0001" step="any" value={form.quantity} onChange={(event) => setForm((value) => ({ ...value, quantity: event.target.value }))} required /></label><label>平均成本<input aria-label="平均成本" type="number" min="0.01" step="0.01" value={form.averageCost} onChange={(event) => setForm((value) => ({ ...value, averageCost: event.target.value }))} required /></label><div className="portfolio-alert-fields"><label>止盈价（可选）<input aria-label="止盈价" type="number" min="0.01" step="0.01" placeholder="达到后提醒" value={form.takeProfitPrice} onChange={(event) => setForm((value) => ({ ...value, takeProfitPrice: event.target.value }))} /></label><label>止损价（可选）<input aria-label="止损价" type="number" min="0.01" step="0.01" placeholder="跌破后提醒" value={form.stopLossPrice} onChange={(event) => setForm((value) => ({ ...value, stopLossPrice: event.target.value }))} /></label></div><div className="portfolio-plan-fields"><label>买入逻辑（可选）<textarea aria-label="买入逻辑" rows="3" maxLength="2000" placeholder="记录这笔交易想验证的逻辑" value={form.planThesis} onChange={(event) => setForm((value) => ({ ...value, planThesis: event.target.value }))} /></label><label>计划周期（可选）<select aria-label="计划周期" value={form.planHorizon} onChange={(event) => setForm((value) => ({ ...value, planHorizon: event.target.value }))}><option value="">请选择周期</option>{PORTFOLIO_PLAN_HORIZONS.map((horizon) => <option key={horizon.id} value={horizon.id}>{horizon.label}</option>)}</select></label></div>{error && <p className="form-error" role="alert">{error}</p>}<button className="primary-action" type="submit" disabled={busy}>{busy ? "保存中…" : "保存持仓"}</button></form></div>}
  </div>;
}

function AnomalyAttribution({ anomaly, attribution, loading, error, onExplain }) {
  if (!attribution && !loading && !error) return <button className="anomaly-explain-button" type="button" onClick={onExplain}>AI 解读</button>;
  return <div className="anomaly-attribution" aria-live="polite">
    <div className="anomaly-attribution-heading"><strong>证据解读</strong>{loading ? <span>正在聚合真实证据…</span> : <button className="anomaly-explain-button" type="button" onClick={onExplain}>重新解读</button>}</div>
    {error ? <div className="anomaly-attribution-error" role="status">{error}</div> : null}
    {loading ? <p className="anomaly-attribution-loading">正在查询已验证的新闻、公司事件和资金流能力；没有证据时不会猜测原因。</p> : null}
    {attribution ? <div className="anomaly-attribution-body">
      <div><b>异动事实</b><p>{attribution.fact}</p></div>
      <div><b>与持仓关系</b><p>{attribution.portfolioRelation}</p></div>
      <div><b>可能诱因</b>{attribution.drivers?.length ? <ul>{attribution.drivers.map((driver, index) => <li key={`${driver.text}-${index}`}><span>{driver.text}</span><small>{driver.references.map((reference) => reference.url ? <a key={`${reference.id}-${reference.url}`} href={reference.url} target="_blank" rel="noreferrer">{reference.source}{reference.title ? ` · ${reference.title}` : ""}</a> : <em key={reference.id}>{reference.source}{reference.title ? ` · ${reference.title}` : ""}</em>)}</small></li>)}</ul> : <p>暂无已验证证据，暂时不能确认异动原因。</p>}</div>
      {attribution.watchNext?.length ? <div><b>后续核验</b><ul>{attribution.watchNext.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul></div> : null}
      {attribution.asOf ? <small className="anomaly-attribution-asof">证据截至 {attribution.asOf} · 已聚合 {attribution.evidenceCount || 0} 条来源</small> : null}
      <small className="security-note">{attribution.disclaimer}</small>
    </div> : null}
  </div>;
}

export function MarketView() {
  const watchlist = useLabStore((state) => state.watchlist);
  const liveQuotes = useLabStore((state) => state.liveQuotes);
  const integrationStatus = useLabStore((state) => state.integrationStatus);
  const refreshLiveData = useLabStore((state) => state.refreshLiveData);
  const cancelLiveDataRefresh = useLabStore((state) => state.cancelLiveDataRefresh);
  const liveDataLoading = useLabStore((state) => state.liveDataLoading);
  const liveDataError = useLabStore((state) => state.liveDataError);
  const liveDataLastRefreshAt = useLabStore((state) => state.liveDataLastRefreshAt);
  const anomalyAttributions = useLabStore((state) => state.anomalyAttributions);
  const anomalyAttributionLoading = useLabStore((state) => state.anomalyAttributionLoading);
  const anomalyAttributionError = useLabStore((state) => state.anomalyAttributionError);
  const explainAnomaly = useLabStore((state) => state.explainAnomaly);
  const setActiveView = useLabStore((state) => state.setActiveView);
  const selectSymbol = useLabStore((state) => state.selectSymbol);
  const [marketColumns, setMarketColumns] = useState(loadMarketColumns);
  const [marketViews, setMarketViews] = useState(loadMarketViews);
  const [activeMarketViewId, setActiveMarketViewId] = useState(() => {
    const columns = loadMarketColumns();
    return loadMarketViews().find((view) => columnsMatch(view.columns, columns))?.id || CUSTOM_MARKET_VIEW_ID;
  });
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [viewSaveOpen, setViewSaveOpen] = useState(false);
  const [viewName, setViewName] = useState("");
  const [viewNotice, setViewNotice] = useState("");
  const realDataMode = hasRealDataAccess(integrationStatus);
  useEffect(() => {
    try { window.localStorage.setItem(MARKET_COLUMNS_STORAGE_KEY, JSON.stringify(marketColumns)); } catch { /* Storage may be disabled. */ }
  }, [marketColumns]);
  useEffect(() => {
    try {
      const customViews = marketViews.filter((view) => view.id.startsWith("custom-")).slice(0, 10);
      window.localStorage.setItem(MARKET_VIEWS_STORAGE_KEY, JSON.stringify(customViews));
    } catch { /* Storage may be disabled. */ }
  }, [marketViews]);
  const visibleColumns = MARKET_COLUMN_DEFINITIONS.filter((column) => marketColumns.includes(column.id));
  const setColumnsAndView = (columns) => {
    const next = normalizeMarketColumns(columns);
    setMarketColumns(next);
    setActiveMarketViewId(marketViews.find((view) => columnsMatch(view.columns, next))?.id || CUSTOM_MARKET_VIEW_ID);
  };
  const toggleMarketColumn = (columnId) => {
    const next = marketColumns.includes(columnId)
      ? marketColumns.length === 1 ? marketColumns : marketColumns.filter((id) => id !== columnId)
      : [...marketColumns, columnId];
    setColumnsAndView(next);
  };
  const selectMarketView = (viewId) => {
    const selected = marketViews.find((view) => view.id === viewId);
    if (!selected) return;
    setActiveMarketViewId(selected.id);
    setMarketColumns([...selected.columns]);
    setViewNotice("");
  };
  const saveMarketView = (event) => {
    event.preventDefault();
    const name = viewName.trim().slice(0, 32);
    if (!name) { setViewNotice("请输入视图名称"); return; }
    const existing = marketViews.find((view) => view.id.startsWith("custom-") && view.name === name);
    if (!existing && marketViews.filter((view) => view.id.startsWith("custom-")).length >= 10) {
      setViewNotice("最多保存 10 个自定义视图，请删除不用的视图后再试");
      return;
    }
    const id = existing?.id || createMarketViewId();
    const nextView = { id, name, columns: [...marketColumns] };
    setMarketViews((current) => existing ? current.map((view) => view.id === id ? nextView : view) : [...current, nextView]);
    setActiveMarketViewId(id);
    setViewName("");
    setViewSaveOpen(false);
    setViewNotice(`已保存“${name}”视图`);
  };
  const deleteMarketView = () => {
    const selected = marketViews.find((view) => view.id === activeMarketViewId);
    if (!selected?.id.startsWith("custom-")) return;
    const fallback = DEFAULT_MARKET_VIEWS[0];
    setMarketViews((current) => current.filter((view) => view.id !== selected.id));
    setActiveMarketViewId(fallback.id);
    setMarketColumns([...fallback.columns]);
    setViewNotice(`已删除“${selected.name}”视图`);
  };
  const returnedQuotes = watchlist.filter((item) => isValidQuotePrice(quoteForSymbol(liveQuotes, item.symbol)?.price));
  const breadth = useMemo(() => marketBreadth(watchlist, liveQuotes), [watchlist, liveQuotes]);
  const summary = useMemo(() => marketWatchlistSummary(watchlist, liveQuotes), [watchlist, liveQuotes]);
  const anomalies = useMemo(() => detectMarketAnomalies(watchlist, liveQuotes), [watchlist, liveQuotes]);
  const dataState = resolveLiveDataState({ configured: realDataMode, loading: liveDataLoading, error: liveDataError, receivedCount: returnedQuotes.length, totalCount: watchlist.length });
  const retry = () => { void refreshLiveData(); };
  const openSettings = () => setActiveView("settings");
  const openMarketSymbol = (event, symbol) => {
    if (event.type === "keydown" && event.key !== "Enter" && event.key !== " ") return;
    if (event.type === "keydown") event.preventDefault();
    selectSymbol(symbol);
  };
  return <div className="secondary-page"><header><div><h1>市场行情</h1><p>跨市场指数、自选与异动概览</p></div><div className="market-header-actions"><div className="market-view-controls" aria-label="行情视图"><label><span>视图</span><select aria-label="行情视图" value={activeMarketViewId} onChange={(event) => selectMarketView(event.target.value)}>{activeMarketViewId === CUSTOM_MARKET_VIEW_ID && <option value={CUSTOM_MARKET_VIEW_ID}>临时视图</option>}{marketViews.map((view) => <option value={view.id} key={view.id}>{view.name}</option>)}</select></label><button className="secondary-button" type="button" onClick={() => { setViewSaveOpen(true); setViewNotice(""); }}>保存视图</button>{activeMarketViewId.startsWith("custom-") && <button className="icon-button" type="button" aria-label="删除当前行情视图" onClick={deleteMarketView}>删除</button>}</div><div className="market-column-menu"><button className="secondary-button" type="button" aria-expanded={columnsOpen} aria-haspopup="true" onClick={() => setColumnsOpen((value) => !value)}><List size={16} />列设置</button>{columnsOpen && <div className="market-column-popover" role="group" aria-label="自选行情列设置"><strong>自选行情列</strong><small>只显示已返回的真实字段；空字段保持“—”。</small>{MARKET_COLUMN_DEFINITIONS.map((column) => <label key={column.id}><input type="checkbox" checked={marketColumns.includes(column.id)} disabled={marketColumns.includes(column.id) && marketColumns.length === 1} onChange={() => toggleMarketColumn(column.id)} />{column.label}</label>)}<button type="button" className="notification-link" onClick={() => setColumnsAndView(DEFAULT_MARKET_COLUMNS)}>恢复默认列</button></div>}</div><button className="secondary-button" onClick={realDataMode ? liveDataLoading ? cancelLiveDataRefresh : retry : openSettings}><ArrowsClockwise size={16} />{realDataMode ? liveDataLoading ? "停止更新" : "刷新真实数据" : "配置数据"}</button></div></header>
    {viewNotice && <p className="market-view-notice" role="status">{viewNotice}</p>}
    {viewSaveOpen && <div className="market-view-save-popover" role="dialog" aria-label="保存行情视图"><form onSubmit={saveMarketView}><label>视图名称<input autoFocus maxLength={32} value={viewName} onChange={(event) => { setViewName(event.target.value); setViewNotice(""); }} placeholder="例如 我的交易盘面" /></label><div><button type="button" className="secondary-button" onClick={() => setViewSaveOpen(false)}>取消</button><button type="submit" className="primary-action">保存</button></div></form></div>}
    {returnedQuotes.length > 0 && dataState !== DATA_STATES.SUCCESS ? <LiveDataState compact state={dataState} receivedCount={returnedQuotes.length} totalCount={watchlist.length} onRetry={retry} onCancel={cancelLiveDataRefresh} onSettings={openSettings} /> : null}
    <div className="index-board" aria-label="自选行情概览">{returnedQuotes.length > 0 ? returnedQuotes.map((item) => { const quote = quoteForSymbol(liveQuotes, item.symbol); const freshness = quoteFreshness(quote.asOf); return <article className="index-board-item" role="button" tabIndex="0" aria-label={`打开${item.name}详情`} onClick={(event) => openMarketSymbol(event, item.symbol)} onKeyDown={(event) => openMarketSymbol(event, item.symbol)} key={item.symbol}><span title={item.name}>{item.name} <small>{item.symbol}</small></span><strong>{formatPrice(quote.price)}</strong><small className={changeToneClass(quote.change)}>{formatPercent(quote.change)}</small><em className={`quote-source quote-source-${freshness.state}`}>{quote.source || "数据服务"} · {formatQuoteFreshness(quote.asOf, Date.now(), item.market)}</em></article>; }) : <LiveDataState state={dataState} receivedCount={0} totalCount={watchlist.length} onRetry={retry} onCancel={cancelLiveDataRefresh} onSettings={openSettings} />}</div>
    {returnedQuotes.length > 0 ? <section className="market-breadth" aria-label="自选市场宽度"><div className="market-breadth-heading"><div><h2>自选市场宽度</h2><p>仅统计已返回真实价格和涨跌幅的标的；缺失字段不会参与计算，已过期行情不参与当前统计。</p></div><span>{breadth.pricedCount}/{breadth.totalCount} 有行情</span></div><div className="market-breadth-grid"><article><span>上涨</span><strong className="up">{breadth.upCount}</strong><small>有涨跌幅的标的</small></article><article><span>下跌</span><strong className="down">{breadth.downCount}</strong><small>有涨跌幅的标的</small></article><article><span>平盘</span><strong>{breadth.flatCount}</strong><small>{breadth.changeCount ? `共 ${breadth.changeCount} 个可比较` : "涨跌幅暂无"}</small></article><article><span>最大涨幅</span>{breadth.topGainer ? <><strong className="up">{formatPercent(breadth.topGainer.change)}</strong><small>{breadth.topGainer.name} · {breadth.topGainer.symbol}</small></> : <><strong>—</strong><small>暂无可比较数据</small></>}</article><article><span>最大跌幅</span>{breadth.topLoser ? <><strong className="down">{formatPercent(breadth.topLoser.change)}</strong><small>{breadth.topLoser.name} · {breadth.topLoser.symbol}</small></> : <><strong>—</strong><small>暂无可比较数据</small></>}</article></div>{breadth.staleCount > 0 ? <p className="market-breadth-note">另有 {breadth.staleCount} 个标的行情已过期，不参与当前统计；刷新后会自动恢复。</p> : null}{breadth.missingCount > 0 ? <p className="market-breadth-note">另有 {breadth.missingCount} 个标的暂未返回有效价格，保持为空并会在下一次刷新时重试。</p> : null}</section> : null}
    {returnedQuotes.length > 0 ? <section className="anomaly-radar" aria-label="异动雷达"><div className="anomaly-radar-heading"><div><h2>异动雷达</h2><p>基于当前已返回的真实行情，自动识别价格与量能异常；已过期行情不产生新的异动。</p></div><span>{anomalies.length ? `${anomalies.length} 条` : "暂无异动"}</span></div>{anomalies.length ? <div className="anomaly-list">{anomalies.map((anomaly) => <article className={`anomaly-card ${anomaly.severity}`} key={anomaly.id}><div className="anomaly-card-main"><strong>{anomaly.name}</strong><small>{anomaly.symbol} · {anomaly.market || "自选"}</small></div><div className="anomaly-card-metric"><b>{anomalyLabel(anomaly)}</b><small>{anomaly.type === "volume" ? `阈值 ${anomaly.threshold.toFixed(2)} 倍` : `阈值 ±${anomaly.threshold.toFixed(1)}%`}</small></div><div className="anomaly-card-meta"><span>{anomaly.severity === "critical" ? "高关注" : "需关注"}</span><small>{anomaly.source} · {formatQuoteFreshness(anomaly.asOf, Date.now(), anomaly.market)}</small></div>{realDataMode ? <AnomalyAttribution anomaly={anomaly} attribution={anomalyAttributions[anomaly.id]} loading={Boolean(anomalyAttributionLoading[anomaly.id])} error={anomalyAttributionError[anomaly.id]} onExplain={() => { void explainAnomaly(anomaly); }} /> : null}</article>)}</div> : <div className="anomaly-empty"><strong>当前没有符合条件的异动</strong><p>只使用已返回的涨跌幅和量比；字段缺失、行情过期或数据不足时保持空态。</p></div>}<p className="security-note">异动阈值：涨跌幅绝对值 ≥ 4%，量比 ≥ 2.5 倍。仅作信息提示，不构成投资建议。</p></section> : null}
    <section className="market-table"><div className="market-table-heading"><h2>我的自选</h2><small>{visibleColumns.length} 个数据列 · 点击标的可打开详情</small></div><div className="market-summary" role="region" aria-label="自选汇总统计"><div className="market-summary-heading"><div><h3>自选汇总</h3><p>仅统计当前真实、未过期的行情；每个字段独立计算，缺失字段不会被补值。</p></div><span>{summary.eligibleCount}/{watchlist.length} 个标的</span></div>{summary.eligibleCount > 0 && visibleColumns.some((column) => column.id !== "asOf" && summary.fields[column.id]?.count) ? <div className="market-summary-grid">{visibleColumns.filter((column) => column.id !== "asOf").map((column) => { const stats = summary.fields[column.id]; return <article className="market-summary-card" key={column.id}><div className="market-summary-card-heading"><strong>{column.label}</strong><small>{stats.count} 个有效值</small></div>{stats.count ? <div className="market-summary-values"><span><small>最小</small><b>{marketSummaryValue(column.id, stats.min)}</b></span><span><small>平均</small><b>{marketSummaryValue(column.id, stats.average)}</b></span><span><small>中位</small><b>{marketSummaryValue(column.id, stats.median)}</b></span><span><small>最大</small><b>{marketSummaryValue(column.id, stats.max)}</b></span></div> : <p>暂无真实数据</p>}</article>; })}</div> : <p className="market-summary-empty">获取至少一项真实行情后，这里会显示汇总统计。</p>}{summary.staleCount > 0 ? <p className="market-summary-note">另有 {summary.staleCount} 个标的行情已过期，不参与汇总；刷新后会自动恢复。</p> : null}</div><div className="table-head" style={{ "--market-table-columns": `minmax(250px, 1fr) repeat(${visibleColumns.length}, minmax(120px, 1fr)) 120px` }}><span>名称 / 代码</span>{visibleColumns.map((column) => <span key={column.id}>{column.label}</span>)}<span>市场</span></div>{watchlist.map((item) => { const quote = quoteForSymbol(liveQuotes, item.symbol); return <div className="table-row market-table-row" role="button" tabIndex="0" aria-label={`打开${item.name}详情`} onClick={(event) => openMarketSymbol(event, item.symbol)} onKeyDown={(event) => openMarketSymbol(event, item.symbol)} key={item.symbol} style={{ "--market-table-columns": `minmax(250px, 1fr) repeat(${visibleColumns.length}, minmax(120px, 1fr)) 120px` }}><span><strong title={item.name}>{item.name}</strong><small>{item.symbol}</small></span>{visibleColumns.map((column) => { const cell = marketColumnValue(item, quote, column.id); return <span className={cell.className || ""} key={`${item.symbol}-${column.id}`}>{cell.value}</span>; })}<span>{item.market}</span></div>; })}</section>
    <p className="security-note">仅显示已返回的真实数据{liveDataLastRefreshAt ? ` · ${new Date(liveDataLastRefreshAt).toLocaleTimeString("zh-CN")} 更新` : ""}；缺失值保持为空。</p>
  </div>;
}

export function ResearchView() {
  const watchlist = useLabStore((state) => state.watchlist);
  const liveQuotes = useLabStore((state) => state.liveQuotes);
  const integrationStatus = useLabStore((state) => state.integrationStatus);
  const refreshLiveData = useLabStore((state) => state.refreshLiveData);
  const cancelLiveDataRefresh = useLabStore((state) => state.cancelLiveDataRefresh);
  const liveDataLoading = useLabStore((state) => state.liveDataLoading);
  const liveDataError = useLabStore((state) => state.liveDataError);
  const liveDataLastRefreshAt = useLabStore((state) => state.liveDataLastRefreshAt);
  const setActiveView = useLabStore((state) => state.setActiveView);
  const selectSymbol = useLabStore((state) => state.selectSymbol);
  const [query, setQuery] = useState("");
  const [direction, setDirection] = useState("all");
  const [onlyPriced, setOnlyPriced] = useState(false);
  const [sortKey, setSortKey] = useState("default");
  const [sortDirection, setSortDirection] = useState("desc");
  const [filters, setFilters] = useState(() => normalizeResearchFilters(DEFAULT_RESEARCH_FILTERS));
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [researchScreens, setResearchScreens] = useState(loadResearchScreens);
  const [activeScreenId, setActiveScreenId] = useState("custom");
  const [screenName, setScreenName] = useState("");
  const [screenNotice, setScreenNotice] = useState("");
  const realDataMode = hasRealDataAccess(integrationStatus);
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  useEffect(() => {
    try { window.localStorage.setItem(RESEARCH_SCREENS_STORAGE_KEY, JSON.stringify(researchScreens)); } catch { /* Storage may be disabled. */ }
  }, [researchScreens]);
  const textFiltered = useMemo(() => watchlist.filter((item) => {
    const quote = quoteForSymbol(liveQuotes, item.symbol);
    const change = Number(quote?.change);
    const matchesQuery = !normalizedQuery || `${item.name} ${item.symbol} ${item.market} ${item.category}`.toLocaleLowerCase("zh-CN").includes(normalizedQuery);
    const matchesDirection = direction === "all" || (direction === "up" && Number.isFinite(change) && change > 0) || (direction === "down" && Number.isFinite(change) && change < 0);
    return matchesQuery && matchesDirection && (!onlyPriced || isValidQuotePrice(quote?.price));
  }), [watchlist, liveQuotes, normalizedQuery, direction, onlyPriced]);
  const filtered = useMemo(() => filterResearchItems(textFiltered, liveQuotes, filters), [textFiltered, liveQuotes, filters]);
  const sorted = useMemo(() => sortResearchItems(filtered, liveQuotes, sortKey, sortDirection), [filtered, liveQuotes, sortKey, sortDirection]);
  const activeFilterCount = activeResearchFilterCount(filters);
  const returnedCount = watchlist.filter((item) => isValidQuotePrice(quoteForSymbol(liveQuotes, item.symbol)?.price)).length;
  const dataState = resolveLiveDataState({ configured: realDataMode, loading: liveDataLoading, error: liveDataError, receivedCount: returnedCount, totalCount: watchlist.length });
  const retry = () => { void refreshLiveData(); };
  const openSettings = () => setActiveView("settings");
  const openResearchSymbol = (event, symbol) => {
    if (event.type === "keydown" && event.key !== "Enter" && event.key !== " ") return;
    if (event.type === "keydown") event.preventDefault();
    selectSymbol(symbol);
  };
  const updateResearchFilter = (id, value) => {
    setFilters((current) => normalizeResearchFilters({ ...current, [id]: value }));
    setActiveScreenId("custom");
    setScreenNotice("");
  };
  const clearResearchFilters = () => {
    setFilters(normalizeResearchFilters(DEFAULT_RESEARCH_FILTERS));
    setActiveScreenId("custom");
    setScreenNotice("已清除数值条件");
  };
  const selectResearchScreen = (id) => {
    const selected = researchScreens.find((screen) => screen.id === id);
    if (!selected) { setActiveScreenId("custom"); return; }
    setFilters(normalizeResearchFilters(selected.filters));
    setActiveScreenId(selected.id);
    setScreenNotice(`已载入“${selected.name}”筛选`);
  };
  const saveResearchScreen = (event) => {
    event.preventDefault();
    const name = screenName.trim().slice(0, 32);
    if (!name) { setScreenNotice("请输入筛选名称"); return; }
    const existing = researchScreens.find((screen) => screen.name === name);
    if (!existing && researchScreens.length >= 10) { setScreenNotice("最多保存 10 个筛选，请删除不用的筛选后再试"); return; }
    const id = existing?.id || createResearchScreenId();
    const next = { id, name, filters: normalizeResearchFilters(filters) };
    setResearchScreens((current) => existing ? current.map((screen) => screen.id === id ? next : screen) : [...current, next]);
    setActiveScreenId(id);
    setScreenName("");
    setScreenNotice(`已保存“${name}”筛选`);
  };
  const deleteResearchScreen = () => {
    const selected = researchScreens.find((screen) => screen.id === activeScreenId);
    if (!selected) return;
    setResearchScreens((current) => current.filter((screen) => screen.id !== selected.id));
    setActiveScreenId("custom");
    setScreenNotice(`已删除“${selected.name}”筛选`);
  };
  return <div className="secondary-page research-page"><header><div><h1>研究筛选</h1><p>在我的自选中按真实行情筛选标的，不用示例数据填充。</p></div><button className="secondary-button" onClick={realDataMode ? liveDataLoading ? cancelLiveDataRefresh : retry : openSettings}><ArrowsClockwise size={16} />{realDataMode ? liveDataLoading ? "停止更新" : "刷新真实数据" : "配置数据"}</button></header>
    <div className="research-toolbar"><label className="search-box"><MagnifyingGlass size={18} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称、代码或市场…" aria-label="搜索标的" /></label><div className="filter-group" aria-label="涨跌方向"><button className={direction === "all" ? "active" : ""} onClick={() => setDirection("all")}>全部</button><button className={direction === "up" ? "active" : ""} onClick={() => setDirection("up")}>上涨</button><button className={direction === "down" ? "active" : ""} onClick={() => setDirection("down")}>下跌</button></div><button className={`filter-toggle${onlyPriced ? " active" : ""}`} aria-pressed={onlyPriced} onClick={() => setOnlyPriced((value) => !value)}><Funnel size={15} />仅显示有行情</button><button type="button" className={`filter-toggle${filtersOpen || activeFilterCount ? " active" : ""}`} aria-expanded={filtersOpen} onClick={() => setFiltersOpen((value) => !value)}><Funnel size={15} />数值条件{activeFilterCount ? `（${activeFilterCount}）` : ""}</button><label className="research-sort-control"><span>排序</span><select aria-label="研究排序" value={sortKey} onChange={(event) => setSortKey(event.target.value)}>{RESEARCH_SORT_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label><button className="research-sort-direction" type="button" disabled={sortKey === "default"} aria-label={sortDirection === "asc" ? "切换为降序" : "切换为升序"} onClick={() => setSortDirection((value) => value === "asc" ? "desc" : "asc")}>{sortDirection === "asc" ? "升序 ↑" : "降序 ↓"}</button></div>
    {filtersOpen && <section className="research-filter-panel" aria-label="研究数值条件"><div className="research-filter-heading"><div><strong>真实行情条件</strong><small>只对已返回的真实字段生效；缺失字段不会被猜测。</small></div><button type="button" className="notification-link" onClick={clearResearchFilters} disabled={!activeFilterCount}>清除条件</button></div><div className="research-filter-grid">{RESEARCH_FILTER_FIELDS.map((field) => <label key={field.id} title={field.description}><span>{field.label}{field.suffix ? `（${field.suffix}）` : ""}</span><input type="number" step="any" inputMode="decimal" aria-label={field.label} value={filters[field.id]} onChange={(event) => updateResearchFilter(field.id, event.target.value)} placeholder="不限" /></label>)}</div></section>}
    <div className="research-screen-bar"><label><span>已保存筛选</span><select aria-label="已保存研究筛选" value={activeScreenId} onChange={(event) => selectResearchScreen(event.target.value)}><option value="custom">临时条件</option>{researchScreens.map((screen) => <option value={screen.id} key={screen.id}>{screen.name}</option>)}</select></label><form onSubmit={saveResearchScreen}><input aria-label="筛选名称" maxLength={32} value={screenName} onChange={(event) => { setScreenName(event.target.value); setScreenNotice(""); }} placeholder="保存当前条件…" /><button type="submit" className="secondary-button">保存筛选</button></form>{activeScreenId !== "custom" && <button type="button" className="icon-button" aria-label="删除当前研究筛选" onClick={deleteResearchScreen}>删除</button>}{screenNotice && <span role="status">{screenNotice}</span>}</div>
    {returnedCount > 0 && dataState !== DATA_STATES.SUCCESS ? <LiveDataState compact state={dataState} receivedCount={returnedCount} totalCount={watchlist.length} onRetry={retry} onCancel={cancelLiveDataRefresh} onSettings={openSettings} /> : null}
    {returnedCount === 0 ? <LiveDataState state={dataState} receivedCount={0} totalCount={watchlist.length} onRetry={retry} onCancel={cancelLiveDataRefresh} onSettings={openSettings} /> : sorted.length === 0 ? <DataState state="empty" title="没有符合条件的标的" description="调整搜索词或筛选条件后再试；已有真实行情不会被修改。" /> : <section className="research-table" aria-label="真实行情筛选结果"><div className="research-table-head"><span>标的</span><span>最新价</span><span>涨跌幅</span><span>市盈率</span><span>市净率</span><span>数据时间</span></div>{sorted.map((item) => { const quote = quoteForSymbol(liveQuotes, item.symbol); const hasQuote = isValidQuotePrice(quote?.price); const freshness = quoteFreshness(quote?.asOf); return <div className="research-row" role="button" tabIndex="0" aria-label={`打开${item.name}详情`} onClick={(event) => openResearchSymbol(event, item.symbol)} onKeyDown={(event) => openResearchSymbol(event, item.symbol)} key={item.symbol}><span><strong title={item.name}>{item.name}</strong><small>{item.symbol} · {item.market || item.category}</small></span><span>{hasQuote ? formatPrice(quote.price) : "—"}</span><span className={changeToneClass(quote?.change)}>{formatPercent(quote?.change)}</span><span>{quote?.pe == null ? "—" : String(quote.pe)}</span><span>{quote?.pb == null ? "—" : String(quote.pb)}</span><span className={`quote-source quote-source-${freshness.state}`}>{hasQuote ? formatQuoteFreshness(quote.asOf, Date.now(), item.market) : "—"}</span></div>; })}</section>}
    <p className="security-note">范围：我的自选 · 当前显示 {sorted.length}/{watchlist.length} 个标的 · {returnedCount} 个已返回行情{activeFilterCount ? ` · ${activeFilterCount} 个数值条件` : ""}{liveDataLastRefreshAt ? ` · 最近更新 ${new Date(liveDataLastRefreshAt).toLocaleTimeString("zh-CN")}` : ""}。估值字段缺失时保持空值。</p>
  </div>;
}

function ConditionEditor({ condition, index, onChange, onRemove, canRemove }) {
  const type = conditionTypeFor(condition.type);
  const updateType = (event) => {
    const next = defaultConditionFor(event.target.value);
    onChange({ ...next, id: condition.id });
  };
  return <div className="condition-row">
    <select aria-label={`条件${index + 1}类型`} value={type.id} onChange={updateType}>{CONDITION_TYPES.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select>
    <select aria-label={`条件${index + 1}关系`} value={condition.operator} onChange={(event) => onChange({ ...condition, operator: event.target.value })}>{conditionOperatorsFor(type.id).map((operator) => <option key={operator.id} value={operator.id}>{operator.label}</option>)}</select>
    {type.valueType === "select" ? <select aria-label={`条件${index + 1}取值`} value={condition.value} onChange={(event) => onChange({ ...condition, value: event.target.value })}>{type.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select> : <label className="condition-value"><input aria-label={`条件${index + 1}数值`} type="number" step={type.id === "capital_flow" ? "1000000" : "0.1"} value={condition.value} onChange={(event) => onChange({ ...condition, value: event.target.value })} /><span>{type.unit}</span></label>}
    <button className="icon-button" type="button" aria-label={`删除条件${index + 1}`} disabled={!canRemove} onClick={onRemove}><Trash size={15} /></button>
  </div>;
}

function ConditionBuilder({ conditions, logic, onLogicChange, onConditionChange, onConditionRemove, onAddCondition, onApplyTemplate }) {
  return <div className="condition-builder">
    <div className="condition-builder-heading"><div><strong>触发条件</strong><small>缺失字段不会被当作触发；数据不足时自动保留待核实状态。</small></div><label>组合<select aria-label="条件组合逻辑" value={logic} onChange={(event) => onLogicChange(event.target.value)}><option value="AND">全部满足（AND）</option><option value="OR">任一满足（OR）</option></select></label></div>
    <div className="condition-list">{conditions.map((condition, index) => <ConditionEditor key={condition.id} condition={condition} index={index} onChange={(next) => onConditionChange(index, next)} onRemove={() => onConditionRemove(index)} canRemove={conditions.length > 1} />)}</div>
    <div className="condition-builder-actions"><button className="secondary-button" type="button" disabled={conditions.length >= 6} onClick={onAddCondition}><Plus size={15} />添加条件</button><span>{conditions.length}/6</span></div>
    <div className="condition-templates"><small>快速模板</small>{monitorTemplates.map((template) => <button key={template.id} type="button" onClick={() => onApplyTemplate(template)} title={template.description}>{template.name}</button>)}</div>
  </div>;
}

export function MonitorView() {
  const rules = useLabStore((state) => state.rules);
  const monitorHistory = useLabStore((state) => state.monitorHistory);
  const watchlist = useLabStore((state) => state.watchlist);
  const toggleRule = useLabStore((state) => state.toggleRule);
  const addRule = useLabStore((state) => state.addRule);
  const updateRule = useLabStore((state) => state.updateRule);
  const deleteRule = useLabStore((state) => state.deleteRule);
  const runMonitorCheck = useLabStore((state) => state.runMonitorCheck);
  const monitorBusy = useLabStore((state) => state.monitorBusy);
  const setActiveView = useLabStore((state) => state.setActiveView);
  const integrationStatus = useLabStore((state) => state.integrationStatus);
  const realDataMode = hasRealDataAccess(integrationStatus);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingRule, setEditingRule] = useState(null);
  const [actionError, setActionError] = useState("");
  const [ruleQuery, setRuleQuery] = useState("");
  const [ruleFilter, setRuleFilter] = useState("all");
  const [ruleSort, setRuleSort] = useState("recent");
  const [form, setForm] = useState(() => ({ scope: "symbol", symbol: watchlist[0]?.symbol || "600519", conditions: [defaultConditionFor("price_change")], logic: "AND", intervalSeconds: 300, triggerMode: "edge", expiresAt: "" }));
  useEffect(() => { if (form.scope === "symbol" && !watchlist.some((item) => item.symbol === form.symbol) && watchlist[0]) setForm((value) => ({ ...value, symbol: watchlist[0].symbol })); }, [watchlist, form.scope, form.symbol]);
  const selectedStrategy = strategyFor(conditionTypeFor(form.conditions[0]?.type).strategyId);
  const openCreate = () => {
    setEditingRule(null);
    setForm({ scope: "symbol", symbol: watchlist[0]?.symbol || "600519", conditions: [defaultConditionFor("price_change")], logic: "AND", intervalSeconds: 300, triggerMode: "edge", expiresAt: "" });
    setActionError("");
    setDialogOpen(true);
  };
  const openEdit = (rule) => {
    setEditingRule(rule);
    setForm({ scope: rule.scope === "watchlist" ? "watchlist" : "symbol", symbol: rule.symbol === "*" ? watchlist[0]?.symbol || "600519" : rule.symbol, conditions: conditionsForRule(rule), logic: rule.logic === "OR" ? "OR" : "AND", intervalSeconds: rule.intervalSeconds || 300, triggerMode: rule.triggerMode || "edge", expiresAt: monitorDateInputValue(rule.expiresAt) });
    setActionError("");
    setDialogOpen(true);
  };
  const saveRule = async (event) => {
    event.preventDefault();
    setActionError("");
    const payload = { scope: form.scope, symbol: form.scope === "watchlist" ? "*" : form.symbol, strategyId: selectedStrategy.id, conditions: normalizeConditions(form.conditions, selectedStrategy.id), logic: form.logic, threshold: Number(form.conditions[0]?.value) || selectedStrategy.defaultThreshold, intervalSeconds: Number(form.intervalSeconds), triggerMode: form.triggerMode, expiresAt: form.expiresAt };
    try {
      if (editingRule) await updateRule(editingRule.id, payload);
      else await addRule(payload);
      setDialogOpen(false);
      setEditingRule(null);
    } catch (cause) { setActionError(errorMessage(cause)); }
  };
  const removeRule = (id) => { setActionError(""); void deleteRule(id).catch((cause) => setActionError(errorMessage(cause))); };
  const updateCondition = (index, next) => setForm((value) => ({ ...value, conditions: value.conditions.map((condition, position) => position === index ? next : condition) }));
  const removeCondition = (index) => setForm((value) => ({ ...value, conditions: value.conditions.filter((_, position) => position !== index) }));
  const addCondition = () => setForm((value) => ({ ...value, conditions: [...value.conditions, defaultConditionFor("price_change")] }));
  const applyTemplate = (template) => setForm((value) => ({ ...value, conditions: normalizeConditions(template.conditions), logic: template.logic, intervalSeconds: template.intervalSeconds }));
  const normalizedRuleQuery = ruleQuery.trim().toLocaleLowerCase("zh-CN");
  const visibleRules = useMemo(() => {
    const filtered = rules.filter((rule) => {
      const statusMatch = ruleFilter === "all" || (ruleFilter === "enabled" ? rule.enabled : !rule.enabled);
      if (!statusMatch) return false;
      if (!normalizedRuleQuery) return true;
      const strategy = strategyFor(rule.strategyId);
      const haystack = `${ruleConditionSummary(rule)} ${rule.symbol === "*" ? "整个自选" : rule.symbol} ${strategy.name}`.toLocaleLowerCase("zh-CN");
      return haystack.includes(normalizedRuleQuery);
    });
    return [...filtered].sort((left, right) => {
      if (ruleSort === "name") return ruleConditionSummary(left).localeCompare(ruleConditionSummary(right), "zh-CN");
      if (ruleSort === "status") return Number(right.enabled) - Number(left.enabled) || ruleConditionSummary(left).localeCompare(ruleConditionSummary(right), "zh-CN");
      const leftTime = Date.parse(left.lastTriggeredAt || left.lastCheckedAt || "") || 0;
      const rightTime = Date.parse(right.lastTriggeredAt || right.lastCheckedAt || "") || 0;
      return rightTime - leftTime;
    });
  }, [normalizedRuleQuery, ruleFilter, ruleSort, rules]);
  return <div className="secondary-page monitor-page">
    <header><div><h1>个股盯盘</h1><p>用条件组合监控真实市场数据，并在触发边沿提醒</p></div><button className="primary-action" onClick={openCreate}><Plus size={17} />新建盯盘</button></header>
    {!realDataMode ? <LiveDataState compact state={DATA_STATES.NO_CREDENTIAL} totalCount={watchlist.length} onSettings={() => setActiveView("settings")} /> : null}
    <section className="strategy-strip"><strong>条件类型</strong>{CONDITION_TYPES.map((type) => <span key={type.id} title={type.description}>{type.name}</span>)}</section>
    <section className="rule-list">
      <div className="rule-list-heading"><div><h2>盯盘规则</h2><small>显示 {visibleRules.length}/{rules.length} 条 · 每条规则独立检查，重复触发自动去重</small></div><div className="rule-list-controls"><label className="search-box"><MagnifyingGlass size={16} /><input value={ruleQuery} onChange={(event) => setRuleQuery(event.target.value)} placeholder="搜索规则、标的或条件…" aria-label="搜索盯盘规则" /></label><label><span>状态</span><select aria-label="盯盘规则状态" value={ruleFilter} onChange={(event) => setRuleFilter(event.target.value)}><option value="all">全部</option><option value="enabled">运行中</option><option value="disabled">已停用</option></select></label><label><span>排序</span><select aria-label="盯盘规则排序" value={ruleSort} onChange={(event) => setRuleSort(event.target.value)}><option value="recent">最近活动</option><option value="name">条件名称</option><option value="status">运行状态</option></select></label></div></div>
      {rules.length === 0 ? <p className="rule-empty">还没有规则；创建第一条条件后，运行状态和触发记录会显示在这里。</p> : visibleRules.length === 0 ? <p className="rule-empty" role="status">没有匹配的盯盘规则，请调整搜索或筛选条件。</p> : visibleRules.map((rule) => {
        const strategy = strategyFor(rule.strategyId);
        const history = monitorHistory.filter((entry) => entry.ruleId === rule.id).slice(0, 8);
        const expired = isMonitorRuleExpired(rule);
        return <article key={rule.id}><Bell size={20} /><div><strong>{ruleConditionSummary(rule)}</strong><small>{rule.scope === "watchlist" ? "整个自选（动态）" : rule.symbol} · {rule.logic === "OR" ? "任一条件" : "全部条件"} · 每 {rule.intervalSeconds >= 60 ? `${Math.round(rule.intervalSeconds / 60)} 分钟` : `${rule.intervalSeconds} 秒`} 检查 · {monitorLifecycleLabel(rule)}{rule.expiresAt ? `（${expired ? "已到期" : `至 ${monitorDateInputValue(rule.expiresAt)}`}）` : ""}</small><small>{rule.lastTriggeredAt ? `最近触发 ${new Date(rule.lastTriggeredAt).toLocaleString("zh-CN")}` : rule.lastCheckedAt ? `最近检查 ${new Date(rule.lastCheckedAt).toLocaleString("zh-CN")}` : "尚未检查"} · {strategy.name}{rule.scope === "watchlist" && rule.lastSignalBySymbol ? ` · 已跟踪 ${Object.keys(rule.lastSignalBySymbol).length} 个标的` : ""}</small>{history.length > 0 ? <details className="monitor-history"><summary>查看最近 {history.length} 次检查</summary><div className="monitor-history-list">{history.map((entry) => <div className="monitor-history-entry" key={entry.id}><span className={`monitor-outcome ${entry.outcome}`} aria-label={entry.outcome === "triggered" ? "已触发" : entry.outcome === "not_triggered" ? "未触发" : entry.outcome === "error" ? "检查失败" : "待核实"}>{entry.outcome === "triggered" ? "触发" : entry.outcome === "not_triggered" ? "未触发" : entry.outcome === "error" ? "失败" : "待核实"}</span><div><strong>{entry.symbol ? `${entry.symbol} · ` : ""}{new Date(entry.checkedAt).toLocaleString("zh-CN")}</strong><small>{entry.summary}</small><small>{entry.asOf ? `数据截至 ${entry.asOf}` : "数据截至时间未返回"} · {entry.source === "data-service" ? "真实数据服务" : "浏览器预览"}{entry.audits?.length ? ` · ${entry.audits.length} 条审计` : ""}</small></div></div>)}</div></details> : <small className="monitor-history-empty">暂无检查记录；运行一次后会保留结果与数据来源。</small>}</div><button className="rule-run" disabled={!realDataMode || monitorBusy || !rule.enabled || expired} onClick={() => { void runMonitorCheck(rule.id).catch((cause) => setActionError(errorMessage(cause))); }} aria-label={`立即检查${rule.scope === "watchlist" ? "整个自选" : rule.symbol}`}>{expired ? "已过期" : <Play size={14} weight="fill" />}</button><button className={rule.enabled ? "toggle on" : "toggle"} onClick={() => { setActionError(""); void toggleRule(rule.id).catch((cause) => setActionError(errorMessage(cause, "盯盘规则状态暂时无法保存，请稍后重试"))); }} aria-label={`${rule.enabled ? "停用" : "启用"}${strategy.name}`} aria-pressed={rule.enabled}><span /></button><button className="icon-button rule-edit" onClick={() => openEdit(rule)} aria-label={`编辑${ruleConditionSummary(rule)}`}>编辑</button><button className="icon-button" aria-label={`删除${strategy.name}`} onClick={() => removeRule(rule.id)}><Trash size={15} /></button></article>;
      })}
    </section>
    {realDataMode ? <p className="security-note">检查结果会保留在本地审计时间线；缺失字段显示为“待核实”，不会当作未触发。历史记录最多保留 500 条。</p> : null}
    {actionError ? <p className="form-error" role="alert">{actionError}</p> : null}
    {dialogOpen && <div className="modal-backdrop" role="presentation"><form className="modal-card condition-modal" onSubmit={saveRule}><div className="modal-heading"><h2>{editingRule ? "编辑盯盘条件" : "新建盯盘条件"}</h2><button type="button" className="icon-button" aria-label="关闭" onClick={() => { setDialogOpen(false); setEditingRule(null); }}><X size={18} /></button></div><p className="modal-help">{editingRule ? "修改后会保留历史检查记录，但清除旧触发边沿；下一次真实数据检查完成后才会重新判断。" : "规则创建分三步：选择范围、组合真实数据条件、设定检查频率。自选组规则会跟随当前自选动态增删标的，并按标的独立去重。"}</p><label>监控范围<select aria-label="监控范围" value={form.scope} onChange={(event) => setForm((value) => ({ ...value, scope: event.target.value }))}><option value="symbol">单个标的</option><option value="watchlist">整个自选</option></select></label>{form.scope === "symbol" ? <label>标的<select aria-label="监控标的" value={form.symbol} onChange={(event) => setForm((value) => ({ ...value, symbol: event.target.value }))}>{watchlist.map((item) => <option key={item.symbol} value={item.symbol}>{item.name}（{item.symbol}）</option>)}</select></label> : <p className="monitor-scope-note">将检查当前自选中的 {watchlist.length} 个标的；以后新增或删除自选会自动跟随。</p>}<ConditionBuilder conditions={form.conditions} logic={form.logic} onLogicChange={(logic) => setForm((value) => ({ ...value, logic }))} onConditionChange={updateCondition} onConditionRemove={removeCondition} onAddCondition={addCondition} onApplyTemplate={applyTemplate} /><label>检查间隔<select value={form.intervalSeconds} onChange={(event) => setForm((value) => ({ ...value, intervalSeconds: event.target.value }))}><option value="60">每 60 秒</option><option value="300">每 5 分钟</option><option value="600">每 10 分钟</option><option value="1800">每 30 分钟</option></select></label><label>触发方式<select aria-label="触发方式" value={form.triggerMode} onChange={(event) => setForm((value) => ({ ...value, triggerMode: event.target.value }))}>{MONITOR_TRIGGER_MODES.map((mode) => <option key={mode.id} value={mode.id}>{mode.label}</option>)}</select><small className="field-help">{MONITOR_TRIGGER_MODES.find((mode) => mode.id === form.triggerMode)?.description}</small></label><label>有效期（可选）<input aria-label="盯盘有效期" type="date" min={new Date().toISOString().slice(0, 10)} value={form.expiresAt} onChange={(event) => setForm((value) => ({ ...value, expiresAt: event.target.value }))} /><small className="field-help">到期后规则自动停用，不再发起数据请求；留空表示长期有效。</small></label><button className="primary-action" type="submit">{editingRule ? "保存修改" : "保存并启用"}</button></form></div>}
  </div>;
}

function eventDateLabel(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value || "日期待定") : new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function eventDateValue(value) {
  const time = Date.parse(String(value || ""));
  return Number.isFinite(time) ? time : null;
}

function eventSymbolKey(value) {
  return quoteSymbolKey(value);
}

export function EventsView() {
  const watchlist = useLabStore((state) => state.watchlist);
  const portfolioPositions = useLabStore((state) => state.portfolioPositions);
  const portfolioReviews = useLabStore((state) => state.portfolioReviews);
  const briefingSchedule = useLabStore((state) => state.briefingSchedule);
  const events = useLabStore((state) => state.events);
  const integrationStatus = useLabStore((state) => state.integrationStatus);
  const eventDataLoading = useLabStore((state) => state.eventDataLoading);
  const eventDataError = useLabStore((state) => state.eventDataError);
  const eventDataLoaded = useLabStore((state) => state.eventDataLoaded);
  const eventDataLastRefreshAt = useLabStore((state) => state.eventDataLastRefreshAt);
  const eventDataReceivedCount = useLabStore((state) => state.eventDataReceivedCount);
  const eventDataTotalCount = useLabStore((state) => state.eventDataTotalCount);
  const liveDataLoading = useLabStore((state) => state.liveDataLoading);
  const refreshEvents = useLabStore((state) => state.refreshEvents);
  const cancelEventsRefresh = useLabStore((state) => state.cancelEventsRefresh);
  const retryEvents = useLabStore((state) => state.retryEvents);
  const setActiveView = useLabStore((state) => state.setActiveView);
  const selectSymbol = useLabStore((state) => state.selectSymbol);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("upcoming");
  const [relationScope, setRelationScope] = useState("watchlist");
  const [industryScope, setIndustryScope] = useState("");
  const [viewMode, setViewMode] = useState("list");
  const [monthCursor, setMonthCursor] = useState(() => monthCursorFromKey(monthKey()));
  const [selectedDate, setSelectedDate] = useState(() => eventDateKey(new Date().toISOString()));
  const realDataMode = hasRealDataAccess(integrationStatus);
  useEffect(() => {
    if (!eventDataLoaded && !eventDataLoading && !liveDataLoading) void refreshEvents();
  }, [eventDataLoaded, eventDataLoading, liveDataLoading, refreshEvents]);
  const dataState = resolveLiveDataState({ configured: realDataMode, loading: eventDataLoading, error: eventDataError, receivedCount: eventDataReceivedCount, totalCount: eventDataTotalCount || watchlist.length });
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const holdingSymbols = new Set(portfolioPositions.map((position) => eventSymbolKey(position.symbol)));
  const watchlistBySymbol = new Map(watchlist.map((item) => [eventSymbolKey(item.symbol), item]));
  const industryOptions = [...new Set(watchlist.map((item) => String(item.category || "").trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right, "zh-CN"));
  const portfolioScopeEmpty = relationScope === "portfolio" && portfolioPositions.length === 0;
  const now = Date.now();
  const filtered = events.filter((event) => {
    const eventTime = eventDateValue(event.date);
    const matchesScope = scope === "all" || (scope === "upcoming" && (eventTime == null || eventTime >= now - 86_400_000)) || (scope === "past" && eventTime != null && eventTime < now - 86_400_000);
    const eventSymbol = eventSymbolKey(event.symbol);
    const matchesRelation = relationScope !== "portfolio" || holdingSymbols.has(eventSymbol);
    const matchesIndustry = !industryScope || String(event.category || watchlistBySymbol.get(eventSymbol)?.category || "").trim() === industryScope;
    const haystack = `${event.name} ${event.symbol} ${event.type} ${event.title} ${event.detail}`.toLocaleLowerCase("zh-CN");
    return matchesScope && matchesRelation && matchesIndustry && (!normalizedQuery || haystack.includes(normalizedQuery));
  });
  const groupedEvents = eventsByDate(filtered);
  const monthDays = buildMonthGrid(monthCursor);
  const selectedEvents = groupedEvents.get(selectedDate) || [];
  const moveMonth = (offset) => {
    const next = shiftMonth(monthCursor, offset);
    setMonthCursor(next);
    const firstEvent = buildMonthGrid(next).find((cell) => cell.inMonth && groupedEvents.has(cell.key));
    setSelectedDate(firstEvent?.key || eventDateKey(`${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-01`));
  };
  const goToday = () => {
    const today = new Date();
    setMonthCursor(new Date(today.getFullYear(), today.getMonth(), 1));
    setSelectedDate(eventDateKey(today.toISOString()));
  };
  const retry = () => { void retryEvents(); };
  const openSettings = () => setActiveView("settings");
  const openEventSymbol = (event) => {
    const symbol = String(event?.symbol || "").trim();
    if (symbol) selectSymbol(symbol);
  };
  const switchToMonth = () => {
    const firstEvent = monthDays.find((cell) => cell.inMonth && groupedEvents.has(cell.key));
    if (firstEvent) {
      setSelectedDate(firstEvent.key);
      setViewMode("month");
      return;
    }
    const firstDated = filtered.map((event) => eventDateKey(event.date)).filter(Boolean).sort()[0];
    if (firstDated) {
      setMonthCursor(monthCursorFromKey(firstDated.slice(0, 7)));
      setSelectedDate(firstDated);
    }
    setViewMode("month");
  };
  const renderEventCard = (event) => { const sourceUrl = safeExternalUrl(event.url); return <article className="event-calendar-card" key={event.id}><div className="event-calendar-date"><strong>{eventDateLabel(event.date)}</strong><small>{event.symbol}</small></div><div className="event-calendar-dot" aria-hidden="true" /><div className="event-calendar-copy"><div className="event-calendar-heading"><span>{event.type || "公司事件"}</span><strong>{event.name}</strong></div><h2>{event.title || "未命名事件"}</h2>{event.detail && event.detail !== event.title ? <p>{event.detail}</p> : null}<div className="event-calendar-footer"><small className="event-calendar-meta">{event.source || "数据服务"}{sourceUrl ? <> · <a href={sourceUrl} target="_blank" rel="noreferrer">查看来源</a></> : null} · 能力 EVENT.CALENDAR.CORP</small>{event.symbol ? <button type="button" className="notification-link" onClick={() => openEventSymbol(event)} aria-label={`查看${event.name || event.symbol}详情`}>查看标的</button> : null}</div></div></article>; };
  return <div className="secondary-page events-page"><header><div><h1>事件日历</h1><p>只展示自选标的已返回的真实公司事件，不用样例填充。</p></div><button className="secondary-button" onClick={realDataMode ? eventDataLoading ? cancelEventsRefresh : () => { void refreshEvents(); } : openSettings}><ArrowsClockwise size={16} />{realDataMode ? eventDataLoading ? "停止更新" : "刷新真实事件" : "配置数据"}</button></header>
    {dataState === DATA_STATES.NO_CREDENTIAL || dataState === DATA_STATES.LOADING || dataState === DATA_STATES.ERROR ? <LiveDataState state={dataState} receivedCount={eventDataReceivedCount} totalCount={eventDataTotalCount || watchlist.length} onRetry={retry} onCancel={cancelEventsRefresh} onSettings={openSettings} /> : null}
    {dataState === DATA_STATES.PARTIAL ? <LiveDataState compact state={dataState} receivedCount={eventDataReceivedCount} totalCount={eventDataTotalCount || watchlist.length} onRetry={retry} onCancel={cancelEventsRefresh} onSettings={openSettings} /> : null}
    <div className="events-toolbar"><label className="search-box"><MagnifyingGlass size={18} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标的、事件类型或关键词…" aria-label="搜索事件" /></label><div className="filter-group" aria-label="事件范围"><button className={scope === "upcoming" ? "active" : ""} onClick={() => setScope("upcoming")}>未来事件</button><button className={scope === "all" ? "active" : ""} onClick={() => setScope("all")}>全部</button><button className={scope === "past" ? "active" : ""} onClick={() => setScope("past")}>已发生</button></div><div className="filter-group" aria-label="事件关联范围"><button className={relationScope === "watchlist" ? "active" : ""} onClick={() => setRelationScope("watchlist")}>全部自选</button><button className={relationScope === "portfolio" ? "active" : ""} onClick={() => setRelationScope("portfolio")}>只看持仓</button></div><label className="event-industry-filter">行业<select aria-label="事件行业" value={industryScope} onChange={(event) => setIndustryScope(event.target.value)}><option value="">全部行业</option>{industryOptions.map((industry) => <option value={industry} key={industry}>{industry}</option>)}</select></label><div className="filter-group event-view-switch" aria-label="日历视图"><button className={viewMode === "list" ? "active" : ""} onClick={() => setViewMode("list")}><List size={15} />列表</button><button className={viewMode === "month" ? "active" : ""} onClick={switchToMonth}><CalendarDots size={15} />月视图</button></div></div>
    {portfolioScopeEmpty && dataState !== DATA_STATES.NO_CREDENTIAL && dataState !== DATA_STATES.LOADING && dataState !== DATA_STATES.ERROR ? <DataState state="empty" title="还没有持仓标的" description="添加持仓后，可以只查看与持仓相关的真实公司事件。" actionLabel="去组合" onAction={() => setActiveView("portfolio")} /> : null}
    {!portfolioScopeEmpty && dataState !== DATA_STATES.NO_CREDENTIAL && dataState !== DATA_STATES.LOADING && dataState !== DATA_STATES.ERROR && eventDataLoaded && events.length === 0 ? <DataState state="empty" title="未来 90 天暂无已排期事件" description="当前数据渠道没有返回自选标的的公司事件；有新数据时可再次刷新。" actionLabel="立即重试" onAction={retry} /> : null}
    {!portfolioScopeEmpty && dataState !== DATA_STATES.NO_CREDENTIAL && dataState !== DATA_STATES.LOADING && dataState !== DATA_STATES.ERROR && eventDataLoaded && events.length > 0 && filtered.length === 0 ? <DataState state="empty" title="没有符合筛选条件的事件" description="调整范围、关联范围或搜索关键词；原始真实事件不会被修改。" /> : null}
    {filtered.length > 0 && viewMode === "list" ? <section className="event-calendar-list" aria-label="真实公司事件列表">{filtered.map(renderEventCard)}</section> : null}
    {filtered.length > 0 && viewMode === "month" ? <section className="event-month-view" aria-label="真实公司事件月视图">
      <div className="event-month-heading"><div><strong>{monthLabel(monthCursor)}</strong><small>{filtered.length} 个符合当前筛选的真实事件</small></div><div className="event-month-actions"><button type="button" className="icon-button" onClick={() => moveMonth(-1)} aria-label="上一个月"><CaretLeft size={16} /></button><button type="button" className="secondary-button" onClick={goToday}>今天</button><button type="button" className="icon-button" onClick={() => moveMonth(1)} aria-label="下一个月"><CaretRight size={16} /></button></div></div>
      <div className="event-month-weekdays" aria-hidden="true">{["一", "二", "三", "四", "五", "六", "日"].map((day) => <span key={day}>周{day}</span>)}</div>
      <div className="event-month-grid">{monthDays.map((cell) => { const dayEvents = groupedEvents.get(cell.key) || []; return <button type="button" key={cell.key} className={`event-calendar-day${cell.inMonth ? "" : " outside"}${cell.isToday ? " today" : ""}${selectedDate === cell.key ? " selected" : ""}`} onClick={() => setSelectedDate(cell.key)} aria-label={`${cell.key}${dayEvents.length ? `，${dayEvents.length} 个事件` : ""}`} aria-current={cell.isToday ? "date" : undefined}><span>{cell.date.getDate()}</span>{dayEvents.length > 0 ? <div className="event-day-markers" aria-hidden="true">{dayEvents.slice(0, 3).map((event) => <i key={event.id} title={event.type || "公司事件"} />)}{dayEvents.length > 3 ? <em>+{dayEvents.length - 3}</em> : null}</div> : null}</button>; })}</div>
      <div className="event-month-detail"><div className="event-month-detail-heading"><strong>{selectedDate ? eventDateLabel(selectedDate) : "所选日期"}</strong><small>{selectedEvents.length ? `${selectedEvents.length} 个事件` : "当天没有符合筛选的事件"}</small></div>{selectedEvents.length ? <div className="event-calendar-list">{selectedEvents.map(renderEventCard)}</div> : <p>选择带标记的日期查看事件详情；没有事件的日期保持空状态。</p>}</div>
    </section> : null}
    <p className="security-note">数据范围：自选标的 · 公司事件 CAP · {eventDataLastRefreshAt ? `最近刷新 ${new Date(eventDataLastRefreshAt).toLocaleTimeString("zh-CN")}` : "尚未刷新"}；没有事件时保持空状态。</p>
  </div>;
}

export function NotificationsView() {
  const notifications = useLabStore((state) => state.notifications);
  const markNotificationRead = useLabStore((state) => state.markNotificationRead);
  const markAllNotificationsRead = useLabStore((state) => state.markAllNotificationsRead);
  const selectSymbol = useLabStore((state) => state.selectSymbol);
  const setActiveView = useLabStore((state) => state.setActiveView);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [kindFilter, setKindFilter] = useState("all");
  const [systemEnabled, setSystemEnabled] = useState(() => systemNotificationsEnabled());
  const [systemMode, setSystemMode] = useState(() => systemNotificationMode());
  const [systemNotice, setSystemNotice] = useState("");
  const [notificationError, setNotificationError] = useState("");
  const unreadCount = notifications.filter((item) => !item.read).length;
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const filteredNotifications = notifications.filter((item) => {
    if (statusFilter === "unread" && item.read) return false;
    if (["critical", "warning", "info"].includes(statusFilter) && item.severity !== statusFilter) return false;
    if (kindFilter !== "all" && item.kind !== kindFilter) return false;
    if (!normalizedQuery) return true;
    return [item.title, item.body, item.symbol, item.name, item.source].some((value) => String(value || "").toLocaleLowerCase("zh-CN").includes(normalizedQuery));
  });
  const markRead = (item) => {
    if (item.read) return;
    setNotificationError("");
    void markNotificationRead(item.id).catch((error) => setNotificationError(errorMessage(error, "消息状态暂时无法保存，请稍后重试")));
  };
  const openSymbol = (item) => {
    markRead(item);
    if (item.symbol) selectSymbol(item.symbol);
  };
  const openMonitor = (item) => {
    markRead(item);
    setActiveView("monitor");
  };
  const handleNotificationKeyDown = (event, item) => {
    if (event.target !== event.currentTarget || !["Enter", " "].includes(event.key)) return;
    event.preventDefault();
    markRead(item);
  };
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
    setSystemNotice("系统通知已开启，新的盯盘、事件和组合提醒会同时显示在系统通知中心。");
  };
  const changeSystemMode = (event) => {
    const next = setSystemNotificationMode(event.target.value);
    setSystemMode(next);
    setSystemNotice(next === SYSTEM_NOTIFICATION_MODES.CRITICAL ? "已切换为仅关键提醒；普通信息仍会保留在站内消息。" : "已切换为接收全部提醒。");
  };
  const markAllRead = () => {
    setNotificationError("");
    void markAllNotificationsRead().catch((error) => setNotificationError(errorMessage(error, "消息状态暂时无法保存，请稍后重试")));
  };
  return <div className="secondary-page notifications-page"><header><div><h1>站内消息</h1><p>盯盘触发、事件提醒、数据查询结果与运行状态都会保存在这里</p></div><div className="notification-actions"><span className="notification-unread-count" aria-label={`${unreadCount} 条未读消息`}>{unreadCount ? `${unreadCount} 条未读` : "全部已读"}</span><label className="notification-preference"><input type="checkbox" checked={systemEnabled} onChange={() => { void toggleSystemNotifications(); }} />系统通知</label><label className="notification-preference"><span>级别</span><select aria-label="系统通知级别" value={systemMode} disabled={!systemEnabled} onChange={changeSystemMode}><option value={SYSTEM_NOTIFICATION_MODES.ALL}>全部提醒</option><option value={SYSTEM_NOTIFICATION_MODES.CRITICAL}>仅关键提醒</option></select></label><button className="secondary-button" disabled={!unreadCount} onClick={markAllRead}>全部标为已读</button></div></header>{systemNotice && <p className="settings-notice" role="status">{systemNotice}</p>}{notificationError && <p className="settings-notice error" role="alert">{notificationError}</p>}<div className="notifications-toolbar"><label className="search-box"><MagnifyingGlass size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索消息、标的或来源…" aria-label="搜索消息" /></label><div className="filter-group" aria-label="消息状态"><button type="button" className={statusFilter === "all" ? "active" : ""} onClick={() => setStatusFilter("all")}>全部</button><button type="button" className={statusFilter === "unread" ? "active" : ""} onClick={() => setStatusFilter("unread")}>未读</button><button type="button" className={statusFilter === "critical" ? "active" : ""} onClick={() => setStatusFilter("critical")}>关键</button><button type="button" className={statusFilter === "warning" ? "active" : ""} onClick={() => setStatusFilter("warning")}>提醒</button><button type="button" className={statusFilter === "info" ? "active" : ""} onClick={() => setStatusFilter("info")}>信息</button></div><div className="filter-group" aria-label="消息类型"><button type="button" className={kindFilter === "all" ? "active" : ""} onClick={() => setKindFilter("all")}>全部类型</button><button type="button" className={kindFilter === "monitor" ? "active" : ""} onClick={() => setKindFilter("monitor")}>盯盘</button><button type="button" className={kindFilter === "portfolio-alert" ? "active" : ""} onClick={() => setKindFilter("portfolio-alert")}>组合提醒</button><button type="button" className={kindFilter === "event" ? "active" : ""} onClick={() => setKindFilter("event")}>事件提醒</button></div></div>{notifications.length === 0 ? <div className="empty-state"><BellRinging size={30} /><strong>还没有消息</strong><p>真实盯盘、事件或组合提醒会保存在这里。</p></div> : filteredNotifications.length === 0 ? <div className="empty-state notification-filter-empty"><Funnel size={30} /><strong>没有符合条件的消息</strong><p>调整搜索词或筛选条件；原始消息不会被删除。</p><button className="secondary-button" onClick={() => { setQuery(""); setStatusFilter("all"); setKindFilter("all"); }}>清除筛选</button></div> : <div className="notification-list">{filteredNotifications.map((item) => <article className={item.read ? "notification read" : "notification unread"} key={item.id} tabIndex="0" role="button" aria-label={`${item.read ? "已读" : "未读"}消息：${item.title}`} onClick={() => markRead(item)} onKeyDown={(event) => handleNotificationKeyDown(event, item)}><div className={`notification-severity ${item.severity}`} /><div className="notification-copy"><div className="notification-heading"><strong>{item.title}</strong><span className={`notification-kind ${item.kind}`}>{item.kind === "portfolio-alert" ? "组合提醒" : item.kind === "monitor" ? "盯盘" : item.kind === "event" ? "事件提醒" : "消息"}</span></div><p>{item.body}</p><small>{new Date(item.createdAt).toLocaleString("zh-CN")} · {item.source === "data-service" ? "真实数据服务" : "浏览器预览"}{item.symbol ? ` · ${item.symbol}` : ""}</small>{(item.symbol || item.kind === "monitor") && <div className="notification-item-actions"><button type="button" className="notification-link" onClick={(event) => { event.stopPropagation(); openSymbol(item); }} disabled={!item.symbol}>查看标的</button>{item.kind === "monitor" && <button type="button" className="notification-link" onClick={(event) => { event.stopPropagation(); openMonitor(item); }}>查看盯盘</button>}</div>}</div>{!item.read && <span className="unread-dot" />}</article>)}</div>}</div>;
}

export function SkillsView() {
  const [query, setQuery] = useState("");
  const [pendingId, setPendingId] = useState("");
  const items = useLabStore((state) => state.skillItems);
  const toggleSkill = useLabStore((state) => state.toggleSkill);
  const setSettingsNotice = useLabStore((state) => state.setSettingsNotice);
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const filteredItems = normalizedQuery ? items.filter((skill) => `${skill.name} ${skill.description} ${skill.category}`.toLocaleLowerCase("zh-CN").includes(normalizedQuery)) : items;
  const handleToggle = (id) => {
    setPendingId(id);
    void toggleSkill(id).catch(() => {
      setSettingsNotice({ type: "error", action: "retry", text: "Skill 状态暂时无法保存，请稍后重试" });
    }).finally(() => setPendingId((current) => current === id ? "" : current));
  };
  return <div className="secondary-page"><header><div><h1>Skill 市场</h1><p>为 Pi 安装经过审核的金融研究能力</p></div><label className="search-box"><MagnifyingGlass size={18} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 Skills…" aria-label="搜索 Skills" /></label></header><div className="skill-grid">{filteredItems.map((skill) => <article key={skill.id}><div className="skill-icon"><CheckCircle size={24} weight={skill.installed ? "fill" : "regular"} /></div><div><span>{skill.category}</span><h2>{skill.name}</h2><p>{skill.description}</p></div><button className={skill.installed ? "installed" : ""} aria-pressed={skill.installed} disabled={Boolean(pendingId)} onClick={() => handleToggle(skill.id)}>{pendingId === skill.id ? "保存中…" : skill.installed ? "已安装" : "安装"}</button></article>)}</div>{filteredItems.length === 0 && <p className="security-note" role="status">没有匹配“{query.trim()}”的 Skill。</p>}<p className="security-note">安装状态会保存到当前 Host，刷新或重启后保持；第三方 Skill 在安装前会显示权限、来源和签名状态，工具调用由 Host 白名单控制。</p></div>;
}

export const installedSkillIdsForBackup = (skillItems = []) => skillItems.filter((item) => item?.installed === true).map((item) => item.id);

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
  const monitorHistory = useLabStore((state) => state.monitorHistory);
  const skillItems = useLabStore((state) => state.skillItems);
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
  const [desktopLifecycle, setDesktopLifecycle] = useState(null);
  const [desktopLifecycleError, setDesktopLifecycleError] = useState("");
  const [desktopLifecycleBusy, setDesktopLifecycleBusy] = useState(false);
  const [connectionTestState, setConnectionTestState] = useState("idle");
  const [connectionTestMessage, setConnectionTestMessage] = useState("");
  const [modelTestState, setModelTestState] = useState("idle");
  const [modelTestMessage, setModelTestMessage] = useState("");
  const [refreshPolicy, setRefreshPolicy] = useState(loadRefreshPolicy);
  const backupInput = useRef(null);
  const loadRequest = useRef(0);

  useEffect(() => {
    if (!isDesktopRuntime()) return undefined;
    let active = true;
    void loadDesktopLifecycleStatus().then((value) => {
      if (!active) return;
      setDesktopLifecycle(value);
      setDesktopLifecycleError("");
    }).catch((error) => {
      if (active) setDesktopLifecycleError(errorMessage(error, "桌面驻留状态暂时无法读取，请稍后重试"));
    });
    return () => { active = false; };
  }, []);

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
  const saveKey = () => run(async () => { await saveQVerisCredential(apiKey); const next = { ...status, credentialConfigured: true, keyPrefix: apiKeyPrefix(apiKey) }; setApiKey(""); setStatus(next); setIntegrationStatus(next); setConnectionTestState("idle"); setConnectionTestMessage(""); setModelTestState("idle"); setModelTestMessage(""); }, "数据服务密钥已保存");
  const clearKey = () => run(async () => { await clearQVerisCredential(); const next = { ...status, credentialConfigured: false, keyPrefix: "" }; setStatus(next); setIntegrationStatus(next); setConnectionTestState("idle"); setConnectionTestMessage(""); setModelTestState("idle"); setModelTestMessage(""); }, "数据服务密钥已清除");
  const syncModels = () => run(async () => { const value = await syncQVerisModels(form); const next = { ...status, settings: value }; setStatus(next); setIntegrationStatus(next); setModelTestState("idle"); setModelTestMessage(""); return value; }, "模型目录已同步");
  const saveAll = async () => {
    if (!beginRuntimeConfiguration()) {
      const message = "当前分析尚未结束，请等待完成或停止后再应用设置";
      setNotice(message);
      setSettingsNotice({ type: "error", text: message });
      return;
    }
    try {
      await run(async () => { const value = await applyIntegrationSettings(form); const next = { ...status, settings: value }; setStatus(next); setIntegrationStatus(next); setModelTestState("idle"); setModelTestMessage(""); return value; }, "设置已保存，Pi Runtime 已应用新模型", true);
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
  const savedCapabilityEndpoint = normalizeEndpoint(status.settings?.capabilityBaseUrl);
  const currentCapabilityEndpoint = normalizeEndpoint(form.capabilityBaseUrl);
  const capabilityEndpointChanged = savedCapabilityEndpoint !== currentCapabilityEndpoint;
  const savedModelReady = Boolean(status.settings?.modelId && form.modelId === status.settings.modelId && selectedModelAvailable && !gatewayChanged);
  const refreshPolicyConfigValue = refreshPolicyConfig(refreshPolicy);
  const changeRefreshPolicy = (event) => {
    const next = saveRefreshPolicy(event.target.value);
    setRefreshPolicy(next);
    setNotice(`行情自动刷新已切换为“${REFRESH_POLICIES[next].label}”`);
  };
  const testDataConnection = async () => {
    if (connectionTestState === "loading") return;
    if (!status.credentialConfigured || status.demo) {
      setConnectionTestState("error");
      setConnectionTestMessage("请先在本地 Host 或桌面端保存数据服务 API Key");
      return;
    }
    if (capabilityEndpointChanged) {
      setConnectionTestState("error");
      setConnectionTestMessage("数据能力地址已修改，请先保存并应用后再测试");
      return;
    }
    const symbol = String(watchlist[0]?.symbol || "600519");
    setConnectionTestState("loading");
    setConnectionTestMessage("");
    const startedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
    try {
      const result = await queryCapabilityData({ kind: "quote", symbol });
      const payload = result?.data ?? result;
      const quote = Array.isArray(payload?.quotes) ? payload.quotes.find((item) => String(item?.symbol || item?.code || symbol).replace(/\.(?:SH|SS|SZ)$/i, "") === symbol.replace(/\.(?:SH|SS|SZ)$/i, "")) || payload.quotes[0] : payload?.quote || payload;
      const price = Number(quote?.price ?? quote?.lastPrice ?? quote?.last_price);
      if (!Number.isFinite(price) || price <= 0) throw new Error("数据渠道未返回可识别的真实行情");
      const elapsed = Math.max(0, Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - startedAt));
      const source = String(result?.source || quote?.source || "数据服务");
      const asOf = quote?.asOf || quote?.as_of || quote?.timestamp || "数据时间未知";
      setConnectionTestState("success");
      setConnectionTestMessage(`连接成功 · ${symbol} 已返回真实行情 · ${source} · ${formatQuoteFreshness(asOf, Date.now(), watchlist[0]?.market)} · ${elapsed}ms`);
    } catch (error) {
      setConnectionTestState("error");
      setConnectionTestMessage(friendlyDataMessage(error, "数据连接暂未返回可用行情，请检查 API Key 或稍后重试"));
    }
  };
  const testModelConnection = async () => {
    if (modelTestState === "loading") return;
    if (!status.credentialConfigured || status.demo) {
      setModelTestState("error");
      setModelTestMessage("请先在本地 Host 或桌面端保存数据服务 API Key");
      return;
    }
    if (analysisActive) {
      setModelTestState("error");
      setModelTestMessage("当前已有分析正在运行，请等待完成或停止后再测试");
      return;
    }
    if (gatewayChanged) {
      setModelTestState("error");
      setModelTestMessage("模型网关地址已修改，请先同步模型并保存并应用后再测试");
      return;
    }
    if (!savedModelReady) {
      setModelTestState("error");
      setModelTestMessage("请先同步模型目录并保存并应用一个可用模型");
      return;
    }
    setModelTestState("loading");
    setModelTestMessage("");
    const startedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
    try {
      const result = await testModelGateway();
      if (!String(result?.text || "").trim()) throw new Error("模型没有返回可识别内容");
      const elapsed = Math.max(0, Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - startedAt));
      setModelTestState("success");
      setModelTestMessage(`模型连接成功 · ${result.model || status.settings.modelId} · ${elapsed}ms`);
    } catch (error) {
      setModelTestState("error");
      setModelTestMessage(friendlyModelMessage(error));
    }
  };
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
  const checkDesktopLifecycle = async () => {
    if (desktopLifecycleBusy) return;
    setDesktopLifecycleBusy(true);
    setDesktopLifecycleError("");
    try {
      setDesktopLifecycle(await reconcileDesktopNow());
    } catch (error) {
      setDesktopLifecycleError(errorMessage(error, "桌面驻留状态暂时无法更新，请稍后重试"));
    } finally {
      setDesktopLifecycleBusy(false);
    }
  };
  const exportBackup = () => {
    try {
      const installedSkillIds = installedSkillIdsForBackup(skillItems);
      const content = serializeUserStateBackup({ watchlist, rules, notifications, portfolioPositions, portfolioReviews, briefingSchedule, monitorHistory, installedSkillIds });
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
    <section className="settings-card"><div className="settings-card-title"><div><strong>金融数据能力</strong><small>默认连接金融数据能力目录；首次固化后按稳定 tool schema 调用，避免每次重新搜索。</small></div><span className="status-pill ok">CAP</span></div><label>数据能力 API<input value={form.capabilityBaseUrl} disabled={formDisabled} onChange={(event) => { setForm((value) => ({ ...value, capabilityBaseUrl: event.target.value })); setConnectionTestState("idle"); setConnectionTestMessage(""); }} aria-label="数据能力 API" /></label><div className="settings-inline-note">Provider：{form.dataProvider || "qveris_finance"} · 渠道：{form.dataChannel || "qveris-cap"}</div><div className="connection-test-row"><button type="button" className="secondary-button" disabled={formDisabled || !status.credentialConfigured || status.demo || capabilityEndpointChanged || connectionTestState === "loading"} onClick={() => { void testDataConnection(); }}>{connectionTestState === "loading" ? "测试中…" : "测试数据连接"}</button><span className={`connection-test-status ${connectionTestState}`} role="status">{connectionTestMessage || (capabilityEndpointChanged ? "保存并应用新地址后可测试" : status.credentialConfigured ? "使用当前自选的第一个标的进行真实 CAP 测试" : "保存 API Key 后可测试真实数据")}</span></div></section>
    <section className="settings-card"><div className="settings-card-title"><div><strong>行情自动刷新</strong><small>仅控制已配置真实数据时的后台刷新频率；手动刷新仍可随时获取真实行情。</small></div><span className="status-pill">本地偏好</span></div><div className="settings-inline"><label className="refresh-policy-select">刷新策略<select aria-label="行情自动刷新策略" value={refreshPolicy} onChange={changeRefreshPolicy} disabled={formDisabled}>{Object.values(REFRESH_POLICIES).map((policy) => <option value={policy.id} key={policy.id}>{policy.label}</option>)}</select></label><span className="settings-inline-note">{refreshPolicyConfigValue.description}</span></div><p className="settings-inline-note">频繁刷新会增加上游调用次数和费用；切换策略会立即应用，并在下次可见时按新策略更新。</p></section>
    <section className="settings-card"><div className="settings-card-title"><div><strong>Pi 模型 · 模型网关</strong><small>通过运行时短期令牌访问本机回环代理，长期 API Key 不会交给 Pi。</small></div><button className="secondary-button" disabled={formDisabled || !status.credentialConfigured} onClick={syncModels}>同步模型</button></div><label>Gateway Base URL<input value={form.modelGatewayBaseUrl} disabled={formDisabled} onChange={(event) => { setForm((value) => ({ ...value, modelGatewayBaseUrl: event.target.value })); setModelTestState("idle"); setModelTestMessage(""); }} aria-label="Gateway Base URL" /></label><label>默认模型<select value={form.modelId} disabled={formDisabled} onChange={(event) => { setForm((value) => ({ ...value, modelId: event.target.value })); setModelTestState("idle"); setModelTestMessage(""); }} aria-label="默认模型"><option value="">请先同步模型目录</option>{modelOptions.map((model) => <option value={model.id} key={model.id}>{model.name || model.id}</option>)}</select></label><div className="settings-actions"><span>{analysisActive ? "请等待当前分析结束后再应用设置" : modelStatus}</span><div className="settings-action-buttons"><button type="button" className="secondary-button" disabled={formDisabled || analysisActive || status.demo || !savedModelReady || modelTestState === "loading"} onClick={() => { void testModelConnection(); }}>{modelTestState === "loading" ? "测试中…" : "测试模型"}</button><button disabled={formDisabled || analysisActive || status.demo || gatewayChanged || !selectedModelAvailable} onClick={() => { void saveAll(); }}>{busy || runtimeConfiguring ? "处理中…" : "保存并应用"}</button></div></div><div className={`model-test-status ${modelTestState}`} role="status">{modelTestMessage || (savedModelReady ? "测试会发起一次最小模型请求，不调用金融数据工具，可能产生模型费用" : "同步并保存模型后可测试对话链路")}</div></section>
    <section className="settings-card"><div className="settings-card-title"><div><strong>桌面驻留</strong><small>{isDesktopRuntime() ? "关闭主窗口后 FolioMind 会隐藏到系统托盘并继续核对已启用的自动复盘；请从托盘菜单显式退出。" : "桌面版支持关闭窗口后驻留系统托盘；Web 本地调试页面关闭后不会继续运行。"}</small></div><span className={desktopLifecycle?.residentMode ? "status-pill ok" : "status-pill"}>{desktopLifecycle?.residentMode ? desktopLifecycle.hiddenToTray ? "托盘运行中" : "已启用" : "桌面版可用"}</span></div>{isDesktopRuntime() && <>{desktopLifecycleError && <p className="settings-notice error" role="alert">{desktopLifecycleError}</p>}<div className="settings-actions"><span>托盘菜单可显示窗口、立即检查盘后复盘或完全退出。</span><button className="secondary-button" disabled={desktopLifecycleBusy} onClick={() => { void checkDesktopLifecycle(); }}>{desktopLifecycleBusy ? "检查中…" : "立即检查"}</button></div></>}</section>
    <section className="settings-card update-card"><div className="settings-card-title"><div><strong>应用更新</strong><small>当前版本 {currentVersion} · 从 FolioMind 官方 GitHub 发布页检查公开版本。</small></div><button className="secondary-button" disabled={updateState === "loading"} onClick={() => { void checkForUpdates(); }}>{updateLabel}</button></div><div className="update-status" aria-live="polite"><span>{updateMessage}</span>{latestRelease && compareVersions(latestRelease.version, currentVersion) > 0 && <a href={latestRelease.url || RELEASES_PAGE_URL} target="_blank" rel="noopener noreferrer">查看新版本</a>}{!latestRelease && <a href={RELEASES_PAGE_URL} target="_blank" rel="noopener noreferrer">打开发布页</a>}</div><small className="update-note">安装包更新仍需从发布页下载安装；正式自动更新还需要平台签名密钥。</small></section>
    <section className="settings-card backup-card"><div className="settings-card-title"><div><strong>本地数据备份</strong><small>迁移自选、盯盘、消息和持仓到另一台设备。凭据、模型网关、缓存和运行日志永远不会写入备份。</small></div><span className="status-pill">可导入导出</span></div><div className="backup-actions"><button className="secondary-button" disabled={formDisabled || backupBusy} onClick={exportBackup}><DownloadSimple size={15} />导出 JSON</button><button className="secondary-button" disabled={formDisabled || backupBusy} onClick={() => backupInput.current?.click()}><UploadSimple size={15} />{backupBusy ? "导入中…" : "导入 JSON"}</button><input ref={backupInput} className="visually-hidden" type="file" accept="application/json,.json" onChange={(event) => { void importBackup(event); }} /></div></section>
    {notice && <p className="settings-notice" role="status">{notice}</p>}
  </div>;
}

export function ChatView() { return <CopilotPanel standalone />; }
