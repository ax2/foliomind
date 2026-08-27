import { ArrowUp, Check, Info, MagnifyingGlass, Plus, Sparkle } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { useLabStore } from "../store/useLabStore.js";

export function CopilotPanel({ standalone = false }) {
  const [draft, setDraft] = useState("");
  const messages = useLabStore((state) => state.messages);
  const sendMessage = useLabStore((state) => state.sendMessage);
  const runtimeMode = useLabStore((state) => state.runtimeMode);
  const feedEnd = useRef(null);
  const running = runtimeMode === "running";
  useEffect(() => {
    if (typeof feedEnd.current?.scrollIntoView === "function") feedEnd.current.scrollIntoView({ block: "nearest" });
  }, [messages, running]);
  const submit = () => {
    const value = draft.trim();
    if (!value || running) return;
    void sendMessage(value);
    setDraft("");
  };
  return (
    <aside className={standalone ? "copilot-panel standalone" : "copilot-panel"}>
      <div className="copilot-heading"><div><Sparkle size={20} weight="fill" />FolioMind Agent <Info size={16} /></div></div>
      <div className="conversation-feed" role="log" aria-live="polite" aria-relevant="additions text">
        {messages.map((message) => message.role === "user" ? (
          <div key={message.id} className="user-message-wrap"><div className="user-message">{message.text}</div></div>
        ) : (
          <div key={message.id} className="assistant-message">
            <div className="answer-title"><MagnifyingGlass size={18} />分析摘要</div>
            <p>{message.text}</p>
            {message.audits?.length > 0 && <div className="tool-run"><div className="tool-run-title">QVeris 审计记录（{message.audits.length}）</div>{message.audits.map((audit, index) => <div key={`${audit.toolCallId}-${index}`}><Check size={14} />{audit.operation.toUpperCase()} · {audit.outcome === "success" ? "成功" : "失败"}</div>)}</div>}
          </div>
        ))}
        {!messages.some((message) => message.audits?.length) && <div className="audit-empty"><Info size={15} />真实工具调用后，这里会显示 Search / Inspect / Call 审计记录。</div>}
        <div ref={feedEnd} />
      </div>
      <div className="composer" aria-busy={running}>
        <textarea aria-label="分析问题" value={draft} maxLength={32000} disabled={running} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(); } }} placeholder={running ? "Pi 正在分析…" : "向 FolioMind 提问或下达分析指令…"} />
        <div><button className="composer-tool" aria-label="添加内容" disabled={running}><Plus size={19} /></button><span className="mode-select">{running ? "分析中" : "深度分析"}</span><button className="send-button" disabled={running || !draft.trim()} onClick={submit} aria-label="发送"><ArrowUp size={19} weight="bold" /></button></div>
      </div>
      <div className="disclaimer">内容由 AI 生成，仅供参考，不构成投资建议。</div>
    </aside>
  );
}
