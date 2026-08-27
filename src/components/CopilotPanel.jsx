import { ArrowUp, CaretRight, Check, Info, MagnifyingGlass, Plus, Sparkle } from "@phosphor-icons/react";
import { useState } from "react";
import { useLabStore } from "../store/useLabStore.js";

export function CopilotPanel({ standalone = false }) {
  const [draft, setDraft] = useState("");
  const messages = useLabStore((state) => state.messages);
  const sendMessage = useLabStore((state) => state.sendMessage);
  const runtimeMode = useLabStore((state) => state.runtimeMode);
  const submit = () => {
    const value = draft.trim();
    if (!value) return;
    sendMessage(value);
    setDraft("");
  };
  return (
    <aside className={standalone ? "copilot-panel standalone" : "copilot-panel"}>
      <div className="copilot-heading"><div><Sparkle size={20} weight="fill" />FolioMind Agent <Info size={16} /></div></div>
      <div className="conversation-feed">
        {messages.map((message) => message.role === "user" ? (
          <div key={message.id} className="user-message-wrap"><div className="user-message">{message.text}</div><time>15:00:22&nbsp; ✓✓</time></div>
        ) : (
          <div key={message.id} className="assistant-message">
            <div className="answer-title"><MagnifyingGlass size={18} />分析摘要</div>
            <p>{message.text}</p>
            <h4>关键观点</h4>
            <ul><li>收入与利润保持双位数增长，盈利能力领先行业。</li><li>品牌壁垒高，渠道库存处于合理区间。</li><li>估值接近三年 60% 分位，需关注需求节奏。</li><li>风险：宏观消费波动、政务消费约束、批价回落。</li></ul>
          </div>
        ))}
        <div className="tool-run">
          <div className="tool-run-title">工具调用（3）</div>
          {["qv_financials · 财务指标与估值", "qv_price_monitor · 批价与动销监控", "qv_news_sentiment · 舆情与事件分析"].map((tool, index) => <div key={tool}><Check size={14} />{index + 1}. {tool}<time>15:00:{22 + index * 2}</time></div>)}
          <button>查看详情 <CaretRight size={14} /></button>
        </div>
        <div className="copilot-signal">
          <div><span className="event-dot" /><strong>批价波动监控</strong><b>事件</b></div>
          <p>飞天茅台散瓶批价较昨日下跌 10 元，报 2,780 元/瓶。</p>
          <time>08-27 14:48</time>
        </div>
      </div>
      <div className="composer">
        <textarea value={draft} disabled={runtimeMode === "running"} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(); } }} placeholder={runtimeMode === "running" ? "Pi 正在分析…" : "向 FolioMind 提问或下达分析指令…"} />
        <div><button className="composer-tool" aria-label="添加内容"><Plus size={19} /></button><span className="mode-select">深度分析</span><button className="send-button" onClick={submit} aria-label="发送"><ArrowUp size={19} weight="bold" /></button></div>
      </div>
      <div className="disclaimer">内容由 AI 生成，仅供参考，不构成投资建议。</div>
    </aside>
  );
}
