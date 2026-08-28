import { isLocalWebRuntime, localHostRequest } from "./localHost.js";

const DEMO_REPLY = "我会按 Search → Inspect → Call 流程调用 QVeris，并把数据来源、截至时间与执行记录一起返回。";
const DEFAULT_SETTLE_TIMEOUT_MS = 120_000;
const MAX_PROMPT_CHARS = 32_000;
const SETTLE_TIMEOUT_CODE = "PI_SETTLE_TIMEOUT";
export const ABORTED_CODE = "PI_ABORTED";

export function isDesktopRuntime() {
  return typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);
}
export function textFromFrame(frame) {
  const content = frame?.message?.content ?? frame?.content ?? frame?.delta;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part?.type === "text").map((part) => part.text || "").join("");
}

function runtimeErrorFromFrame(frame) {
  const message = frame?.message;
  if (frame?.type !== "message_end" || message?.role !== "assistant") return undefined;
  if (message.stopReason === "error") return new Error(message.errorMessage || "模型请求失败");
  if (message.stopReason === "aborted") {
    const error = new Error("本轮分析已取消");
    error.code = ABORTED_CODE;
    return error;
  }
  return null;
}

function rejectedCommandError(response) {
  if (response?.type === "response" && response.success === false) {
    return new Error(String(response.error || "Pi 拒绝了本轮分析请求"));
  }
  return null;
}

async function abortActiveRun(invoke) {
  try {
    await invoke("runtime_send_rpc", { payload: { type: "abort" }, timeoutMs: 5_000 });
  } catch {
    // Preserve the original timeout. Runtime crash/transport events already expose abort failures.
  }
}

export async function abortPi() {
  if (!isDesktopRuntime()) {
    if (!isLocalWebRuntime()) throw new Error("停止分析仅在本地调试 Host 或桌面应用中可用");
    await localHostRequest("/api/runtime/abort", { method: "POST" });
    return true;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  const response = await invoke("runtime_send_rpc", { payload: { type: "abort" }, timeoutMs: 5_000 });
  const commandError = rejectedCommandError(response);
  if (commandError) throw commandError;
  return true;
}

function normalizedPrompt(message) {
  const value = String(message ?? "").trim();
  if (!value) throw new Error("请输入分析问题");
  if (value.length > MAX_PROMPT_CHARS) throw new Error(`分析问题不能超过 ${MAX_PROMPT_CHARS.toLocaleString()} 个字符`);
  return value;
}

function updateStreamingText(blocks, frame) {
  if (frame?.type !== "message_update") return undefined;
  const event = frame.assistantMessageEvent;
  const index = event?.contentIndex;
  if (!Number.isInteger(index) || index < 0) return undefined;
  if (event.type === "text_start") blocks.set(index, "");
  else if (event.type === "text_delta" && typeof event.delta === "string") blocks.set(index, `${blocks.get(index) ?? ""}${event.delta}`);
  else if (event.type === "text_end" && typeof event.content === "string") blocks.set(index, event.content);
  else return undefined;
  return [...blocks.entries()].sort(([left], [right]) => left - right).map(([, text]) => text).join("");
}

export async function askPi(message, { settleTimeoutMs = DEFAULT_SETTLE_TIMEOUT_MS, onProgress } = {}) {
  const prompt = normalizedPrompt(message);
  if (!isDesktopRuntime()) {
    if (!isLocalWebRuntime()) return { text: DEMO_REPLY, mode: "browser-demo" };
    const result = await localHostRequest("/api/runtime/prompt", { method: "POST", timeoutMs: settleTimeoutMs + 5_000, body: JSON.stringify({ message: prompt, timeoutMs: settleTimeoutMs }) });
    if (result.text) onProgress?.({ text: result.text });
    return { text: result.text || "本地 Pi 已完成本轮分析。", mode: "pi-local-host", audits: result.audits || [] };
  }
  const [{ invoke }, { listen }] = await Promise.all([
    import("@tauri-apps/api/core"),
    import("@tauri-apps/api/event"),
  ]);
  const status = await invoke("runtime_status");
  if (status.state === "stopped" || status.state === "crashed") await invoke("runtime_start");

  let latestText = "";
  let lastReportedText = null;
  let terminalError = null;
  const audits = [];
  const streamingBlocks = new Map();
  const reportProgress = (text) => {
    if (!text || text === lastReportedText || typeof onProgress !== "function") return;
    lastReportedText = text;
    try {
      onProgress({ text });
    } catch {
      // Rendering callbacks must not interrupt the runtime protocol lifecycle.
    }
  };
  let finish;
  let fail;
  let timeout;
  const settled = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
  const unlisten = await listen("pi-runtime://event", ({ payload }) => {
    if (payload?.kind === "qveris_audit" && payload.audit) audits.push(payload.audit);
    const frame = payload?.frame;
    if (frame?.type === "message_start" && frame.message?.role === "assistant") {
      streamingBlocks.clear();
      lastReportedText = null;
    }
    const streamingText = updateStreamingText(streamingBlocks, frame);
    if (streamingText) {
      latestText = streamingText;
      reportProgress(streamingText);
    }
    if (frame?.type === "message_end" && frame.message?.role === "assistant") {
      const finalText = textFromFrame(frame);
      if (finalText) {
        latestText = finalText;
        reportProgress(finalText);
      }
    }
    const frameError = runtimeErrorFromFrame(frame);
    if (frameError !== undefined) terminalError = frameError;
    if (frame?.type === "agent_settled") {
      if (terminalError) fail(terminalError);
      else finish();
    }
    if (["crash", "transport_error", "protocol_error"].includes(payload?.kind)) {
      const detail = payload?.status?.detail || (typeof payload?.frame === "string" ? payload.frame : "");
      fail(new Error(detail || "Pi Runtime 在分析过程中异常退出"));
    }
  });
  try {
    const response = await invoke("runtime_send_rpc", { payload: { type: "prompt", message: prompt }, timeoutMs: 30_000 });
    const commandError = rejectedCommandError(response);
    if (commandError) throw commandError;
    const responseText = textFromFrame(response);
    if (responseText) {
      latestText = responseText;
      reportProgress(responseText);
    }
    const timeoutMs = Math.max(1, Number(settleTimeoutMs) || DEFAULT_SETTLE_TIMEOUT_MS);
    const timedOut = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        const error = new Error(`Pi 分析等待超过 ${Math.ceil(timeoutMs / 1000)} 秒，已取消本轮任务，请重试`);
        error.code = SETTLE_TIMEOUT_CODE;
        reject(error);
      }, timeoutMs);
    });
    try {
      await Promise.race([settled, timedOut]);
    } catch (error) {
      if (error?.code === SETTLE_TIMEOUT_CODE) await abortActiveRun(invoke);
      throw error;
    }
    return { text: latestText || "Pi 已完成本轮分析；详细执行事件已保留在本地审计流中。", mode: "pi-rpc", audits };
  } finally {
    clearTimeout(timeout);
    unlisten();
  }
}
