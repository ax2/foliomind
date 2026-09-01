import { useEffect, useRef, useState } from "react";
import { ArrowClockwise, CaretUp, Code, Trash, X } from "@phosphor-icons/react";
import { clearDeveloperLogs, discoverCapabilities, isLocalWebRuntime, loadDeveloperOverview, testCapability, updateDeveloperVariables } from "../lib/localHost.js";
import { askPi, isDesktopRuntime } from "../lib/piRuntime.js";
import { BUILTIN_CAPABILITIES } from "../lib/builtinCapabilities.js";
import { queryCapabilityData, queryTradingCalendar } from "../lib/integrations.js";

function formatTime(value) {
  try { return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }); } catch { return "--:--:--"; }
}
export function normalizeCost(value, unitHint = "credits") {
  if (value == null || value === "") return null;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const amount = Number(value.amount ?? value.value ?? value.cost ?? value.credits ?? value.chargedCredits);
    if (!Number.isFinite(amount) || amount < 0) return null;
    return { amount, unit: String((value.unit ?? value.currency ?? value.costUnit ?? value.cost_unit ?? unitHint) || "credits") };
  }
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? { amount, unit: String(unitHint || "credits") } : null;
}
function formatCost(cost) {
  const normalized = normalizeCost(cost);
  return normalized ? `${normalized.amount.toFixed(normalized.amount >= 1 ? 2 : 4)} ${normalized.unit}` : "未返回";
}
function debugText(value) {
  if (!value) return "未返回";
  try { return typeof value === "string" ? value : JSON.stringify(value, null, 2); } catch { return String(value); }
}

function toJsonSchemaType(value) {
  const normalized = String(value || "string").replace(/\?$/, "").toLowerCase();
  if (["number", "integer", "boolean", "object", "array"].includes(normalized)) return normalized;
  return "string";
}

export function capabilityToolSchema(capability) {
  const properties = {};
  const required = [];
  for (const [name, type] of Object.entries(capability?.parameters || {})) {
    const optional = String(type || "").endsWith("?");
    properties[name] = { type: toJsonSchemaType(type) };
    if (!optional) required.push(name);
  }
  return {
    type: "function",
    function: {
      name: `foliomind_cap_${String(capability?.kind || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48)}`,
      description: capability?.description || "FolioMind 金融数据能力",
      parameters: { type: "object", properties, required, additionalProperties: false },
    },
    "x-foliomind": {
      provider: capability?.provider || "qveris_finance",
      tool_id: capability?.toolId || "",
      capability: capability?.capability || "",
    },
  };
}

export function desktopCostSummary(logs) {
  const entries = Array.isArray(logs) ? logs : [];
  const summarize = (kind) => {
    const selected = entries.filter((entry) => entry.kind === kind || entry.type === kind);
    const costs = selected.map((entry) => normalizeCost(entry.cost ?? entry.response?.cost, entry.costUnit ?? entry.cost_unit)).filter(Boolean);
    const units = [...new Set(costs.map((cost) => cost.unit))];
    return { calls: selected.length, cost: costs.reduce((total, cost) => total + cost.amount, 0), costKnown: costs.length, units };
  };
  const cap = summarize("qveris");
  const model = summarize("model");
  return { qverisCalls: cap.calls, qverisCost: cap.cost, qverisCostKnown: cap.costKnown, qverisUnits: cap.units, modelCalls: model.calls, modelCost: model.cost, modelCostKnown: model.costKnown, modelUnits: model.units, units: [...new Set(entries.map((entry) => entry.cost?.unit).filter(Boolean))] };
}

function costLabel(summary, calls, known, units) {
  if (!known) return "费用未返回";
  const unitLabel = units?.length === 1 ? units[0] : units?.length ? "多单位" : "credits";
  return `${Number(summary || 0).toFixed(4)} ${unitLabel}${known < calls ? ` · ${known}/${calls} 笔已返回` : ""}`;
}

function discoveredAsCapability(item) {
  if (!item) return null;
  return {
    ...item,
    kind: item.kind || `discovered:${item.toolId}`,
    returns: Array.isArray(item.returns) ? item.returns : [],
  };
}

function capabilityMatches(capability, query) {
  if (!query) return true;
  return [capability?.capability, capability?.toolId, capability?.description, capability?.kind, capability?.provider]
    .some((value) => String(value || "").toLocaleLowerCase().includes(query));
}

