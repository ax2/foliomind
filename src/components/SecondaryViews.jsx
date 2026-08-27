import { Bell, CheckCircle, MagnifyingGlass, Plus } from "@phosphor-icons/react";
import { monitorEvents, skills, watchGroups } from "../data/market.js";
import { useLabStore } from "../store/useLabStore.js";
import { CopilotPanel } from "./CopilotPanel.jsx";

export function MarketView() {
  return <div className="secondary-page"><header><div><h1>市场行情</h1><p>跨市场指数、自选与异动概览</p></div><span>截至 2026-08-27 15:00 CST</span></header><div className="index-board">{["上证指数", "深证成指", "创业板指", "恒生指数", "标普 500", "纳斯达克"].map((name, index) => <article key={name}><span>{name}</span><strong>{[3856.12, 12844.7, 2752.08, 25862.53, 6501.86, 21713.14][index].toLocaleString()}</strong><small className={index < 3 ? "up" : "down"}>{index < 3 ? "+0.68%" : "-0.41%"}</small></article>)}</div><section className="market-table"><h2>自选行情</h2><div className="table-head"><span>名称 / 代码</span><span>最新价</span><span>涨跌幅</span><span>市场</span></div>{watchGroups.flatMap((g) => g.items).slice(0, 7).map((item) => <div className="table-row" key={item.symbol}><span><strong>{item.name}</strong><small>{item.symbol}</small></span><span>{item.price.toFixed(2)}</span><span className={item.change >= 0 ? "up" : "down"}>{item.change >= 0 ? "+" : ""}{item.change.toFixed(2)}%</span><span>{item.market}</span></div>)}</section></div>;
}

export function MonitorView() {
  const rules = useLabStore((state) => state.rules);
  const toggleRule = useLabStore((state) => state.toggleRule);
  const addRule = useLabStore((state) => state.addRule);
  return <div className="secondary-page"><header><div><h1>个股盯盘</h1><p>持续追踪价格、成交量与关键事件</p></div><button className="primary-action" onClick={() => addRule("600519")}><Plus size={17} />新建盯盘</button></header><section className="rule-list"><h2>运行中的规则</h2>{rules.map((rule) => <article key={rule.id}><Bell size={20} /><div><strong>{rule.name}</strong><small>{rule.symbol} · 最近检查 15:00:18</small></div><button className={rule.enabled ? "toggle on" : "toggle"} onClick={() => toggleRule(rule.id)} aria-label="切换规则"><span /></button></article>)}</section><section className="event-list"><h2>今日信号</h2>{monitorEvents.map((event) => <article key={event.id}><time>{event.time}</time><span className="timeline-dot" /><div><strong>{event.title}</strong><p>{event.detail}</p></div><button>交给助手分析</button></article>)}</section></div>;
}

export function SkillsView() {
  const items = useLabStore((state) => state.skillItems);
  const toggleSkill = useLabStore((state) => state.toggleSkill);
  return <div className="secondary-page"><header><div><h1>Skill 市场</h1><p>为 Pi 安装经过审核的金融研究能力</p></div><label className="search-box"><MagnifyingGlass size={18} /><input placeholder="搜索 Skills…" /></label></header><div className="skill-grid">{items.map((skill) => <article key={skill.id}><div className="skill-icon"><CheckCircle size={24} weight={skill.installed ? "fill" : "regular"} /></div><div><span>{skill.category}</span><h2>{skill.name}</h2><p>{skill.description}</p></div><button className={skill.installed ? "installed" : ""} onClick={() => toggleSkill(skill.id)}>{skill.installed ? "已安装" : "安装"}</button></article>)}</div><p className="security-note">第三方 Skill 在安装前会显示权限、来源和签名状态；工具调用由 Host 白名单控制。</p></div>;
}

export function SettingsView() {
  return <div className="secondary-page settings-page"><header><div><h1>设置</h1><p>运行时、数据连接与隐私</p></div></header>{[["Pi Runtime", "内置 RPC Runtime", "已连接"], ["QVeris 数据", "Hosted Capability API", "已配置"], ["凭证存储", "系统凭据库", "受保护"], ["数据区域", "Global", "可修改"]].map(([name, detail, status]) => <article key={name}><div><strong>{name}</strong><small>{detail}</small></div><span>{status}</span></article>)}</div>;
}

export function ChatView() { return <CopilotPanel standalone />; }
