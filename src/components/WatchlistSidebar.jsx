import { CaretDown, DotsThree, Plus } from "@phosphor-icons/react";
import { watchGroups } from "../data/market.js";
import { useLabStore } from "../store/useLabStore.js";

export function WatchlistSidebar() {
  const selectedSymbol = useLabStore((state) => state.selectedSymbol);
  const selectSymbol = useLabStore((state) => state.selectSymbol);
  return (
    <aside className="watchlist-sidebar">
      <div className="sidebar-heading"><h2>自选</h2><div><button aria-label="添加自选"><Plus size={19} /></button><button aria-label="更多"><DotsThree size={20} /></button></div></div>
      <div className="watch-groups">
        {watchGroups.map((group) => (
          <section key={group.label}>
            <h3>{group.label}<CaretDown size={13} /></h3>
            {group.items.map((item) => (
              <button key={item.symbol} className={selectedSymbol === item.symbol ? "watch-row selected" : "watch-row"} onClick={() => selectSymbol(item.symbol)}>
                <span><strong>{item.name}</strong><small>{item.symbol}{item.symbol.length < 6 && item.name.includes(".") ? "" : ""}</small></span>
                <span className={item.change >= 0 ? "quote up" : "quote down"}><strong>{item.price.toFixed(2)}</strong><small>{item.change >= 0 ? "+" : ""}{item.change.toFixed(2)}%</small></span>
              </button>
            ))}
          </section>
        ))}
      </div>
      <div className="sidebar-status"><span className="status-dot" />最后更新 15:00:18</div>
    </aside>
  );
}
