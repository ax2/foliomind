import { useEffect, useState } from "react";
import { Bell, CheckCircle, MagnifyingGlass, Plus } from "@phosphor-icons/react";
import { monitorEvents, skills, watchGroups } from "../data/market.js";
import { applyIntegrationSettings, clearQVerisCredential, defaultIntegrationSettings, loadIntegrationStatus, saveQVerisCredential, syncQVerisModels } from "../lib/integrations.js";
import { useLabStore } from "../store/useLabStore.js";
import { CopilotPanel } from "./CopilotPanel.jsx";

const normalizeEndpoint = (value) => String(value ?? "").trim().replace(/\/+$/, "");

export function MarketView() {
  return <div className="secondary-page"><header><div><h1>市场行情</h1><p>跨市场指数、自选与异动概览</p></div><span>界面示例 · 实时数据请交给 Agent 查询</span></header><div className="index-board">{["上证指数", "深证成指", "创业板指", "恒生指数", "标普 500", "纳斯达克"].map((name, index) => <article key={name}><span>{name}</span><strong>{[3856.12, 12844.7, 2752.08, 25862.53, 6501.86, 21713.14][index].toLocaleString()}</strong><small className={index < 3 ? "up" : "down"}>{index < 3 ? "+0.68%" : "-0.41%"}</small></article>)}</div><section className="market-table"><h2>自选行情</h2><div className="table-head"><span>名称 / 代码</span><span>最新价</span><span>涨跌幅</span><span>市场</span></div>{watchGroups.flatMap((g) => g.items).slice(0, 7).map((item) => <div className="table-row" key={item.symbol}><span><strong>{item.name}</strong><small>{item.symbol}</small></span><span>{item.price.toFixed(2)}</span><span className={item.change >= 0 ? "up" : "down"}>{item.change >= 0 ? "+" : ""}{item.change.toFixed(2)}%</span><span>{item.market}</span></div>)}</section></div>;
}

