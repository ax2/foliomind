import { Bell, ChartLineUp, ChatCircleDots, Gear, GridFour, Star, Storefront } from "@phosphor-icons/react";
import { useLabStore } from "../store/useLabStore.js";

const nav = [
  ["watchlist", "自选", Star],
  ["market", "行情", ChartLineUp],
  ["monitor", "盯盘", Bell],
  ["chat", "对话", ChatCircleDots],
  ["skills", "技能", GridFour],
];

export function ActivityRail() {
  const activeView = useLabStore((state) => state.activeView);
  const setActiveView = useLabStore((state) => state.setActiveView);
  return (
    <nav className="activity-rail" aria-label="主导航">
      <button className="brand-button" onClick={() => setActiveView("watchlist")} aria-label="FolioMind 首页">
        <img src="/assets/foliomind-logo.png" alt="" />
      </button>
      <div className="rail-links">
        {nav.map(([id, label, Icon]) => (
          <button key={id} className={activeView === id ? "rail-link active" : "rail-link"} aria-current={activeView === id ? "page" : undefined} onClick={() => setActiveView(id)}>
            <Icon size={22} weight={activeView === id ? "fill" : "regular"} />
            <span>{label}</span>
          </button>
        ))}
      </div>
      <div className="rail-footer">
        <button className={activeView === "settings" ? "rail-link active" : "rail-link"} aria-current={activeView === "settings" ? "page" : undefined} onClick={() => setActiveView("settings")}><Gear size={22} /><span>设置</span></button>
        <button className="avatar-button" aria-label="个人账户"><Storefront size={18} /></button>
      </div>
    </nav>
  );
}
