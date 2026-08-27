const DEMO_REPLY = "我会按 Search → Inspect → Call 流程调用 QVeris，并把数据来源、截至时间与执行记录一起返回。";

export function isDesktopRuntime() {
  return typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);
}
function textFromFrame(frame) {
  const content = frame?.message?.content ?? frame?.content ?? frame?.delta;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part?.type === "text").map((part) => part.text || "").join("");
}

export async function askPi(message) {
  if (!isDesktopRuntime()) return { text: DEMO_REPLY, mode: "browser-demo" };
  const [{ invoke }, { listen }] = await Promise.all([
    import("@tauri-apps/api/core"),
    import("@tauri-apps/api/event"),
  ]);
  const status = await invoke("runtime_status");
  if (status.state === "stopped" || status.state === "crashed") await invoke("runtime_start");

  let latestText = "";
  const audits = [];
  let finish;
  const settled = new Promise((resolve) => { finish = resolve; });
  const unlisten = await listen("pi-runtime://event", ({ payload }) => {
    if (payload?.kind === "qveris_audit" && payload.audit) audits.push(payload.audit);
    const frame = payload?.frame;
    const nextText = textFromFrame(frame);
    if (nextText) latestText = nextText;
    if (["agent_end", "agent_settled"].includes(frame?.type)) finish();
  });
  try {
    await invoke("runtime_send_rpc", { payload: { type: "prompt", message }, timeoutMs: 30_000 });
    await Promise.race([settled, new Promise((resolve) => setTimeout(resolve, 120_000))]);
    return { text: latestText || "Pi 已完成本轮分析；详细执行事件已保留在本地审计流中。", mode: "pi-rpc", audits };
  } finally {
    unlisten();
  }
}
