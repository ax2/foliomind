import { Bell, BellRinging, ChartLineUp, ChatCircleDots, Gear, GridFour, Star, Storefront } from "@phosphor-icons/react";
import { useLabStore } from "../store/useLabStore.js";

const nav = [
  ["watchlist", "自选", Star],
  ["market", "行情", ChartLineUp],
  ["monitor", "盯盘", Bell],
  ["notifications", "消息", BellRinging],
  ["chat", "对话", ChatCircleDots],
  ["skills", "技能", GridFour],
];

export function ActivityRail() {
  const activeView = useLabStore((state) => state.activeView);
  const setActiveView = useLabStore((state) => state.setActiveView);
  const unreadCount = useLabStore((state) => state.notifications.filter((item) => !item.read).length);
  return (
    <nav className="activity-rail" aria-label="主导航">
      <button className="brand-button" onClick={() => setActiveView("watchlist")} aria-label="FolioMind 首页">
        <img src="/assets/foliomind-logo-v2.png" alt="" width="36" height="36" decoding="async" />
      </button>
      <div className="rail-links">
        {nav.map(([id, label, Icon]) => (
          <button key={id} className={activeView === id ? "rail-link active" : "rail-link"} aria-current={activeView === id ? "page" : undefined} onClick={() => setActiveView(id)}>
            <span className="rail-icon-wrap"><Icon size={22} weight={activeView === id ? "fill" : "regular"} />{id === "notifications" && unreadCount > 0 && <em>{unreadCount > 99 ? "99+" : unreadCount}</em>}</span>
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