function sampleParametersFor(capability, symbol) {
  const sample = capability?.sampleParameters && typeof capability.sampleParameters === "object" ? structuredClone(capability.sampleParameters) : {};
  for (const name of Object.keys(capability?.parameters || {})) {
    if (sample[name] != null && sample[name] !== "") continue;
    if (/^(symbol|ticker|code|stock_code|stockCode|securities_code)$/i.test(name)) sample[name] = symbol;
    else if (/date/i.test(name)) sample[name] = new Date().toISOString().slice(0, 10);
  }
  return sample;
}

function responsePayload(result) {
  return result?.data ?? result?.result?.data ?? result?.result ?? result;
}

function hasRenderablePayload(payload) {
  if (Array.isArray(payload)) return payload.length > 0;
  if (!payload || typeof payload !== "object") return Boolean(payload);
  const collectionKeys = ["quotes", "series", "events", "capitalFlow", "capital_flow", "news", "tradingDates", "trading_dates"];
  const collection = collectionKeys.find((key) => Object.hasOwn(payload, key));
  if (collection) return hasRenderablePayload(payload[collection]);
  return Object.keys(payload).length > 0;
}

/**
 * A successful HTTP response is not enough to call a capability usable. Keep
 * the distinction between a rejected response and a valid-but-empty response
 * visible in the workbench so developers do not mistake an empty CAP for
 * working market data.
 */
export function capabilityTestOutcome(capability, result) {
  const nestedStatus = Number(result?.result?.status_code ?? result?.result?.statusCode ?? result?.status_code ?? result?.statusCode ?? 200);
  if (result?.success === false || result?.result?.success === false || nestedStatus >= 400) return { state: "error", error: "上游返回失败结果，请展开调用日志查看原因" };
  const payload = responsePayload(result);
  if (capability?.kind === "quote") {
    const quote = Array.isArray(payload?.quotes) ? payload.quotes.find((item) => Number.isFinite(Number(item?.price)) && Number(item.price) > 0) : payload;
    if (quote && Number.isFinite(Number(quote.price)) && Number(quote.price) > 0) return { state: "success" };
    return { state: "empty", message: "调用成功，但没有返回可识别的真实行情" };
  }
  if (capability?.kind === "trading_calendar") {
    if (Array.isArray(payload?.tradingDates)) return payload.tradingDates.length ? { state: "success" } : { state: "empty", message: "调用成功，但当前日期范围没有返回交易日" };
  }
  return hasRenderablePayload(payload) ? { state: "success" } : { state: "empty", message: "调用成功，但上游没有返回可展示数据" };
}

