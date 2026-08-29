import { useEffect, useRef, useState } from "react";
import { ArrowClockwise, CaretUp, Code, Trash, X } from "@phosphor-icons/react";
import { clearDeveloperLogs, isLocalWebRuntime, loadDeveloperOverview, updateDeveloperVariables } from "../lib/localHost.js";

function formatTime(value) {
  try { return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }); } catch { return "--:--:--"; }
}

export function DeveloperPanel() {
  const local = isLocalWebRuntime();
  const [open, setOpen] = useState(false);
  const [overview, setOverview] = useState(null);
  const [error, setError] = useState("");
  const [dragOffset, setDragOffset] = useState(0);
  const dragStart = useRef(null);

  const refresh = async () => {
    try { setOverview(await loadDeveloperOverview({ timeoutMs: 4_000 })); setError(""); }
    catch (cause) { setError(cause?.message || "本地 Host 未连接"); }
  };
  useEffect(() => { if (local && open) { void refresh(); const timer = window.setInterval(() => void refresh(), 1_500); return () => window.clearInterval(timer); } return undefined; }, [local, open]);
  if (!local) return null;

  const patchVariable = async (name, value) => {
    try { const result = await updateDeveloperVariables({ [name]: value }); setOverview((current) => current ? { ...current, variables: result.variables } : current); setError(""); }
    catch (cause) { setError(cause?.message || "变量更新失败"); }
  };
  const onPointerDown = (event) => { dragStart.current = event.clientY; event.currentTarget.setPointerCapture?.(event.pointerId); };
  const onPointerMove = (event) => { if (dragStart.current != null) setDragOffset(Math.max(0, Math.min(160, event.clientY - dragStart.current))); };
  const onPointerUp = (event) => { if (dragStart.current != null) { const delta = event.clientY - dragStart.current; if (delta < -48) setOpen(true); if (delta > 48) setOpen(false); } dragStart.current = null; setDragOffset(0); };
  const variables = overview?.variables || {};
  const logs = overview?.logs || [];
  return <section className={`developer-panel ${open ? "open" : ""}`} style={{ "--dev-drag-offset": `${dragOffset}px` }} aria-label="本地开发者面板">
    <button className="developer-handle" type="button" onClick={() => setOpen((value) => !value)} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} aria-expanded={open} aria-controls="developer-panel-content">
      <span><Code size={16} />开发者面板</span><CaretUp size={15} className={open ? "rotated" : ""} />
    </button>
    {open && <div className="developer-panel-content" id="developer-panel-content">
      <header><div><strong>本地调试</strong><small>仅 localhost 可见 · 密钥和原始提示词不会记录</small></div><div className="developer-actions"><button type="button" onClick={() => void refresh()} aria-label="刷新日志"><ArrowClockwise size={15} /></button><button type="button" onClick={async () => { try { await clearDeveloperLogs(); await refresh(); } catch (cause) { setError(cause?.message || "清空失败"); } }} aria-label="清空日志"><Trash size={15} /></button><button type="button" onClick={() => setOpen(false)} aria-label="关闭开发者面板"><X size={16} /></button></div></header>
      {error && <div className="developer-error" role="status">{error}</div>}
      <div className="developer-grid">
        <div className="developer-card"><h4>运行状态</h4><dl><div><dt>Host</dt><dd>{overview?.state?.activeRequest ? "执行中" : "空闲"}</dd></div><div><dt>模型</dt><dd>{overview?.state?.settings?.modelId || "未配置"}</dd></div><div><dt>API Key</dt><dd>{overview?.state?.keyPrefix || "未配置"}</dd></div><div><dt>工具缓存</dt><dd>{overview?.state?.toolCache?.length || 0} 类</dd></div></dl></div>
        <div className="developer-card"><h4>可调变量</h4><label className="developer-toggle"><input type="checkbox" checked={variables.toolCacheEnabled !== false} onChange={(event) => void patchVariable("toolCacheEnabled", event.target.checked)} />启用工具固化缓存</label><label>请求超时<input type="number" min="5000" max="180000" step="1000" value={variables.requestTimeoutMs || 120000} onChange={(event) => void patchVariable("requestTimeoutMs", Number(event.target.value))} /></label><label>并发上限<input type="number" min="1" max="4" value={variables.maxConcurrentDataRequests || 2} onChange={(event) => void patchVariable("maxConcurrentDataRequests", Number(event.target.value))} /></label><label>日志级别<select value={variables.logLevel || "info"} onChange={(event) => void patchVariable("logLevel", event.target.value)}><option value="silent">静默</option><option value="error">错误</option><option value="info">信息</option><option value="debug">调试</option></select></label></div>
      </div>
      <div className="developer-log-card"><h4>调用日志 <span>{logs.length}</span></h4><div className="developer-log-list">{logs.length ? logs.slice().reverse().map((entry) => <div className={`developer-log ${entry.status >= 400 ? "bad" : ""}`} key={entry.id}><time>{formatTime(entry.at)}</time><code>{entry.method ? `${entry.method} ${entry.path}` : `${entry.operation || "event"}${entry.kind ? ` · ${entry.kind}` : ""}`}</code><span>{entry.cacheHit ? "缓存命中" : entry.status ? `${entry.status} · ${entry.durationMs ?? 0}ms` : "完成"}</span></div>) : <p>暂无调用记录。执行一次行情或对话后会显示在这里。</p>}</div></div>
    </div>}
  </section>;
}
