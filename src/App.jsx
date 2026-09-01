import { ActivityRail } from "./components/ActivityRail.jsx";
import { CopilotPanel } from "./components/CopilotPanel.jsx";
import { StockWorkspace } from "./components/StockWorkspace.jsx";
import { ChatView, EventsView, MarketView, MonitorView, NotificationsView, PortfolioView, ResearchView, SettingsView, SkillsView } from "./components/SecondaryViews.jsx";
import { BRIEFING_RECONCILE_INTERVAL_MS, LIVE_QUOTE_REFRESH_INTERVAL_MS, MONITOR_INTERVAL_MS } from "./store/useLabStore.js";
import { useEffect } from "react";
import { WatchlistSidebar } from "./components/WatchlistSidebar.jsx";
import { useLabStore } from "./store/useLabStore.js";
import { LiveQuotesStrip } from "./components/LiveQuotesStrip.jsx";
import { DeveloperPanel } from "./components/DeveloperPanel.jsx";
import { listenForBackgroundReviewCompleted, listenForDesktopReconcile, reconcileDesktopNow } from "./lib/desktopLifecycle.js";
import { isDesktopRuntime } from "./lib/piRuntime.js";
import { AppErrorBoundary } from "./components/AppErrorBoundary.jsx";
import { CommandPalette } from "./components/CommandPalette.jsx";

export function App() {
  const activeView = useLabStore((state) => state.activeView);
  const settingsNotice = useLabStore((state) => state.settingsNotice);
  const clearSettingsNotice = useLabStore((state) => state.clearSettingsNotice);
  const hydrateUserState = useLabStore((state) => state.hydrateUserState);
  const hydrateIntegrationStatus = useLabStore((state) => state.hydrateIntegrationStatus);
  const refreshLiveData = useLabStore((state) => state.refreshLiveData);
  const userStateLoaded = useLabStore((state) => state.userStateLoaded);
  const userStateLoading = useLabStore((state) => state.userStateLoading);
  const userStateError = useLabStore((state) => state.userStateError);
  const integrationStatus = useLabStore((state) => state.integrationStatus);
  const runDueMonitorChecks = useLabStore((state) => state.runDueMonitorChecks);
  const runDuePortfolioReview = useLabStore((state) => state.runDuePortfolioReview);
  const integrationRefreshKey = [integrationStatus?.credentialConfigured, integrationStatus?.settings?.modelId, integrationStatus?.settings?.modelGatewayBaseUrl, integrationStatus?.settings?.capabilityBaseUrl].join("|");
  useEffect(() => {
    void hydrateUserState();
    void hydrateIntegrationStatus();
    const timer = window.setInterval(() => { void runDueMonitorChecks(); }, MONITOR_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [hydrateUserState, runDueMonitorChecks]);
  useEffect(() => {
    if (!userStateLoaded) return undefined;
    if (isDesktopRuntime()) return undefined;
    const reconcile = () => { void runDuePortfolioReview(); };
    reconcile();
    const timer = window.setInterval(reconcile, BRIEFING_RECONCILE_INTERVAL_MS);
    const onVisible = () => { if (document.visibilityState === "visible") reconcile(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", reconcile);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); window.removeEventListener("focus", reconcile); };
  }, [userStateLoaded, runDuePortfolioReview]);
  useEffect(() => {
    if (!userStateLoaded) return undefined;
    let disposed = false;
    let unlisten = () => {};
    void listenForDesktopReconcile(() => { void reconcileDesktopNow(); }).then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    });
    return () => { disposed = true; unlisten(); };
  }, [userStateLoaded]);
  useEffect(() => {
    if (!userStateLoaded) return undefined;
    let disposed = false;
    let unlisten = () => {};
    void listenForBackgroundReviewCompleted(() => { void hydrateUserState(); }).then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    });
    return () => { disposed = true; unlisten(); };
  }, [userStateLoaded, hydrateUserState]);
  useEffect(() => {
    if (!userStateLoaded || !integrationStatus?.credentialConfigured) return undefined;
    if (typeof window === "undefined" || typeof document === "undefined") return undefined;
    const isVisible = () => document.visibilityState !== "hidden";
    const refreshWhenVisible = () => {
      if (isVisible()) void refreshLiveData();
    };
    refreshWhenVisible();
    const timer = window.setInterval(refreshWhenVisible, LIVE_QUOTE_REFRESH_INTERVAL_MS);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refreshWhenVisible();
    };
    const onWindowFocus = () => refreshWhenVisible();
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onWindowFocus);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onWindowFocus);
    };
  }, [userStateLoaded, integrationRefreshKey, refreshLiveData]);
  const renderView = () => {
    if (activeView === "market") return <div className="secondary-view-shell"><LiveQuotesStrip /><MarketView /></div>;
    if (activeView === "research") return <div className="secondary-view-shell"><LiveQuotesStrip /><ResearchView /></div>;
    if (activeView === "monitor") return <div className="secondary-view-shell"><LiveQuotesStrip /><MonitorView /></div>;
    if (activeView === "events") return <div className="secondary-view-shell"><LiveQuotesStrip /><EventsView /></div>;
    if (activeView === "portfolio") return <PortfolioView />;
    if (activeView === "notifications") return <NotificationsView />;
    if (activeView === "skills") return <SkillsView />;
    if (activeView === "chat") return <ChatView />;
    if (activeView === "settings") return <SettingsView />;
    return <><WatchlistSidebar /><StockWorkspace /><CopilotPanel /></>;
  };
  const showGlobalNotice = settingsNotice && activeView !== "settings";
  return <AppErrorBoundary><div className={`app-shell view-${activeView}`}>
    <ActivityRail />
    {userStateError && <div className="global-notice error" role="alert" aria-live="assertive"><span>{userStateLoading ? "正在重新读取本地数据…" : userStateError}</span><button disabled={userStateLoading} onClick={() => { void hydrateUserState(); }}>{userStateLoading ? "读取中…" : "重新读取本地数据"}</button></div>}
    {showGlobalNotice && <div className={`global-notice ${settingsNotice.type === "error" ? "error" : "success"}`} role={settingsNotice.type === "error" ? "alert" : "status"} aria-live={settingsNotice.type === "error" ? "assertive" : "polite"}><span>{settingsNotice.text}</span><button onClick={clearSettingsNotice} aria-label="关闭通知">关闭</button></div>}
    {renderView()}
    <CommandPalette />
    <DeveloperPanel />
  </div></AppErrorBoundary>;
}
