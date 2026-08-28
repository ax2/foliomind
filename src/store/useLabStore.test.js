import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ abortPi: vi.fn(), askPi: vi.fn() }));

vi.mock("../lib/piRuntime.js", () => ({ ABORTED_CODE: "PI_ABORTED", abortPi: runtime.abortPi, askPi: runtime.askPi }));

import { initialLabState, useLabStore } from "./useLabStore.js";

describe("lab store streaming lifecycle", () => {
  beforeEach(() => {
    runtime.askPi.mockReset();
    runtime.abortPi.mockReset();
    useLabStore.setState({
      ...initialLabState,
      messages: initialLabState.messages.map((message) => ({ ...message })),
    });
  });

  it("updates one assistant placeholder in place until the final answer", async () => {
    let reportProgress;
    let finish;
    runtime.askPi.mockImplementation((_prompt, { onProgress }) => {
      reportProgress = onProgress;
      return new Promise((resolve) => { finish = resolve; });
    });

    const sent = useLabStore.getState().sendMessage("分析 AAPL");
    const pending = useLabStore.getState().messages.at(-1);
    expect(pending).toMatchObject({ role: "assistant", text: "Pi 正在分析…", streaming: true });

    reportProgress({ text: "第一段结果" });
    expect(useLabStore.getState().messages.at(-1)).toMatchObject({ id: pending.id, text: "第一段结果", streaming: true });

    finish({ text: "完整结果", mode: "pi-rpc", audits: [{ toolCallId: "call-1", operation: "search", outcome: "success" }] });
    await expect(sent).resolves.toBe(true);
    expect(useLabStore.getState().messages.at(-1)).toMatchObject({ id: pending.id, text: "完整结果", mode: "pi-rpc", streaming: false });
    expect(useLabStore.getState().messages.filter((message) => message.role === "assistant")).toHaveLength(2);
  });

  it("replaces partial output with an error instead of appending another message", async () => {
    runtime.askPi.mockImplementation(async (_prompt, { onProgress }) => {
      onProgress({ text: "未完成内容" });
      throw new Error("模型进程退出");
    });

    await expect(useLabStore.getState().sendMessage("触发错误")).resolves.toBe(false);
    const messages = useLabStore.getState().messages;
    expect(messages.at(-1)).toMatchObject({ role: "assistant", text: "Pi Runtime 暂时不可用：模型进程退出", mode: "error", streaming: false });
    expect(messages.filter((message) => message.role === "assistant")).toHaveLength(2);
  });

  it("cancels an active analysis and replaces its partial output in place", async () => {
    let rejectAnalysis;
    runtime.askPi.mockImplementation((_prompt, { onProgress }) => {
      onProgress({ text: "尚未完成的分析" });
      return new Promise((_resolve, reject) => { rejectAnalysis = reject; });
    });
    runtime.abortPi.mockResolvedValue(true);

    const sent = useLabStore.getState().sendMessage("取消这次分析");
    const pendingId = useLabStore.getState().messages.at(-1).id;
    await expect(useLabStore.getState().cancelMessage()).resolves.toBe(true);
    expect(useLabStore.getState().runtimeMode).toBe("cancelling");

    const cancelled = new Error("本轮分析已取消");
    cancelled.code = "PI_ABORTED";
    rejectAnalysis(cancelled);
    await expect(sent).resolves.toBe(false);
    expect(useLabStore.getState().runtimeMode).toBe("cancelled");
    expect(useLabStore.getState().messages.at(-1)).toMatchObject({ id: pendingId, text: "已取消本轮分析。", mode: "cancelled", streaming: false });
  });

  it("restores the running state when Pi rejects a cancellation request", async () => {
    runtime.askPi.mockImplementation(() => new Promise(() => {}));
    runtime.abortPi.mockRejectedValue(new Error("Agent is not streaming"));
    void useLabStore.getState().sendMessage("继续运行");

    await expect(useLabStore.getState().cancelMessage()).resolves.toBe(false);
    expect(useLabStore.getState().runtimeMode).toBe("running");
  });

  it("does not overwrite a result that settles while cancellation is pending", async () => {
    let finishAnalysis;
    let rejectAbort;
    runtime.askPi.mockImplementation(() => new Promise((resolve) => { finishAnalysis = resolve; }));
    runtime.abortPi.mockImplementation(() => new Promise((_resolve, reject) => { rejectAbort = reject; }));
    const sent = useLabStore.getState().sendMessage("竞态分析");
    const cancellation = useLabStore.getState().cancelMessage();

    finishAnalysis({ text: "已在取消前完成", mode: "pi-rpc", audits: [] });
    await expect(sent).resolves.toBe(true);
    rejectAbort(new Error("Agent is not streaming"));
    await expect(cancellation).resolves.toBe(false);
    expect(useLabStore.getState().runtimeMode).toBe("pi-rpc");
    expect(useLabStore.getState().messages.at(-1)).toMatchObject({ text: "已在取消前完成", streaming: false });
  });

  it("prevents analysis while Runtime settings are being applied", async () => {
    expect(useLabStore.getState().beginRuntimeConfiguration()).toBe(true);
    expect(useLabStore.getState().runtimeConfiguring).toBe(true);

    await expect(useLabStore.getState().sendMessage("不应发出的请求")).resolves.toBe(false);
    expect(runtime.askPi).not.toHaveBeenCalled();
    expect(useLabStore.getState().messages).toHaveLength(initialLabState.messages.length);

    useLabStore.getState().endRuntimeConfiguration();
    expect(useLabStore.getState().runtimeConfiguring).toBe(false);
  });

  it("atomically accepts only one synchronous send", async () => {
    runtime.askPi.mockImplementation(() => new Promise(() => {}));

    const first = useLabStore.getState().sendMessage("第一条分析");
    const second = useLabStore.getState().sendMessage("第二条分析");

    await expect(second).resolves.toBe(false);
    expect(runtime.askPi).toHaveBeenCalledOnce();
    expect(useLabStore.getState().messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(useLabStore.getState().messages.at(-2).text).toBe("第一条分析");
    void first;
  });

  it("atomically accepts only one synchronous cancellation", async () => {
    runtime.askPi.mockImplementation(() => new Promise(() => {}));
    runtime.abortPi.mockImplementation(() => new Promise(() => {}));
    void useLabStore.getState().sendMessage("等待停止");

    const first = useLabStore.getState().cancelMessage();
    const second = useLabStore.getState().cancelMessage();

    await expect(second).resolves.toBe(false);
    expect(runtime.abortPi).toHaveBeenCalledOnce();
    expect(useLabStore.getState().runtimeMode).toBe("cancelling");
    void first;
  });

  it.each(["running", "cancelling"])("refuses to apply Runtime settings while mode is %s", (runtimeMode) => {
    useLabStore.setState({ runtimeMode });

    expect(useLabStore.getState().beginRuntimeConfiguration()).toBe(false);
    expect(useLabStore.getState().runtimeConfiguring).toBe(false);
  });
});
