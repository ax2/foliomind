const DEMO_REPLY = "我会按 Search → Inspect → Call 流程调用 QVeris，并把数据来源、截至时间与执行记录一起返回。";
const DEFAULT_SETTLE_TIMEOUT_MS = 120_000;
const MAX_PROMPT_CHARS = 32_000;
const SETTLE_TIMEOUT_CODE = "PI_SETTLE_TIMEOUT";

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
  if (message.stopReason === "aborted") return new Error("本轮分析已取消");
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

function normalizedPrompt(message) {
  const value = String(message ?? "").trim();
  if (!value) throw new Error("请输入分析问题");
  if (value.length > MAX_PROMPT_CHARS) throw new Error(`分析问题不能超过 ${MAX_PROMPT_CHARS.toLocaleString()} 个字符`);
  return value;
}

export async function askPi(message, { settleTimeoutMs = DEFAULT_SETTLE_TIMEOUT_MS } = {}) {
  const prompt = normalizedPrompt(message);
  if (!isDesktopRuntime()) return { text: DEMO_REPLY, mode: "browser-demo" };
  const [{ invoke }, { listen }] = await Promise.all([
    import("@tauri-apps/api/core"),
    import("@tauri-apps/api/event"),
  ]);
  const status = await invoke("runtime_status");
  if (status.state === "stopped" || status.state === "crashed") await invoke("runtime_start");

  let latestText = "";
  let terminalError = null;
  const audits = [];
  let finish;
  let fail;
  let timeout;
  const settled = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
  const unlisten = await listen("pi-runtime://event", ({ payload }) => {
    if (payload?.kind === "qveris_audit" && payload.audit) audits.push(payload.audit);
    const frame = payload?.frame;
    const nextText = textFromFrame(frame);
    if (nextText) latestText = nextText;
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
    if (responseText) latestText = responseText;
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
