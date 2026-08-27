import { create } from "zustand";
import { skills } from "../data/market.js";
import { askPi } from "../lib/piRuntime.js";

export const useLabStore = create((set) => ({
  activeView: "watchlist",
  selectedSymbol: "600519",
  chartRange: "分时",
  skillItems: skills,
  messages: [
    { id: "u1", role: "user", text: "让 FolioMind 分析这只股票" },
    { id: "a1", role: "assistant", text: "公司基本面稳健，高端白酒龙头地位巩固。短期受消费情绪和动销节奏影响，建议结合批价、库存与现金流持续观察。" },
  ],
  rules: [{ id: "r1", symbol: "600519", name: "批价波动监控", enabled: true }],
  runtimeMode: "ready",
  setActiveView: (activeView) => set({ activeView }),
  selectSymbol: (selectedSymbol) => set({ selectedSymbol, activeView: "watchlist" }),
  setChartRange: (chartRange) => set({ chartRange }),
  toggleSkill: (id) => set((state) => ({ skillItems: state.skillItems.map((item) => item.id === id ? { ...item, installed: !item.installed } : item) })),
  toggleRule: (id) => set((state) => ({ rules: state.rules.map((rule) => rule.id === id ? { ...rule, enabled: !rule.enabled } : rule) })),
  addRule: (symbol) => set((state) => ({ rules: [...state.rules, { id: crypto.randomUUID(), symbol, name: "成交量异常监控", enabled: true }] })),
  sendMessage: async (text) => {
    const userId = crypto.randomUUID();
    set((state) => ({ runtimeMode: "running", messages: [...state.messages, { id: userId, role: "user", text }] }));
    try {
      const reply = await askPi(text);
      set((state) => ({ runtimeMode: reply.mode, messages: [...state.messages, { id: crypto.randomUUID(), role: "assistant", text: reply.text }] }));
    } catch (error) {
      set((state) => ({ runtimeMode: "error", messages: [...state.messages, { id: crypto.randomUUID(), role: "assistant", text: `Pi Runtime 暂时不可用：${error instanceof Error ? error.message : String(error)}` }] }));
    }
  },
}));
