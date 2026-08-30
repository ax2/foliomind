import { ArrowsClockwise, CheckCircle, Database, Info, ShieldCheck, X, WarningCircle } from "@phosphor-icons/react";
import { useEffect, useRef } from "react";
import { formatQuoteField, formatQuoteFreshness, formatRefreshTime, quoteFreshness } from "../lib/quoteFormatting.js";

const EVIDENCE_FIELDS = [
  ["price", "最新价"],
  ["change", "涨跌幅"],
  ["previousClose", "昨收"],
  ["open", "今开"],
  ["high", "最高"],
  ["low", "最低"],
  ["volume", "成交量"],
  ["turnover", "成交额"],
  ["pe", "市盈率"],
  ["pb", "市净率"],
];

function evidenceState(quote) {
  if (!quote || !Number.isFinite(Number(quote.price))) return { id: "empty", label: "暂无可核验行情", Icon: WarningCircle };
  const freshness = quoteFreshness(quote.asOf);
  if (freshness.state === "stale") return { id: "stale", label: "行情可能已延迟", Icon: WarningCircle };
  if (freshness.state === "unknown") return { id: "unknown", label: "数据时间未知", Icon: Info };
  return { id: "fresh", label: "行情可核验", Icon: CheckCircle };
}

export function EvidenceDrawer({ open, onClose, quote, symbol, name, provider, channel, lastRefreshAt, loading = false, onRefresh, refreshLabel = "重新获取当前行情" }) {
  const closeButton = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    closeButton.current?.focus();
    const onKeyDown = (event) => { if (event.key === "Escape") onClose?.(); };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);
  if (!open) return null;

  const state = evidenceState(quote);
  const StateIcon = state.Icon;
  const available = EVIDENCE_FIELDS.filter(([key]) => quote?.[key] != null && quote?.[key] !== "");
  const missing = EVIDENCE_FIELDS.filter(([key]) => quote?.[key] == null || quote?.[key] === "");
  return <div className="evidence-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose?.(); }}>
    <aside className="evidence-drawer" role="dialog" aria-modal="true" aria-labelledby="evidence-drawer-title">
      <header className="evidence-drawer-heading">
        <div><span className="evidence-icon"><ShieldCheck size={20} /></span><div><h2 id="evidence-drawer-title">行情证据</h2><p>{name || symbol} · {symbol}</p></div></div>
        <button ref={closeButton} type="button" className="icon-button" aria-label="关闭行情证据" onClick={onClose}><X size={18} /></button>
      </header>
      <section className={`evidence-status evidence-status-${state.id}`}><StateIcon size={19} weight={state.id === "fresh" ? "fill" : "regular"} /><div><strong>{state.label}</strong><small>{quote?.asOf ? formatQuoteFreshness(quote.asOf) : "返回真实行情后才会显示时间"}</small></div></section>
      <dl className="evidence-meta"><div><dt><Database size={14} />数据渠道</dt><dd>{channel || "未配置"}</dd></div><div><dt>Provider</dt><dd>{provider || "数据服务"}</dd></div><div><dt>返回来源</dt><dd>{quote?.source || "尚未返回"}</dd></div><div><dt>能力</dt><dd>MKT.L1.RT</dd></div><div><dt>最近尝试</dt><dd>{lastRefreshAt ? formatRefreshTime(lastRefreshAt) : "尚未请求"}</dd></div></dl>
      <section className="evidence-coverage"><div className="evidence-section-title"><h3>字段覆盖</h3><span>{available.length}/{EVIDENCE_FIELDS.length} 项</span></div><div className="evidence-field-list">{EVIDENCE_FIELDS.map(([key, label]) => <div key={key}><span>{label}</span><strong>{quote?.[key] != null && quote?.[key] !== "" ? formatQuoteField(key, quote[key]) : "—"}</strong></div>)}</div>{missing.length > 0 && <p className="evidence-missing">缺失字段保持为空，不参与推断：{missing.map(([, label]) => label).join("、")}</p>}</section>
      <p className="evidence-disclaimer"><Info size={14} />仅展示已返回的真实数据，不保存原始响应，不构成投资建议。</p>
      <button type="button" className="primary-action evidence-refresh" disabled={loading || !onRefresh} onClick={() => { void onRefresh?.(); }}><ArrowsClockwise size={16} />{loading ? "获取中…" : refreshLabel}</button>
    </aside>
  </div>;
}