function CapabilityCard({ capability, result, onTest, onCopy }) {
  return <details className="developer-capability" key={capability.kind}>
    <summary><div><strong>{capability.capability}</strong><small>{capability.toolId} · {capability.description}</small></div></summary>
    <div className="developer-capability-detail">
      <div><b>能力说明</b><span>{capability.description}</span></div>
      <div><b>Provider</b><span>{capability.provider || "qveris_finance"}</span></div>
      <div><b>Tool ID</b><code>{capability.toolId}</code></div>
      <div><b>参数 Schema</b><code>{JSON.stringify(capability.parameters || {})}</code></div>
      {capability.parameterDetails?.length ? <div><b>参数说明</b><span>{capability.parameterDetails.map((param) => `${param.name}${param.required ? "（必填）" : "（可选）"}${param.description ? `：${param.description}` : ""}`).join("；")}</span></div> : null}
      <div><b>返回字段</b><span>{(capability.returns || []).join("、") || "由上游返回"}</span></div>
      {capability.coverage ? <div><b>覆盖边界</b><span>{capability.coverage}</span></div> : null}
      {capability.expectedCost ? <div><b>费用提示</b><span>{capability.expectedCost}（调用测试可能扣费）</span></div> : null}
      {capability.stats?.success_rate != null ? <div><b>近期成功率</b><span>{`${(Number(capability.stats.success_rate) * 100).toFixed(1)}%`}{capability.stats.sample_size ? ` · ${capability.stats.sample_size} 次样本` : ""}</span></div> : null}
      <div className="developer-capability-action"><button type="button" className="secondary-button" disabled={result?.state === "loading"} onClick={() => void onTest(capability)}>{result?.state === "loading" ? "测试中…" : "调用测试"}</button><button type="button" className="secondary-button" onClick={() => void onCopy(capability)}>{result?.copied ? "已复制" : "复制 Tool Schema"}</button>{result?.state === "success" ? <span className="developer-capability-success" role="status">测试成功：已收到可识别的真实响应，详细调用已写入日志。</span> : null}{result?.state === "empty" ? <span className="developer-capability-empty" role="status">{result.message}</span> : null}{result?.state === "error" ? <span className="developer-capability-error" role="status">{result.error}</span> : null}</div>
    </div>
  </details>;
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
  const [copiedCapability, setCopiedCapability] = useState("");
  const [testSymbol, setTestSymbol] = useState("600519");
  const [capabilityFilter, setCapabilityFilter] = useState("");
  const [directoryQuery, setDirectoryQuery] = useState("provider:qveris_finance");
  const [directory, setDirectory] = useState(null);
  const [directoryState, setDirectoryState] = useState("idle");
  const [directoryError, setDirectoryError] = useState("");
  const dragStart = useRef(null);

  const refresh = async () => {
    try {
      if (local) {
        const next = await loadDeveloperOverview({ timeoutMs: 4_000 });
        setOverview(next);
        if (next?.state?.capabilityDirectory) setDirectory(next.state.capabilityDirectory);
      } else if (desktop) {
        const [{ invoke }] = await Promise.all([import("@tauri-apps/api/core")]);
        const [runtime, integration] = await Promise.all([invoke("runtime_status"), invoke("integration_status")]);
        setOverview((current) => ({
          logs: current?.logs || desktopLogs,
          costSummary: current?.costSummary || desktopCostSummary(current?.logs || desktopLogs),
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
            capabilityDirectory: current?.state?.capabilityDirectory || null,
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
      void import("@tauri-apps/api/event").then(({ listen }) => listen("foliomind://background-scheduler-log", ({ payload }) => {
        if (disposed || !payload) return;
        const entry = { ...payload, kind: "qveris", cost: payload.cost || payload.response?.cost, id: payload.id || `${Date.now()}-${Math.random()}` };
        setDesktopLogs((current) => [...current, entry].slice(-200));
        setOverview((current) => {
          if (!current) return current;
          const logs = [...(current.logs || []), entry].slice(-200);
          return { ...current, logs, costSummary: desktopCostSummary(logs) };
        });
      })).then((listener) => {
        if (disposed) listener();
        else {
          const previous = unlisten;
          unlisten = () => { previous?.(); listener(); };
        }
      }).catch(() => {});
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
  const discoveredCapabilities = (directory?.tools || []).map((item) => discoveredAsCapability({ ...item, searchId: item.searchId || directory.searchId })).filter((capability) => capability && !capabilities.some((item) => item.toolId === capability.toolId));
  const normalizedCapabilityFilter = capabilityFilter.trim().toLocaleLowerCase();
  const filteredCapabilities = capabilities.filter((capability) => capabilityMatches(capability, normalizedCapabilityFilter));
  const filteredDiscoveredCapabilities = discoveredCapabilities.filter((capability) => capabilityMatches(capability, normalizedCapabilityFilter));
  const discoverDirectory = async () => {
    if (!local) { setDirectoryError("完整能力目录仅支持本地 Web Host"); return; }
    setDirectoryState("loading"); setDirectoryError("");
    try {
      const result = await discoverCapabilities({ query: directoryQuery.trim() || "provider:qveris_finance", limit: 100 });
      if (result?.available === false) throw new Error(result.errorMessage || "能力目录暂时无法加载");
      setDirectory(result); setDirectoryState("success");
      setOverview((current) => current ? { ...current, state: { ...current.state, capabilityDirectory: result } } : current);
    } catch (cause) { setDirectoryState("error"); setDirectoryError(cause?.message || "能力目录暂时无法加载"); }
  };
  const runCapabilityTest = async (capability) => {
    const symbol = testSymbol.trim().toUpperCase();
    if (!symbol && capability.kind !== "trading_calendar" && !capability.kind?.startsWith("discovered:")) {
      setCapabilityTests((current) => ({ ...current, [capability.kind]: { state: "error", error: "请先输入测试标的" } }));
      return;
    }
    setCapabilityTests((current) => ({ ...current, [capability.kind]: { state: "loading" } }));
    try {
      const calendarDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
      const result = capability.kind?.startsWith("discovered:")
        ? await testCapability({ toolId: capability.toolId, searchId: capability.searchId, parameters: sampleParametersFor(capability, symbol) })
        : capability.kind === "trading_calendar"
        ? desktop ? await queryTradingCalendar(calendarDate) : await testCapability({ kind: capability.kind, date: calendarDate, marketcode: "212001" })
        : desktop ? await queryCapabilityData({ kind: capability.kind, symbol }) : local ? await testCapability({ kind: capability.kind, symbol }) : await askPi(`请仅调用内置工具 ${capability.toolId} 测试 ${symbol}，使用该工具声明的必要参数；返回调用是否成功、数据来源和截至时间，不要推测或补造数据。`);
      const outcome = capabilityTestOutcome(capability, result);
      if (outcome.state === "error") throw new Error(result?.result?.error_message || outcome.error);
      if (desktop && capability.kind !== "trading_calendar" && !result?.audits?.some((audit) => audit?.outcome === "success" && (audit?.toolId === capability.toolId || audit?.tool_id === capability.toolId))) {
        throw new Error("未观察到该 CAP 的成功调用记录，请在调用日志中查看原因");
      }
      setCapabilityTests((current) => ({ ...current, [capability.kind]: { ...outcome, result } }));
    } catch (cause) {
      setCapabilityTests((current) => ({ ...current, [capability.kind]: { state: "error", error: cause?.message || "测试失败" } }));
    }
  };
  const copyCapabilitySchema = async (capability) => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("当前环境不支持剪贴板");
      await navigator.clipboard.writeText(JSON.stringify(capabilityToolSchema(capability), null, 2));
      setCopiedCapability(capability.kind);
      window.setTimeout(() => setCopiedCapability((current) => current === capability.kind ? "" : current), 2_000);
      setError("");
    } catch (cause) { setError(cause?.message || "复制 Tool Schema 失败"); }
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
        <div className="developer-card"><h4>调用成本</h4><dl><div><dt>CAP 调用</dt><dd>{overview?.costSummary?.qverisCalls || 0} 次 · {costLabel(overview?.costSummary?.qverisCost, overview?.costSummary?.qverisCalls || 0, overview?.costSummary?.qverisCostKnown || 0, overview?.costSummary?.qverisUnits)}</dd></div><div><dt>模型调用</dt><dd>{overview?.costSummary?.modelCalls || 0} 次 · {costLabel(overview?.costSummary?.modelCost, overview?.costSummary?.modelCalls || 0, overview?.costSummary?.modelCostKnown || 0, overview?.costSummary?.modelUnits)}</dd></div><div><dt>统计范围</dt><dd>当前面板日志 · 清理后重置</dd></div></dl></div>
        <div className="developer-card"><h4>可调变量</h4>{desktop ? <p>桌面运行时变量由应用配置管理；本面板实时展示 Pi 与 QVeris 事件。</p> : <><label className="developer-toggle"><input type="checkbox" checked={variables.toolCacheEnabled !== false} onChange={(event) => void patchVariable("toolCacheEnabled", event.target.checked)} />启用工具固化缓存</label><label>请求超时<input type="number" min="5000" max="180000" step="1000" value={variables.requestTimeoutMs || 120000} onChange={(event) => void patchVariable("requestTimeoutMs", Number(event.target.value))} /></label><label>并发上限<input type="number" min="1" max="4" value={variables.maxConcurrentDataRequests || 2} onChange={(event) => void patchVariable("maxConcurrentDataRequests", Number(event.target.value))} /></label><label>日志级别<select value={variables.logLevel || "info"} onChange={(event) => void patchVariable("logLevel", event.target.value)}><option value="silent">静默</option><option value="error">错误</option><option value="info">信息</option><option value="debug">调试</option></select></label></>}</div>
      </div>
      <div className="developer-capability-card"><h4>当前支持的金融能力（CAP） <span>{capabilities.length} 项已固化</span><small>已固化能力可直接作为 Skill Tool 使用；完整目录从 QVeris 免费 Search 动态读取</small></h4><div className="developer-capability-toolbar"><label>测试标的<input value={testSymbol} maxLength={32} onChange={(event) => setTestSymbol(event.target.value)} placeholder="例如 600519" /></label><label>筛选能力<input value={capabilityFilter} maxLength={80} onChange={(event) => setCapabilityFilter(event.target.value)} placeholder="能力 ID / Tool ID" aria-label="筛选能力" /></label><span>显示 {filteredCapabilities.length}/{capabilities.length} 项 · Provider 已发现 {overview?.state?.capabilityCatalog?.providerSummary?.capabilityCount || 141} 个能力；未验证能力不会进入行情自动链路。</span><button type="button" className="secondary-button" onClick={() => void refresh()} aria-label="刷新能力目录">刷新目录</button></div>{filteredCapabilities.length ? <div className="developer-capability-list">{filteredCapabilities.map((capability) => <CapabilityCard capability={capability} result={{ ...(capabilityTests[capability.kind] || {}), copied: copiedCapability === capability.kind }} onTest={runCapabilityTest} onCopy={copyCapabilitySchema} key={capability.kind} />)}</div> : <p className="developer-directory-empty" role="status">没有匹配的能力，请尝试输入 capability ID、Tool ID 或用途关键词。</p>}</div>
      <div className="developer-capability-card developer-directory-card"><h4>完整能力目录 <span>{directory ? `${filteredDiscoveredCapabilities.length}/${directory.total || directory.tools.length} 项` : "未加载"}</span><small>目录查询只读且不扣费；调用测试会按 QVeris 规则计费</small></h4><div className="developer-capability-toolbar"><label>目录查询<input value={directoryQuery} maxLength={160} onChange={(event) => setDirectoryQuery(event.target.value)} aria-label="目录查询" /></label><button type="button" className="secondary-button" disabled={directoryState === "loading"} onClick={() => void discoverDirectory()}>{directoryState === "loading" ? "加载中…" : "加载完整目录"}</button></div>{directoryError ? <p className="developer-capability-error" role="status">{directoryError}</p> : null}{directory ? <p className="developer-directory-meta" role="status">查询：{directory.query} · Search ID：{directory.searchId || "未返回"} · 更新于 {new Date(directory.updatedAt).toLocaleString("zh-CN")}</p> : <p className="developer-directory-empty">点击“加载完整目录”查看 provider 返回的实时能力说明、参数 schema、成功率和费用提示。</p>}{filteredDiscoveredCapabilities.length ? <div className="developer-capability-list">{filteredDiscoveredCapabilities.map((capability) => <CapabilityCard capability={capability} result={{ ...(capabilityTests[capability.kind] || {}), copied: copiedCapability === capability.kind }} onTest={runCapabilityTest} onCopy={copyCapabilitySchema} key={capability.kind} />)}</div> : directory && normalizedCapabilityFilter ? <p className="developer-directory-empty" role="status">当前筛选条件没有匹配的动态能力。</p> : null}</div>
      <div className="developer-log-card"><h4>调用日志 <span>{logs.length}</span><small>点击记录查看接口、参数、返回摘要和失败原因</small></h4><div className="developer-log-list">{logs.length ? logs.slice().reverse().map((entry) => <details className={`developer-log ${entry.status >= 400 ? "bad" : ""}`} key={entry.id}><summary><time>{formatTime(entry.at)}</time><code>{entry.operation || entry.kind || "request"}</code><span>{entry.cacheHit ? "缓存命中" : entry.status ? `${entry.status} · ${entry.durationMs ?? 0}ms` : "完成"}{entry.cost ? ` · ${formatCost(entry.cost)}` : ""}</span></summary><div className="developer-log-detail"><div><b>接口</b><code>{entry.method ? `${entry.method} ${entry.path}` : entry.operation || "event"}</code></div>{entry.params ? <div><b>参数</b><pre>{debugText(entry.params)}</pre></div> : null}{entry.response ? <div><b>返回摘要</b><pre>{debugText(entry.response)}</pre></div> : null}{entry.reason || entry.detail ? <div className="developer-log-reason"><b>失败原因</b><span>{entry.reason || entry.detail}</span></div> : null}</div></details>) : <p>暂无调用记录。执行一次行情或对话后会显示在这里。</p>}</div></div>
    </div>}
  </section>;
}
