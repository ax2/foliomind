import { ActivityRail } from "./components/ActivityRail.jsx";
import { CopilotPanel } from "./components/CopilotPanel.jsx";
import { StockWorkspace } from "./components/StockWorkspace.jsx";
import { ChatView, MarketView, MonitorView, NotificationsView, SettingsView, SkillsView } from "./components/SecondaryViews.jsx";
import { LIVE_QUOTE_REFRESH_INTERVAL_MS, MONITOR_INTERVAL_MS } from "./store/useLabStore.js";
import { useEffect } from "react";
import { WatchlistSidebar } from "./components/WatchlistSidebar.jsx";
import { useLabStore } from "./store/useLabStore.js";
import { LiveQuotesStrip } from "./components/LiveQuotesStrip.jsx";

export function App() {
  const activeView = useLabStore((state) => state.activeView);
  const settingsNotice = useLabStore((state) => state.settingsNotice);
  const clearSettingsNotice = useLabStore((state) => state.clearSettingsNotice);
  const hydrateUserState = useLabStore((state) => state.hydrateUserState);
  const hydrateIntegrationStatus = useLabStore((state) => state.hydrateIntegrationStatus);
  const refreshLiveData = useLabStore((state) => state.refreshLiveData);
  const userStateLoaded = useLabStore((state) => state.userStateLoaded);
  const integrationStatus = useLabStore((state) => state.integrationStatus);
  const runDueMonitorChecks = useLabStore((state) => state.runDueMonitorChecks);
  useEffect(() => {
    void hydrateUserState();
    void hydrateIntegrationStatus();
    const timer = window.setInterval(() => { void runDueMonitorChecks(); }, MONITOR_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [hydrateUserState, runDueMonitorChecks]);
  useEffect(() => {
    if (!userStateLoaded || !integrationStatus?.credentialConfigured || !integrationStatus.settings?.modelId) return undefined;
    void refreshLiveData();
    const timer = window.setInterval(() => { void refreshLiveData(); }, LIVE_QUOTE_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [userStateLoaded, integrationStatus?.credentialConfigured, integrationStatus?.settings?.modelId, refreshLiveData]);
  const renderView = () => {
    if (activeView === "market") return <div className="secondary-view-shell"><LiveQuotesStrip /><MarketView /></div>;
    if (activeView === "monitor") return <div className="secondary-view-shell"><LiveQuotesStrip /><MonitorView /></div>;
    if (activeView === "notifications") return <NotificationsView />;
    if (activeView === "skills") return <SkillsView />;
    if (activeView === "chat") return <ChatView />;
    if (activeView === "settings") return <SettingsView />;
    return <><WatchlistSidebar /><StockWorkspace /><CopilotPanel /></>;
  };
  const showGlobalNotice = settingsNotice && activeView !== "settings";
  return <div className={`app-shell view-${activeView}`}>
    <ActivityRail />
    {showGlobalNotice && <div className={`global-notice ${settingsNotice.type === "error" ? "error" : "success"}`} role={settingsNotice.type === "error" ? "alert" : "status"} aria-live={settingsNotice.type === "error" ? "assertive" : "polite"}><span>{settingsNotice.text}</span><button onClick={clearSettingsNotice} aria-label="关闭通知">关闭</button></div>}
    {renderView()}
  </div>;
}
