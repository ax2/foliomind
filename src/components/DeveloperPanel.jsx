import { useEffect, useRef, useState } from "react";
import { ArrowClockwise, CaretUp, Code, Trash, X } from "@phosphor-icons/react";
import { clearDeveloperLogs, isLocalWebRuntime, loadDeveloperOverview, testCapability, updateDeveloperVariables } from "../lib/localHost.js";
import { askPi, isDesktopRuntime } from "../lib/piRuntime.js";
import { BUILTIN_CAPABILITIES } from "../lib/builtinCapabilities.js";
import { queryTradingCalendar } from "../lib/integrations.js";

function formatTime(value) {
  try { return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }); } catch { return "--:--:--"; }
}
function formatCost(cost) {
  const amount = Number(cost?.amount);
  return Number.isFinite(amount) ? `${amount.toFixed(amount >= 1 ? 2 : 4)} ${cost?.unit || "credits"}` : "未返回";
}
function debugText(value) {
  if (!value) return "未返回";
  try { return typeof value === "string" ? value : JSON.stringify(value, null, 2); } catch { return String(value); }
}

export function DeveloperPanel() {
  const local = isLocalWebRuntime();
  const desktop = isDesktopRuntime();
  const enabled = local || desktop;
  const [open, setOpen] = useState(false);
  const [overview, setOverview] = useState(null);
  const [desktopLogs, setDesktopLogs] = useState([]);
  const [error, setError] = useState("");
  const [dragOffset, setDragOffset] = useState(0);
  const [capabilityTests, setCapabilityTests] = useState({});
  const [testSymbol, setTestSymbol] = useState("600519");
  const dragStart = useRef(null);

  const refresh = async () => {
    try {
      if (local) {
        setOverview(await loadDeveloperOverview({ timeoutMs: 4_000 }));
      } else if (desktop) {
        const [{ invoke }] = await Promise.all([import("@tauri-apps/api/core")]);
        const [runtime, integration] = await Promise.all([invoke("runtime_status"), invoke("integration_status")]);
        setOverview((current) => ({
          logs: current?.logs || desktopLogs,
          costSummary: current?.costSummary,
          state: {
            activeRequest: runtime?.state === "running",
            runtimeState: runtime?.state || "unknown",
            pid: runtime?.pid || null,
            detail: runtime?.detail || null,
            credentialConfigured: Boolean(integration?.credentialConfigured),
            keyPrefix: integration?.keyPrefix || "",
            settings: integration?.settings || {},
            toolCache: current?.state?.toolCache || [],
            capabilityCatalog: current?.state?.capabilityCatalog || null,
          },
          variables: current?.variables || {},
        }));
      }
      setError("");
    } catch (cause) { setError(cause?.message || (local ? "本地 Host 未连接" : "桌面运行时未连接")); }
  };
  useEffect(() => {
    if (!enabled || !open) return undefined;
    let disposed = false;
    let unlisten;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1_500);
    if (desktop) {
      void import("@tauri-apps/api/event").then(({ listen }) => listen("pi-runtime://event", ({ payload }) => {
        if (disposed) return;
        const frame = payload?.frame;
        const audit = payload?.audit || frame?.audit;
        const detail = audit?.detail || payload?.status?.detail || (typeof frame === "string" ? frame : "");
        const operation = audit?.operation || payload?.kind || frame?.type || "event";
        const status = audit ? (audit.outcome === "success" ? 200 : 500) : ["crash", "transport_error", "protocol_error"].includes(payload?.kind) ? 500 : 200;
        const entry = { id: `${Date.now()}-${Math.random()}`, at: new Date().toISOString(), operation, kind: audit ? "qveris" : "runtime", status, detail, ...(audit || {}) };
        setDesktopLogs((current) => [...current, entry].slice(-200));
        setOverview((current) => current ? { ...current, logs: [...(current.logs || []), entry].slice(-200), state: { ...current.state, activeRequest: payload?.kind === "started" ? true : payload?.kind === "stopped" || payload?.kind === "crash" ? false : current.state?.activeRequest } } : current);
      })).then((listener) => { if (disposed) listener(); else unlisten = listener; }).catch(() => {});
    }
    return () => { disposed = true; window.clearInterval(timer); unlisten?.(); };
  }, [enabled, local, desktop, open]);
  if (!enabled) return null;

  const patchVariable = async (name, value) => {
    try {
      if (!local) return;
      const result = await updateDeveloperVariables({ [name]: value }); setOverview((current) => current ? { ...current, variables: result.variables } : current); setError("");
    }
    catch (cause) { setError(cause?.message || "变量更新失败"); }
  };
  const onPointerDown = (event) => { dragStart.current = event.clientY; event.currentTarget.setPointerCapture?.(event.pointerId); };
  const onPointerMove = (event) => { if (dragStart.current != null) setDragOffset(Math.max(0, Math.min(160, event.clientY - dragStart.current))); };
  const onPointerUp = (event) => { if (dragStart.current != null) { const delta = event.clientY - dragStart.current; if (delta < -48) setOpen(true); if (delta > 48) setOpen(false); } dragStart.current = null; setDragOffset(0); };
  const variables = overview?.variables || {};
  const logs = overview?.logs || [];
  const capabilities = overview?.state?.capabilityCatalog?.tools?.length ? overview.state.capabilityCatalog.tools : BUILTIN_CAPABILITIES;
  const runCapabilityTest = async (capability) => {
    const symbol = testSymbol.trim().toUpperCase();
    if (!symbol && capability.kind !== "trading_calendar") {
      setCapabilityTests((current) => ({ ...current, [capability.kind]: { state: "error", error: "请先输入测试标的" } }));
      return;
    }
    setCapabilityTests((current) => ({ ...current, [capability.kind]: { state: "loading" } }));
    try {
      const calendarDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
      const result = capability.kind === "trading_calendar"
        ? desktop ? await queryTradingCalendar(calendarDate) : await testCapability({ kind: capability.kind, date: calendarDate, marketcode: "212001" })
        : local ? await testCapability({ kind: capability.kind, symbol }) : await askPi(`请仅调用内置工具 ${capability.toolId} 测试 ${symbol}，使用该工具声明的必要参数；返回调用是否成功、数据来源和截至时间，不要推测或补造数据。`);
      if (desktop && capability.kind !== "trading_calendar" && !result?.audits?.some((audit) => audit?.outcome === "success" && (audit?.toolId === capability.toolId || audit?.tool_id === capability.toolId))) {
        throw new Error("未观察到该 CAP 的成功调用记录，请在调用日志中查看原因");
      }
      setCapabilityTests((current) => ({ ...current, [capability.kind]: { state: "success", result } }));
    } catch (cause) {
      setCapabilityTests((current) => ({ ...current, [capability.kind]: { state: "error", error: cause?.message || "测试失败" } }));
    }
  };
  return <section className={`developer-panel ${open ? "open" : ""}`} style={{ "--dev-drag-offset": `${dragOffset}px` }} aria-label="本地开发者面板">
    <button className="developer-handle" type="button" onClick={() => setOpen((value) => !value)} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} aria-expanded={open} aria-controls="developer-panel-content">
      <span><Code size={16} />开发者面板</span><CaretUp size={15} className={open ? "rotated" : ""} />
    </button>
    {open && <div className="developer-panel-content" id="developer-panel-content">
      <header><div><strong>{desktop ? "桌面调试" : "本地调试"}</strong><small>仅本机可见 · 密钥和原始提示词不会记录</small></div><div className="developer-actions"><button type="button" onClick={() => void refresh()} aria-label="刷新日志"><ArrowClockwise size={15} /></button><button type="button" onClick={async () => { try { if (local) await clearDeveloperLogs(); setDesktopLogs([]); setOverview((current) => current ? { ...current, logs: [] } : current); await refresh(); } catch (cause) { setError(cause?.message || "清空失败"); } }} aria-label="清空日志"><Trash size={15} /></button><button type="button" onClick={() => setOpen(false)} aria-label="关闭开发者面板"><X size={16} /></button></div></header>
      {error && <div className="developer-error" role="status">{error}</div>}
      <div className="developer-grid">
        <div className="developer-card"><h4>运行状态</h4><dl><div><dt>运行时</dt><dd>{overview?.state?.runtimeState || (overview?.state?.activeRequest ? "执行中" : "空闲")}</dd></div><div><dt>模型</dt><dd>{overview?.state?.settings?.modelId || "未配置"}</dd></div><div><dt>API Key</dt><dd>{overview?.state?.keyPrefix || "未配置"}</dd></div><div><dt>能力目录</dt><dd>{overview?.state?.capabilityCatalog?.provider || "qveris_finance"} · {overview?.state?.capabilityCatalog?.tools?.length || 0} 项（共 {overview?.state?.capabilityCatalog?.providerSummary?.capabilityCount || 141} 个能力）</dd></div><div><dt>固化工具</dt><dd>{overview?.state?.toolCache?.length || 0} 类</dd></div></dl></div>
        <div className="developer-card"><h4>调用成本</h4><dl><div><dt>CAP 调用</dt><dd>{overview?.costSummary?.qverisCalls || 0} 次 · {overview?.costSummary?.qverisCostKnown ? `${Number(overview.costSummary.qverisCost).toFixed(4)} ${overview.costSummary.units?.[0] || "credits"}` : "费用未返回"}</dd></div><div><dt>模型调用</dt><dd>{overview?.costSummary?.modelCalls || 0} 次 · {overview?.costSummary?.modelCostKnown ? `${Number(overview.costSummary.modelCost).toFixed(4)} ${overview.costSummary.units?.[0] || "credits"}` : "费用未返回"}</dd></div><div><dt>统计范围</dt><dd>当前面板日志 · 清理后重置</dd></div></dl></div>
        <div className="developer-card"><h4>可调变量</h4>{desktop ? <p>桌面运行时变量由应用配置管理；本面板实时展示 Pi 与 QVeris 事件。</p> : <><label className="developer-toggle"><input type="checkbox" checked={variables.toolCacheEnabled !== false} onChange={(event) => void patchVariable("toolCacheEnabled", event.target.checked)} />启用工具固化缓存</label><label>请求超时<input type="number" min="5000" max="180000" step="1000" value={variables.requestTimeoutMs || 120000} onChange={(event) => void patchVariable("requestTimeoutMs", Number(event.target.value))} /></label><label>并发上限<input type="number" min="1" max="4" value={variables.maxConcurrentDataRequests || 2} onChange={(event) => void patchVariable("maxConcurrentDataRequests", Number(event.target.value))} /></label><label>日志级别<select value={variables.logLevel || "info"} onChange={(event) => void patchVariable("logLevel", event.target.value)}><option value="silent">静默</option><option value="error">错误</option><option value="info">信息</option><option value="debug">调试</option></select></label></>}</div>
      </div>
      <div className="developer-capability-card"><h4>当前支持的金融能力（CAP） <span>{capabilities.length} 项</span><small>仅列出已验证且 schema 稳定的能力，可直接作为 Skill Tool 使用</small></h4><div className="developer-capability-toolbar"><label>测试标的<input value={testSymbol} maxLength={32} onChange={(event) => setTestSymbol(event.target.value)} placeholder="例如 600519" /></label><span>Provider 已发现 {overview?.state?.capabilityCatalog?.providerSummary?.capabilityCount || 141} 个能力；未验证能力暂不开放调用。</span></div><div className="developer-capability-list">{capabilities.map((capability) => { const result = capabilityTests[capability.kind]; return <details className="developer-capability" key={capability.kind}><summary><div><strong>{capability.capability}</strong><small>{capability.toolId} · {capability.description}</small></div><button type="button" className="secondary-button" disabled={result?.state === "loading"} onClick={(event) => { event.preventDefault(); void runCapabilityTest(capability); }}>{result?.state === "loading" ? "测试中…" : "调用测试"}</button></summary><div className="developer-capability-detail"><div><b>能力说明</b><span>{capability.description}</span></div><div><b>Tool ID</b><code>{capability.toolId}</code></div><div><b>参数 Schema</b><code>{JSON.stringify(capability.parameters || {})}</code></div><div><b>返回字段</b><span>{(capability.returns || []).join("、") || "未声明"}</span></div>{capability.coverage ? <div><b>覆盖边界</b><span>{capability.coverage}</span></div> : null}{result?.state === "success" ? <p className="developer-capability-success">测试成功：已收到真实 CAP 响应，详细调用已写入日志。</p> : null}{result?.state === "error" ? <p className="developer-capability-error">{result.error}</p> : null}</div></details>; })}</div></div>
      <div className="developer-log-card"><h4>调用日志 <span>{logs.length}</span><small>点击记录查看接口、参数、返回摘要和失败原因</small></h4><div className="developer-log-list">{logs.length ? logs.slice().reverse().map((entry) => <details className={`developer-log ${entry.status >= 400 ? "bad" : ""}`} key={entry.id}><summary><time>{formatTime(entry.at)}</time><code>{entry.operation || entry.kind || "request"}</code><span>{entry.cacheHit ? "缓存命中" : entry.status ? `${entry.status} · ${entry.durationMs ?? 0}ms` : "完成"}{entry.cost ? ` · ${formatCost(entry.cost)}` : ""}</span></summary><div className="developer-log-detail"><div><b>接口</b><code>{entry.method ? `${entry.method} ${entry.path}` : entry.operation || "event"}</code></div>{entry.params ? <div><b>参数</b><pre>{debugText(entry.params)}</pre></div> : null}{entry.response ? <div><b>返回摘要</b><pre>{debugText(entry.response)}</pre></div> : null}{entry.reason || entry.detail ? <div className="developer-log-reason"><b>失败原因</b><span>{entry.reason || entry.detail}</span></div> : null}</div></details>) : <p>暂无调用记录。执行一次行情或对话后会显示在这里。</p>}</div></div>
    </div>}
  </section>;
}
