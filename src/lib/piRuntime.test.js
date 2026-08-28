import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  unlisten: vi.fn(),
  eventHandler: null,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen }));

import { ABORTED_CODE, abortPi, askPi, textFromFrame } from "./piRuntime.js";

describe("Pi runtime client", () => {
  beforeEach(() => {
    window.__TAURI_INTERNALS__ = {};
    tauri.invoke.mockReset();
    tauri.listen.mockReset();
    tauri.unlisten.mockReset();
    tauri.eventHandler = null;
    tauri.listen.mockImplementation(async (_event, handler) => {
      tauri.eventHandler = handler;
      return tauri.unlisten;
    });
    tauri.invoke.mockImplementation(async (command) => {
      if (command === "runtime_status") return { state: "running" };
      if (command === "runtime_send_rpc") {
        queueMicrotask(() => {
          tauri.eventHandler?.({ payload: { frame: { type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "已完成分析" }] } } } });
          tauri.eventHandler?.({ payload: { frame: { type: "agent_settled" } } });
        });
        return { type: "response", success: true };
      }
      throw new Error(`unexpected command: ${command}`);
    });
  });

  afterEach(() => {
    delete window.__TAURI_INTERNALS__;
  });

  it("extracts text from string and structured Pi frames", () => {
    expect(textFromFrame({ content: "直接文本" })).toBe("直接文本");
    expect(textFromFrame({ message: { content: [{ type: "text", text: "结构化" }, { type: "tool_call" }] } })).toBe("结构化");
  });

  it("returns the final agent text and always removes its event listener", async () => {
    await expect(askPi(" 分析 AAPL ", { settleTimeoutMs: 100 })).resolves.toMatchObject({ text: "已完成分析", mode: "pi-rpc" });
    expect(tauri.invoke).toHaveBeenCalledWith("runtime_send_rpc", expect.objectContaining({ payload: { type: "prompt", message: "分析 AAPL" } }));
    expect(tauri.unlisten).toHaveBeenCalledOnce();
  });

  it("assembles indexed text deltas and reports the authoritative final message", async () => {
    const onProgress = vi.fn();
    tauri.invoke.mockImplementation(async (command) => {
      if (command === "runtime_status") return { state: "running" };
      if (command === "runtime_send_rpc") {
        queueMicrotask(() => {
          tauri.eventHandler?.({ payload: { frame: { type: "message_start", message: { role: "assistant", content: [] } } } });
          tauri.eventHandler?.({ payload: { frame: { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "第一段" } } } });
          tauri.eventHandler?.({ payload: { frame: { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 1 } } } });
          tauri.eventHandler?.({ payload: { frame: { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "第二" } } } });
          tauri.eventHandler?.({ payload: { frame: { type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 1, content: "第二段" } } } });
          tauri.eventHandler?.({ payload: { frame: { type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "最终答案" }] } } } });
          tauri.eventHandler?.({ payload: { frame: { type: "agent_settled" } } });
        });
        return { type: "response", success: true };
      }
      return undefined;
    });

    await expect(askPi("流式分析", { settleTimeoutMs: 100, onProgress })).resolves.toMatchObject({ text: "最终答案" });
    expect(onProgress.mock.calls.map(([update]) => update.text)).toEqual(["第一段", "第一段第二", "第一段第二段", "最终答案"]);
  });

  it("reports a real timeout instead of claiming the analysis completed", async () => {
    tauri.invoke.mockImplementation(async (command, args) => {
      if (command === "runtime_status") return { state: "running" };
      if (args?.payload?.type === "abort") return { type: "response", success: true };
      return { type: "response", success: true };
    });
    await expect(askPi("分析超时", { settleTimeoutMs: 5 })).rejects.toThrow("已取消本轮任务");
    expect(tauri.invoke).toHaveBeenCalledWith("runtime_send_rpc", expect.objectContaining({ payload: { type: "abort" } }));
    expect(tauri.unlisten).toHaveBeenCalledOnce();
  });

  it("sends an explicit abort command for a user cancellation", async () => {
    tauri.invoke.mockResolvedValue({ type: "response", success: true });
    await expect(abortPi()).resolves.toBe(true);
    expect(tauri.invoke).toHaveBeenCalledWith("runtime_send_rpc", { payload: { type: "abort" }, timeoutMs: 5_000 });
  });

  it("surfaces an abort rejected by Pi", async () => {
    tauri.invoke.mockResolvedValue({ type: "response", success: false, error: "Agent is not streaming" });
    await expect(abortPi()).rejects.toThrow("Agent is not streaming");
  });

  it("marks an aborted final frame as a cancellation", async () => {
    tauri.invoke.mockImplementation(async (command) => {
      if (command === "runtime_status") return { state: "running" };
      queueMicrotask(() => {
        tauri.eventHandler?.({ payload: { frame: { type: "message_end", message: { role: "assistant", stopReason: "aborted", content: [] } } } });
        tauri.eventHandler?.({ payload: { frame: { type: "agent_settled" } } });
      });
      return { type: "response", success: true };
    });
    await expect(askPi("停止分析", { settleTimeoutMs: 100 })).rejects.toMatchObject({ code: ABORTED_CODE, message: "本轮分析已取消" });
  });

  it("waits for agent_settled across an automatic retry", async () => {
    tauri.invoke.mockImplementation(async (command) => {
      if (command === "runtime_status") return { state: "running" };
      if (command === "runtime_send_rpc") {
        queueMicrotask(() => {
          tauri.eventHandler?.({ payload: { frame: { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "temporary", content: [] } } } });
          tauri.eventHandler?.({ payload: { frame: { type: "agent_end", willRetry: true } } });
          tauri.eventHandler?.({ payload: { frame: { type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "重试后完成" }] } } } });
          tauri.eventHandler?.({ payload: { frame: { type: "agent_settled" } } });
        });
        return { type: "response", success: true };
      }
      return undefined;
    });
    await expect(askPi("自动重试", { settleTimeoutMs: 100 })).resolves.toMatchObject({ text: "重试后完成" });
  });

  it("surfaces a prompt rejected before acceptance", async () => {
    tauri.invoke.mockImplementation(async (command) => command === "runtime_status"
      ? { state: "running" }
      : { type: "response", command: "prompt", success: false, error: "Agent is already streaming" });
    await expect(askPi("重复请求", { settleTimeoutMs: 100 })).rejects.toThrow("Agent is already streaming");
    expect(tauri.unlisten).toHaveBeenCalledOnce();
  });

  it("surfaces a final model error only after retries settle", async () => {
    tauri.invoke.mockImplementation(async (command) => {
      if (command === "runtime_status") return { state: "running" };
      if (command === "runtime_send_rpc") {
        queueMicrotask(() => {
          tauri.eventHandler?.({ payload: { frame: { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "模型额度不足", content: [] } } } });
          tauri.eventHandler?.({ payload: { frame: { type: "agent_end", willRetry: false } } });
          tauri.eventHandler?.({ payload: { frame: { type: "agent_settled" } } });
        });
        return { type: "response", success: true };
      }
      return undefined;
    });
    await expect(askPi("最终失败", { settleTimeoutMs: 100 })).rejects.toThrow("模型额度不足");
    expect(tauri.unlisten).toHaveBeenCalledOnce();
  });

  it("surfaces runtime crashes during an active request", async () => {
    tauri.invoke.mockImplementation(async (command) => {
      if (command === "runtime_status") return { state: "running" };
      if (command === "runtime_send_rpc") {
        queueMicrotask(() => tauri.eventHandler?.({ payload: { kind: "crash", status: { detail: "模型进程退出" } } }));
        return { type: "response", success: true };
      }
      return undefined;
    });
    await expect(askPi("分析崩溃", { settleTimeoutMs: 100 })).rejects.toThrow("模型进程退出");
    expect(tauri.unlisten).toHaveBeenCalledOnce();
  });

  it("surfaces malformed runtime protocol frames", async () => {
    tauri.invoke.mockImplementation(async (command) => {
      if (command === "runtime_status") return { state: "running" };
      if (command === "runtime_send_rpc") {
        queueMicrotask(() => tauri.eventHandler?.({ payload: { kind: "protocol_error", frame: "invalid JSONL frame" } }));
        return { type: "response", success: true };
      }
      return undefined;
    });
    await expect(askPi("分析协议错误", { settleTimeoutMs: 100 })).rejects.toThrow("invalid JSONL frame");
    expect(tauri.unlisten).toHaveBeenCalledOnce();
  });
});
