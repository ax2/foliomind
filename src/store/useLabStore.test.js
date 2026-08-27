import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ askPi: vi.fn() }));

vi.mock("../lib/piRuntime.js", () => ({ askPi: runtime.askPi }));

import { initialLabState, useLabStore } from "./useLabStore.js";

describe("lab store streaming lifecycle", () => {
  beforeEach(() => {
    runtime.askPi.mockReset();
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
});
