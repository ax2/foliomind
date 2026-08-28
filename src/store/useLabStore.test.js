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

  it("hydrates page quotes from a real structured QVeris response", async () => {
    useLabStore.setState({
      integrationStatus: { credentialConfigured: true, settings: { modelId: "model-a" } },
      userStateLoaded: true,
      watchlist: [{ symbol: "600519", name: "贵州茅台", market: "沪深", category: "白酒" }],
    });
    runtime.askPi.mockResolvedValue({
      text: JSON.stringify({ quotes: [{ symbol: "600519", price: 1297.4, changePercent: 0.39, asOf: "2026-08-28 15:17:32", source: "caidazi" }] }),
      mode: "pi-local-host",
      audits: [{ operation: "search" }],
    });

    await expect(useLabStore.getState().refreshLiveData()).resolves.toBe(true);
    expect(runtime.askPi).toHaveBeenCalledOnce();
    expect(useLabStore.getState().liveQuotes["600519"]).toMatchObject({ price: 1297.4, change: 0.39, source: "caidazi" });
    expect(useLabStore.getState().liveDataError).toBe("");
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

  it("blocks a new analysis until a delayed cancellation command settles", async () => {
    let finishAnalysis;
    let finishAbort;
    runtime.askPi
      .mockImplementationOnce(() => new Promise((resolve) => { finishAnalysis = resolve; }))
      .mockResolvedValueOnce({ text: "下一轮完成", mode: "pi-rpc", audits: [] });
    runtime.abortPi.mockImplementation(() => new Promise((resolve) => { finishAbort = resolve; }));

    const sent = useLabStore.getState().sendMessage("第一轮分析");
    const cancellation = useLabStore.getState().cancelMessage();
    finishAnalysis({ text: "取消前已完成", mode: "pi-rpc", audits: [] });
    await expect(sent).resolves.toBe(true);
    expect(useLabStore.getState()).toMatchObject({ runtimeMode: "pi-rpc", runtimeCancelPending: true });
    await expect(useLabStore.getState().sendMessage("不应抢跑")).resolves.toBe(false);
    expect(runtime.askPi).toHaveBeenCalledOnce();

    finishAbort(true);
    await expect(cancellation).resolves.toBe(true);
    expect(useLabStore.getState().runtimeCancelPending).toBe(false);
    await expect(useLabStore.getState().sendMessage("下一轮分析")).resolves.toBe(true);
    expect(runtime.askPi).toHaveBeenCalledTimes(2);
  });

  it.each(["running", "cancelling"])("refuses to apply Runtime settings while mode is %s", (runtimeMode) => {
    useLabStore.setState({ runtimeMode });

    expect(useLabStore.getState().beginRuntimeConfiguration()).toBe(false);
    expect(useLabStore.getState().runtimeConfiguring).toBe(false);
  });
});
