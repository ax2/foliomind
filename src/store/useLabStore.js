import { create } from "zustand";
import { skills } from "../data/market.js";
import { askPi } from "../lib/piRuntime.js";

const RUNNING_REPLY = "Pi 正在分析…";

export const initialLabState = {
  activeView: "watchlist",
  selectedSymbol: "600519",
  chartRange: "分时",
  skillItems: skills.map((item) => ({ ...item })),
  messages: [
    { id: "a1", role: "assistant", text: "选择标的后点击“实时数据”，或直接告诉我需要的市场、指标和时间范围。我会通过 QVeris Search → Inspect → Call 查询，并返回来源与截至时间。", mode: "onboarding", audits: [] },
  ],
  rules: [{ id: "r1", symbol: "600519", name: "批价波动监控", enabled: true }],
  runtimeMode: "ready",
};

export const useLabStore = create((set, get) => ({
  ...initialLabState,
  setActiveView: (activeView) => set({ activeView }),
  selectSymbol: (selectedSymbol) => set({ selectedSymbol, activeView: "watchlist" }),
  setChartRange: (chartRange) => set({ chartRange }),
  toggleSkill: (id) => set((state) => ({ skillItems: state.skillItems.map((item) => item.id === id ? { ...item, installed: !item.installed } : item) })),
  toggleRule: (id) => set((state) => ({ rules: state.rules.map((rule) => rule.id === id ? { ...rule, enabled: !rule.enabled } : rule) })),
  addRule: (symbol) => set((state) => ({ rules: [...state.rules, { id: crypto.randomUUID(), symbol, name: "成交量异常监控", enabled: true }] })),
  sendMessage: async (text) => {
    const prompt = String(text ?? "").trim();
    if (!prompt || get().runtimeMode === "running") return false;
    const userId = crypto.randomUUID();
    const assistantId = crypto.randomUUID();
    set((state) => ({
      runtimeMode: "running",
      messages: [
        ...state.messages,
        { id: userId, role: "user", text: prompt },
        { id: assistantId, role: "assistant", text: RUNNING_REPLY, mode: "streaming", audits: [], streaming: true },
      ],
    }));
    try {
      const reply = await askPi(prompt, {
        onProgress: ({ text: partialText }) => set((state) => ({
          messages: state.messages.map((message) => message.id === assistantId && message.streaming
            ? { ...message, text: partialText }
            : message),
        })),
      });
      set((state) => ({
        runtimeMode: reply.mode,
        messages: state.messages.map((message) => message.id === assistantId
          ? { ...message, text: reply.text, mode: reply.mode, audits: reply.audits ?? [], streaming: false }
          : message),
      }));
      return true;
    } catch (error) {
      set((state) => ({
        runtimeMode: "error",
        messages: state.messages.map((message) => message.id === assistantId
          ? { ...message, text: `Pi Runtime 暂时不可用：${error instanceof Error ? error.message : String(error)}`, mode: "error", streaming: false }
          : message),
      }));
      return false;
    }
  },
}));
