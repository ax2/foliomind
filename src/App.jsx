import { ActivityRail } from "./components/ActivityRail.jsx";
import { CopilotPanel } from "./components/CopilotPanel.jsx";
import { StockWorkspace } from "./components/StockWorkspace.jsx";
import { ChatView, MarketView, MonitorView, SettingsView, SkillsView } from "./components/SecondaryViews.jsx";
import { WatchlistSidebar } from "./components/WatchlistSidebar.jsx";
import { useLabStore } from "./store/useLabStore.js";

export function App() {
  const activeView = useLabStore((state) => state.activeView);
  const renderView = () => {
    if (activeView === "market") return <MarketView />;
    if (activeView === "monitor") return <MonitorView />;
    if (activeView === "skills") return <SkillsView />;
    if (activeView === "chat") return <ChatView />;
    if (activeView === "settings") return <SettingsView />;
    return <><WatchlistSidebar /><StockWorkspace /><CopilotPanel /></>;
  };
  return <div className={`app-shell view-${activeView}`}><ActivityRail />{renderView()}</div>;
}
