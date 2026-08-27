import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  unlisten: vi.fn(),
  eventHandler: null,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen }));

import { askPi, textFromFrame } from "./piRuntime.js";

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
          tauri.eventHandler?.({ payload: { frame: { type: "agent_end", message: { content: [{ type: "text", text: "已完成分析" }] } } } });
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

  it("reports a real timeout instead of claiming the analysis completed", async () => {
    tauri.invoke.mockImplementation(async (command) => command === "runtime_status" ? { state: "running" } : { type: "response", success: true });
    await expect(askPi("分析超时", { settleTimeoutMs: 5 })).rejects.toThrow("等待超过 1 秒");
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
