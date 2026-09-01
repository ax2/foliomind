import { ArrowUp, Check, Info, MagnifyingGlass, Plus, Sparkle, Square } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { useLabStore } from "../store/useLabStore.js";
import { AssistantMessageText } from "./AssistantMessageText.jsx";

const quickPrompts = [
  ["最新行情", "查询当前标的的最新真实行情、数据截至时间和来源。"],
  ["公司事件", "整理当前标的未来 90 天已返回的公司事件，并列出来源和数据时间。"],
  ["风险核验", "基于当前标的已返回的真实行情和证据，列出需要进一步核验的风险点；没有证据时明确说明。"],
];

export function CopilotPanel({ standalone = false }) {
  const [draft, setDraft] = useState("");
  const [quickOpen, setQuickOpen] = useState(false);
  const textareaRef = useRef(null);
  const messages = useLabStore((state) => state.messages);
  const sendMessage = useLabStore((state) => state.sendMessage);
  const cancelMessage = useLabStore((state) => state.cancelMessage);
  const runtimeMode = useLabStore((state) => state.runtimeMode);
  const runtimeConfiguring = useLabStore((state) => state.runtimeConfiguring);
  const runtimeCancelPending = useLabStore((state) => state.runtimeCancelPending);
  const monitorBusy = useLabStore((state) => state.monitorBusy);
  const liveDataLoading = useLabStore((state) => state.liveDataLoading);
  const feedEnd = useRef(null);
  const running = runtimeMode === "running";
  const cancelling = runtimeMode === "cancelling";
  const runtimeBusy = running || cancelling;
  const busy = runtimeBusy || runtimeConfiguring || runtimeCancelPending || monitorBusy || liveDataLoading;
  useEffect(() => {
    if (typeof feedEnd.current?.scrollIntoView === "function") feedEnd.current.scrollIntoView({ block: "nearest" });
  }, [messages, busy]);
  const submit = () => {
    const value = draft.trim();
    if (!value || busy) return;
    void sendMessage(value);
    setDraft("");
  };
  const chooseQuickPrompt = (prompt) => {
    setDraft(prompt);
    setQuickOpen(false);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };
  return (
    <aside className={standalone ? "copilot-panel standalone" : "copilot-panel"}>
      <div className="copilot-heading"><div><Sparkle size={20} weight="fill" />FolioMind Agent <Info size={16} /></div></div>
      <div className="conversation-feed" role="log" aria-live="polite" aria-relevant="additions text">
        {messages.map((message) => message.role === "user" ? (
          <div key={message.id} className="user-message-wrap"><div className="user-message">{message.text}</div></div>
        ) : (
          <div key={message.id} className="assistant-message" aria-busy={message.streaming || undefined}>
            <div className="answer-title"><MagnifyingGlass size={18} />{message.streaming ? "正在分析" : "分析摘要"}</div>
            <AssistantMessageText text={message.text} streaming={message.streaming} />
            {message.audits?.length > 0 && <div className="tool-run"><div className="tool-run-title">工具调用记录（{message.audits.length}）</div>{message.audits.map((audit, index) => <div key={`${audit.toolCallId}-${index}`}><Check size={14} />{audit.operation.toUpperCase()} · {audit.outcome === "success" ? "成功" : "失败"}</div>)}</div>}
          </div>
        ))}
        {!messages.some((message) => message.audits?.length) && <div className="audit-empty"><Info size={15} />真实工具调用后，这里会显示 Search / Inspect / Call 审计记录。</div>}
        <div ref={feedEnd} />
      </div>
      <div className="composer" aria-busy={busy}>
        <textarea ref={textareaRef} aria-label="分析问题" value={draft} maxLength={32000} disabled={busy} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(); } }} placeholder={runtimeConfiguring ? "正在应用设置，暂不能发起分析…" : runtimeCancelPending ? "正在完成取消请求…" : monitorBusy ? "正在执行盯盘检查…" : liveDataLoading ? "正在更新行情，完成后可发起分析…" : busy ? (cancelling ? "正在停止本轮分析…" : "Pi 正在分析…") : "向 FolioMind 提问或下达分析指令…"} />
        <div><div className="composer-tool-wrap"><button className="composer-tool" aria-label="快捷指令" aria-expanded={quickOpen} aria-controls="quick-prompts" disabled={busy} onClick={() => setQuickOpen((value) => !value)}><Plus size={19} /></button>{quickOpen && <div id="quick-prompts" className="quick-prompts" role="menu" aria-label="快捷指令">{quickPrompts.map(([label, prompt]) => <button key={label} type="button" role="menuitem" aria-label={label} onClick={() => chooseQuickPrompt(prompt)}><strong>{label}</strong><span>{prompt}</span></button>)}</div>}</div><span className="mode-select">{runtimeConfiguring ? "应用设置中" : runtimeCancelPending ? "完成取消中" : monitorBusy ? "盯盘检查中" : liveDataLoading ? "行情更新中" : cancelling ? "取消中" : running ? "分析中" : "深度分析"}</span><button className={`send-button${runtimeBusy ? " cancel-button" : ""}`} disabled={runtimeConfiguring || runtimeCancelPending || monitorBusy || liveDataLoading || cancelling || (!running && !draft.trim())} onClick={running ? () => { void cancelMessage(); } : submit} aria-label={runtimeConfiguring ? "正在应用设置" : runtimeCancelPending ? "正在完成取消" : monitorBusy ? "正在检查盯盘" : liveDataLoading ? "等待行情更新" : cancelling ? "正在取消" : running ? "停止分析" : "发送"}>{runtimeBusy ? <Square size={13} weight="fill" /> : <ArrowUp size={19} weight="bold" />}</button></div>
      </div>
      <div className="disclaimer">内容由 AI 生成，仅供参考，不构成投资建议。</div>
    </aside>
  );
}
