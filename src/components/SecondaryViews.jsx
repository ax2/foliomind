import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, BellRinging, CheckCircle, MagnifyingGlass, Play, Plus, Trash, X } from "@phosphor-icons/react";
import { monitorEvents, skills } from "../data/market.js";
import { monitorStrategies, strategyFor } from "../data/monitorStrategies.js";
import { apiKeyPrefix, applyIntegrationSettings, clearQVerisCredential, defaultIntegrationSettings, loadIntegrationStatus, saveQVerisCredential, syncQVerisModels } from "../lib/integrations.js";
import { formatPercent, formatPrice } from "../lib/quoteFormatting.js";
import { useLabStore } from "../store/useLabStore.js";
import { CopilotPanel } from "./CopilotPanel.jsx";

const normalizeEndpoint = (value) => String(value ?? "").trim().replace(/\/+$/, "");
const errorMessage = (error) => error instanceof Error ? error.message : String(error);

export function MarketView() {
  const watchlist = useLabStore((state) => state.watchlist);
  const liveQuotes = useLabStore((state) => state.liveQuotes);
  const integrationStatus = useLabStore((state) => state.integrationStatus);
  const refreshLiveData = useLabStore((state) => state.refreshLiveData);
  const liveDataLoading = useLabStore((state) => state.liveDataLoading);
  const liveDataError = useLabStore((state) => state.liveDataError);
  const liveDataLastRefreshAt = useLabStore((state) => state.liveDataLastRefreshAt);
  const realDataMode = Boolean(integrationStatus?.credentialConfigured && integrationStatus?.settings?.modelId);
  const returnedQuotes = watchlist.filter((item) => Number.isFinite(liveQuotes[item.symbol]?.price));
  return <div className="secondary-page"><header><div><h1>市场行情</h1><p>跨市场指数、自选与异动概览</p></div><span>{realDataMode ? "仅显示 QVeris 已返回的真实数据" : "配置模型后显示真实行情"}</span></header><div className="index-board">{realDataMode && returnedQuotes.length ? returnedQuotes.map((item) => { const quote = liveQuotes[item.symbol]; return <article key={item.symbol}><span>{item.name} <small>{item.symbol}</small></span><strong>{formatPrice(quote.price)}</strong><small className={quote.change >= 0 ? "up" : "down"}>{formatPercent(quote.change)}</small><em>{quote.source || "QVeris"}{quote.asOf ? ` · ${quote.asOf}` : ""}</em></article>; }) : <div className="empty-state"><strong>{realDataMode ? "暂无已查询的市场数据" : "行情预览"}</strong><p>{realDataMode ? "正在从 QVeris 获取自选行情，返回后将显示在这里。" : "当前未配置真实模型，预览数据不会用于投资判断。"}</p></div>}</div><section className="market-table"><h2>我的自选</h2><div className="table-head"><span>名称 / 代码</span><span>最新价</span><span>涨跌幅</span><span>市场</span></div>{watchlist.map((item) => { const quote = liveQuotes[item.symbol]; return <div className="table-row" key={item.symbol}><span><strong>{item.name}</strong><small>{item.symbol}</small></span><span>{Number.isFinite(quote?.price) ? formatPrice(quote.price) : "—"}</span><span className={quote?.change >= 0 ? "up" : "down"}>{formatPercent(quote?.change)}</span><span>{item.market}</span></div>; })}</section></div>;
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
    void sendMessage(`请把以下界面示例信号作为待核实线索，不要直接当作事实：${event.title}——${event.detail}。请使用 qveris-finance-research Skill 按 Search → Inspect → Call 查询最新真实数据，给出来源、截至时间，并判断该信号是否成立。`);
  };
  return <div className="secondary-page"><header><div><h1>个股盯盘</h1><p>Pi Agent 按策略定时检查真实 QVeris 数据，并在消息中心提醒</p></div><button className="primary-action" disabled={!realDataMode} onClick={() => setDialogOpen(true)}><Plus size={17} />新建盯盘</button></header>{!realDataMode && <div className="settings-notice">请先配置 API Key、同步模型并保存，盯盘只接受真实数据。</div>}<section className="strategy-strip"><strong>内置策略</strong>{monitorStrategies.map((strategy) => <span key={strategy.id}>{strategy.name}</span>)}</section><section className="rule-list"><h2>运行中的规则</h2>{rules.map((rule) => { const strategy = strategyFor(rule.strategyId); return <article key={rule.id}><Bell size={20} /><div><strong>{strategy.name}</strong><small>{rule.symbol} · 阈值 {rule.threshold}{strategy.unit} · {rule.intervalSeconds} 秒检查</small></div><button className="rule-run" disabled={!realDataMode || monitorBusy || !rule.enabled} onClick={() => { void runMonitorCheck(rule.id); }} aria-label={`立即检查${rule.symbol}`}><Play size={14} weight="fill" /></button><button className={rule.enabled ? "toggle on" : "toggle"} onClick={() => toggleRule(rule.id)} aria-label={`${rule.enabled ? "停用" : "启用"}${strategy.name}`} aria-pressed={rule.enabled}><span /></button><button className="icon-button" aria-label={`删除${strategy.name}`} onClick={() => { void deleteRule(rule.id); }}><Trash size={15} /></button></article>; })}</section>{realDataMode ? <p className="security-note">没有已返回的真实信号。运行规则后，结果将出现在消息中心。</p> : <section className="event-list"><h2>预览线索（不会作为事实）</h2>{monitorEvents.map((event) => <article key={event.id}><time>{event.time}</time><span className="timeline-dot" /><div><strong>{event.title}</strong><p>{event.detail}</p></div><button onClick={() => analyzeEvent(event)}>核实并分析</button></article>)}</section>}{dialogOpen && <div className="modal-backdrop" role="presentation"><form className="modal-card" onSubmit={createRule}><div className="modal-heading"><h2>新建盯盘策略</h2><button type="button" className="icon-button" aria-label="关闭" onClick={() => setDialogOpen(false)}><X size={18} /></button></div><p className="modal-help">默认策略包含成交量异常监控、价格异动和公告与舆情。</p><label>标的<select value={form.symbol} onChange={(event) => setForm((value) => ({ ...value, symbol: event.target.value }))}>{watchlist.map((item) => <option key={item.symbol} value={item.symbol}>{item.name}（{item.symbol}）</option>)}</select></label><label>策略<select value={form.strategyId} onChange={(event) => { const next = strategyFor(event.target.value); setForm((value) => ({ ...value, strategyId: next.id, threshold: next.defaultThreshold })); }}>{monitorStrategies.map((strategy) => <option key={strategy.id} value={strategy.id}>{strategy.name} · {strategy.description}</option>)}</select></label><label>阈值<input type="number" min="0" step="0.1" value={form.threshold} onChange={(event) => setForm((value) => ({ ...value, threshold: event.target.value }))} /><small>{selectedStrategy.unit}</small></label><label>检查间隔<select value={form.intervalSeconds} onChange={(event) => setForm((value) => ({ ...value, intervalSeconds: event.target.value }))}><option value="60">每 60 秒</option><option value="300">每 5 分钟</option><option value="600">每 10 分钟</option><option value="1800">每 30 分钟</option></select></label><button className="primary-action" type="submit">保存并启用</button></form></div>}</div>;
}