export function MonitorView() {
  const rules = useLabStore((state) => state.rules);
  const toggleRule = useLabStore((state) => state.toggleRule);
  const addRule = useLabStore((state) => state.addRule);
  const setActiveView = useLabStore((state) => state.setActiveView);
  const sendMessage = useLabStore((state) => state.sendMessage);
  const analyzeEvent = (event) => {
    setActiveView("chat");
    void sendMessage(`请把以下界面示例信号作为待核实线索，不要直接当作事实：${event.title}——${event.detail}。请使用 qveris-finance-research Skill 按 Search → Inspect → Call 查询最新真实数据，给出来源、截至时间，并判断该信号是否成立。`);
  };
  return <div className="secondary-page"><header><div><h1>个股盯盘</h1><p>持续追踪价格、成交量与关键事件</p></div><button className="primary-action" onClick={() => addRule("600519")}><Plus size={17} />新建盯盘</button></header><section className="rule-list"><h2>运行中的规则</h2>{rules.map((rule) => <article key={rule.id}><Bell size={20} /><div><strong>{rule.name}</strong><small>{rule.symbol} · 示例规则</small></div><button className={rule.enabled ? "toggle on" : "toggle"} onClick={() => toggleRule(rule.id)} aria-label={`${rule.enabled ? "停用" : "启用"}${rule.name}`} aria-pressed={rule.enabled}><span /></button></article>)}</section><section className="event-list"><h2>示例信号</h2>{monitorEvents.map((event) => <article key={event.id}><time>{event.time}</time><span className="timeline-dot" /><div><strong>{event.title}</strong><p>{event.detail}</p></div><button onClick={() => analyzeEvent(event)}>核实并分析</button></article>)}</section></div>;
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
  const [status, setStatus] = useState({ credentialConfigured: false, settings: defaultIntegrationSettings, demo: true });
  const [form, setForm] = useState(defaultIntegrationSettings);
  const [apiKey, setApiKey] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    loadIntegrationStatus().then((value) => { if (active) { setStatus(value); setForm(value.settings); } }).catch((error) => { if (active) setNotice(String(error)); });
    return () => { active = false; };
  }, []);

  const run = async (action, success) => {
    setBusy(true); setNotice("");
    try { const value = await action(); if (value?.models) setForm(value); setNotice(success); }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const saveKey = () => run(async () => { await saveQVerisCredential(apiKey); setApiKey(""); setStatus((value) => ({ ...value, credentialConfigured: true })); }, "QVeris API Key 已保存到系统凭据库");
  const clearKey = () => run(async () => { await clearQVerisCredential(); setStatus((value) => ({ ...value, credentialConfigured: false })); }, "QVeris API Key 已清除");
  const syncModels = () => run(async () => { const value = await syncQVerisModels(form); setStatus((current) => ({ ...current, settings: value })); return value; }, "模型目录已从 QVeris 网关同步");
  const saveAll = () => run(async () => { const value = await applyIntegrationSettings(form); setStatus((current) => ({ ...current, settings: value })); return value; }, "设置已保存，Pi Runtime 已应用新模型");

  const modelOptions = form.models ?? [];
  const gatewayChanged = normalizeEndpoint(form.modelGatewayBaseUrl) !== normalizeEndpoint(status.settings.modelGatewayBaseUrl);
  const selectedModelAvailable = modelOptions.some((model) => model.id === form.modelId);
  const modelStatus = gatewayChanged ? "网关地址已变化，请先同步模型" : modelOptions.length ? `${modelOptions.length} 个可用模型` : "尚未同步模型";
  return <div className="secondary-page settings-page"><header><div><h1>设置</h1><p>真实数据、模型网关与本地凭据</p></div><span>{status.demo ? "浏览器预览" : "桌面端"}</span></header>
    <section className="settings-card"><div className="settings-card-title"><div><strong>QVeris 数据与模型凭证</strong><small>同一个 API Key 可用于工具 API 与模型网关；密钥只保存在系统凭据库。</small></div><span className={status.credentialConfigured ? "status-pill ok" : "status-pill"}>{status.credentialConfigured ? "已配置" : "未配置"}</span></div><div className="settings-inline"><input type="password" autoComplete="new-password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="粘贴 QVeris API Key" aria-label="QVeris API Key" /><button disabled={busy || !apiKey.trim()} onClick={saveKey}>保存密钥</button>{status.credentialConfigured && <button className="secondary-button" disabled={busy} onClick={clearKey}>清除</button>}</div></section>
    <section className="settings-card"><div className="settings-card-title"><div><strong>QVeris 工具</strong><small>金融 Skill 内置 Search → Inspect → Call，真实数据调用由本机 Host 审计与转发。</small></div><span className="status-pill ok">内置 Skill</span></div><label>Capability API<input value={form.capabilityBaseUrl} onChange={(event) => setForm((value) => ({ ...value, capabilityBaseUrl: event.target.value }))} aria-label="Capability API" /></label></section>
    <section className="settings-card"><div className="settings-card-title"><div><strong>Pi 模型 · QVeris Model Gateway</strong><small>通过运行时短期令牌访问本机回环代理，长期 API Key 不会交给 Pi。</small></div><button className="secondary-button" disabled={busy || !status.credentialConfigured} onClick={syncModels}>同步模型</button></div><label>Gateway Base URL<input value={form.modelGatewayBaseUrl} onChange={(event) => setForm((value) => ({ ...value, modelGatewayBaseUrl: event.target.value }))} aria-label="Gateway Base URL" /></label><label>默认模型<select value={form.modelId} onChange={(event) => setForm((value) => ({ ...value, modelId: event.target.value }))} aria-label="默认模型"><option value="">请先同步模型目录</option>{modelOptions.map((model) => <option value={model.id} key={model.id}>{model.name || model.id}</option>)}</select></label><div className="settings-actions"><span>{modelStatus}</span><button disabled={busy || status.demo || gatewayChanged || !selectedModelAvailable} onClick={saveAll}>{busy ? "处理中…" : "保存并应用"}</button></div></section>
    {notice && <p className="settings-notice" role="status">{notice}</p>}
  </div>;
}

export function ChatView() { return <CopilotPanel standalone />; }