export function NotificationsView() {
  const notifications = useLabStore((state) => state.notifications);
  const markNotificationRead = useLabStore((state) => state.markNotificationRead);
  const markAllNotificationsRead = useLabStore((state) => state.markAllNotificationsRead);
  return <div className="secondary-page notifications-page"><header><div><h1>站内消息</h1><p>盯盘触发、QVeris 查询结果与运行状态都会保存在这里</p></div><button className="secondary-button" disabled={!notifications.some((item) => !item.read)} onClick={markAllNotificationsRead}>全部标为已读</button></header>{notifications.length === 0 ? <div className="empty-state"><BellRinging size={30} /><strong>还没有盯盘消息</strong><p>启用一条策略后，Pi 会按间隔检查真实数据。</p></div> : <div className="notification-list">{notifications.map((item) => <article className={item.read ? "notification read" : "notification unread"} key={item.id} onClick={() => markNotificationRead(item.id)}><div className={`notification-severity ${item.severity}`} /><div><strong>{item.title}</strong><p>{item.body}</p><small>{new Date(item.createdAt).toLocaleString("zh-CN")} · {item.source === "qveris" ? "QVeris 真实查询" : "浏览器预览"}</small></div>{!item.read && <span className="unread-dot" />}</article>)}</div>}</div>;
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
      setLoadError(integrationStatusError);
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
      const message = errorMessage(error);
      setNotice(message);
      if (persistNotice) setSettingsNotice({ type: "error", text: message });
    }
    finally { setBusy(false); }
  };
  const saveKey = () => run(async () => { await saveQVerisCredential(apiKey); const next = { ...status, credentialConfigured: true, keyPrefix: apiKeyPrefix(apiKey) }; setApiKey(""); setStatus(next); setIntegrationStatus(next); }, "QVeris API Key 已保存");
  const clearKey = () => run(async () => { await clearQVerisCredential(); const next = { ...status, credentialConfigured: false, keyPrefix: "" }; setStatus(next); setIntegrationStatus(next); }, "QVeris API Key 已清除");
  const syncModels = () => run(async () => { const value = await syncQVerisModels(form); const next = { ...status, settings: value }; setStatus(next); setIntegrationStatus(next); return value; }, "模型目录已从 QVeris 网关同步");
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
  return <div className="secondary-page settings-page" aria-busy={loadState === "loading" || busy || runtimeConfiguring}><header><div><h1>设置</h1><p>真实数据、模型网关与本地凭据</p></div><span>{environmentLabel}</span></header>
    {loadError && <div className="settings-notice error" role="alert"><span>设置加载失败：{loadError}</span><button className="secondary-button" onClick={() => { void loadSettings(); }}>重试加载</button></div>}
    <section className="settings-card"><div className="settings-card-title"><div><strong>QVeris 数据与模型凭证</strong><small>{localDevHost ? "本地开发 Host 将密钥保存到用户配置目录（权限 0600）；浏览器不保存长期密钥。" : "同一个 API Key 可用于工具 API 与模型网关；密钥只保存在系统凭据库。"}</small></div><span className={loadState === "ready" && status.credentialConfigured ? "status-pill ok" : "status-pill"}>{credentialLabel}</span></div><div className="settings-inline"><input type="password" autoComplete="new-password" value={apiKey} disabled={formDisabled} onChange={(event) => setApiKey(event.target.value)} placeholder="粘贴 QVeris API Key" aria-label="QVeris API Key" /><button disabled={formDisabled || !apiKey.trim()} onClick={saveKey}>保存密钥</button>{status.credentialConfigured && <button className="secondary-button" disabled={formDisabled} onClick={clearKey}>清除</button>}</div></section>
    <section className="settings-card"><div className="settings-card-title"><div><strong>QVeris 工具</strong><small>金融 Skill 内置 Search → Inspect → Call，真实数据调用由本机 Host 审计与转发。</small></div><span className="status-pill ok">内置 Skill</span></div><label>Capability API<input value={form.capabilityBaseUrl} disabled={formDisabled} onChange={(event) => setForm((value) => ({ ...value, capabilityBaseUrl: event.target.value }))} aria-label="Capability API" /></label></section>
    <section className="settings-card"><div className="settings-card-title"><div><strong>Pi 模型 · QVeris Model Gateway</strong><small>通过运行时短期令牌访问本机回环代理，长期 API Key 不会交给 Pi。</small></div><button className="secondary-button" disabled={formDisabled || !status.credentialConfigured} onClick={syncModels}>同步模型</button></div><label>Gateway Base URL<input value={form.modelGatewayBaseUrl} disabled={formDisabled} onChange={(event) => setForm((value) => ({ ...value, modelGatewayBaseUrl: event.target.value }))} aria-label="Gateway Base URL" /></label><label>默认模型<select value={form.modelId} disabled={formDisabled} onChange={(event) => setForm((value) => ({ ...value, modelId: event.target.value }))} aria-label="默认模型"><option value="">请先同步模型目录</option>{modelOptions.map((model) => <option value={model.id} key={model.id}>{model.name || model.id}</option>)}</select></label><div className="settings-actions"><span>{analysisActive ? "请等待当前分析结束后再应用设置" : modelStatus}</span><button disabled={formDisabled || analysisActive || status.demo || gatewayChanged || !selectedModelAvailable} onClick={() => { void saveAll(); }}>{busy || runtimeConfiguring ? "处理中…" : "保存并应用"}</button></div></section>
    {notice && <p className="settings-notice" role="status">{notice}</p>}
  </div>;
}

export function ChatView() { return <CopilotPanel standalone />; }
