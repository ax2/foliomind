import { ActivityRail } from "./components/ActivityRail.jsx";
import { CopilotPanel } from "./components/CopilotPanel.jsx";
import { StockWorkspace } from "./components/StockWorkspace.jsx";
import { BRIEFING_RECONCILE_INTERVAL_MS, LIVE_QUOTE_FULL_REFRESH_INTERVAL_MS, LIVE_QUOTE_PRIORITY_REFRESH_INTERVAL_MS, MONITOR_INTERVAL_MS } from "./store/useLabStore.js";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { WatchlistSidebar } from "./components/WatchlistSidebar.jsx";
import { useLabStore } from "./store/useLabStore.js";
import { LiveQuotesStrip } from "./components/LiveQuotesStrip.jsx";
import { DeveloperPanel } from "./components/DeveloperPanel.jsx";
import { listenForBackgroundPremarket, listenForBackgroundReviewStatus, listenForDesktopReconcile, reconcileDesktopNow } from "./lib/desktopLifecycle.js";
import { isDesktopRuntime } from "./lib/piRuntime.js";
import { AppErrorBoundary } from "./components/AppErrorBoundary.jsx";
import { CommandPalette } from "./components/CommandPalette.jsx";
import { friendlyDataMessage } from "./lib/friendlyMessages.js";
import { loadRefreshPolicy, refreshPolicyConfig, subscribeRefreshPolicy } from "./lib/refreshPolicy.js";
import { subscribeIntegrationChanges } from "./lib/integrationChanges.js";

// The secondary workspaces are intentionally kept out of the initial route.
// They share one module so switching views still incurs a single, cacheable
// request while the watchlist remains fast on the first load.
const SecondaryViewModule = lazy(() => import("./components/SecondaryViews.jsx").then((module) => ({
  default: ({ view }) => {
    const View = module[view];
    return View ? <View /> : null;
  },
})));

const secondaryViewLoading = <div className="secondary-view-loading" role="status" aria-live="polite">正在打开工作台…</div>;

export function App() {
  const reconcileIntegrationChange = useLabStore((state) => state.reconcileIntegrationChange);
  useEffect(() => subscribeIntegrationChanges(() => { void reconcileIntegrationChange(); }), [reconcileIntegrationChange]);
  const credentialGeneration = useLabStore((state) => state.credentialGeneration);
  const activeView = useLabStore((state) => state.activeView);
  const settingsNotice = useLabStore((state) => state.settingsNotice);
  const clearSettingsNotice = useLabStore((state) => state.clearSettingsNotice);
  const setSettingsNotice = useLabStore((state) => state.setSettingsNotice);
  const retryPersistedUserState = useLabStore((state) => state.retryPersistedUserState);
  const persistenceRetrying = useLabStore((state) => state.persistenceRetrying);
  const hydrateUserState = useLabStore((state) => state.hydrateUserState);
  const hydrateIntegrationStatus = useLabStore((state) => state.hydrateIntegrationStatus);
  const refreshLiveData = useLabStore((state) => state.refreshLiveData);
  const cancelLiveDataRefresh = useLabStore((state) => state.cancelLiveDataRefresh);
  const userStateLoaded = useLabStore((state) => state.userStateLoaded);
  const userStateLoading = useLabStore((state) => state.userStateLoading);
  const userStateError = useLabStore((state) => state.userStateError);
  const integrationStatus = useLabStore((state) => state.integrationStatus);
  const selectedSymbol = useLabStore((state) => state.selectedSymbol);
  const portfolioPositions = useLabStore((state) => state.portfolioPositions);
  const rules = useLabStore((state) => state.rules);
  const runDueMonitorChecks = useLabStore((state) => state.runDueMonitorChecks);
  const runDuePortfolioReview = useLabStore((state) => state.runDuePortfolioReview);
  const runDuePremarketBriefing = useLabStore((state) => state.runDuePremarketBriefing);
  const [refreshPolicy, setRefreshPolicy] = useState(loadRefreshPolicy);
  // A credential replacement must invalidate the current data session even
  // when settings and the displayed prefix stay the same. Successful writes
  // explicitly advance the local generation without retaining the key.
  const integrationRefreshKey = [credentialGeneration, integrationStatus?.credentialConfigured, integrationStatus?.keyPrefix, integrationStatus?.credentialRevision, integrationStatus?.settings?.modelId, integrationStatus?.settings?.modelGatewayBaseUrl, integrationStatus?.settings?.capabilityBaseUrl, integrationStatus?.settings?.dataChannel, integrationStatus?.settings?.dataProvider].join("|");
  const priorityRefreshKey = [selectedSymbol, ...portfolioPositions.map((position) => position.symbol), ...rules.filter((rule) => rule.enabled && rule.scope !== "watchlist").map((rule) => rule.symbol)].filter(Boolean).join("|");
  const pollingChannelRef = useRef("");
  useEffect(() => subscribeRefreshPolicy(setRefreshPolicy), []);
  useEffect(() => {
    void hydrateUserState();
    void hydrateIntegrationStatus();
    const timer = window.setInterval(() => { void runDueMonitorChecks(); }, MONITOR_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [hydrateUserState, runDueMonitorChecks]);
  useEffect(() => {
    if (!userStateLoaded) return undefined;
    if (isDesktopRuntime()) return undefined;
    const reconcile = () => { void runDuePortfolioReview(); void runDuePremarketBriefing(); };
    reconcile();
    const timer = window.setInterval(reconcile, BRIEFING_RECONCILE_INTERVAL_MS);
    const onVisible = () => { if (document.visibilityState === "visible") reconcile(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", reconcile);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); window.removeEventListener("focus", reconcile); };
  }, [userStateLoaded, runDuePortfolioReview, runDuePremarketBriefing]);
  useEffect(() => {
    if (!userStateLoaded || !isDesktopRuntime()) return undefined;
    let disposed = false;
    let unlisten = () => {};
    void listenForBackgroundPremarket(() => {
      void runDuePremarketBriefing().catch((error) => {
        if (!disposed) setSettingsNotice({ type: "error", text: friendlyDataMessage(error, "桌面盘前摘要暂时无法生成，请稍后重试") });
      });
    }).then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    }).catch((error) => {
      if (!disposed) setSettingsNotice({ type: "error", text: friendlyDataMessage(error, "桌面盘前调度事件暂时不可用，请稍后重试") });
    });
    void runDuePremarketBriefing();
    return () => { disposed = true; unlisten(); };
  }, [userStateLoaded, runDuePremarketBriefing, setSettingsNotice]);
  useEffect(() => {
    if (!userStateLoaded) return undefined;
    let disposed = false;
    let unlisten = () => {};
    void listenForDesktopReconcile(() => {
      void reconcileDesktopNow().catch((error) => {
        setSettingsNotice({ type: "error", text: friendlyDataMessage(error, "桌面后台检查暂时失败，请稍后重试") });
      });
    }).then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    }).catch((error) => {
      if (!disposed) setSettingsNotice({ type: "error", text: friendlyDataMessage(error, "桌面驻留事件暂时不可用，请稍后重试") });
    });
    return () => { disposed = true; unlisten(); };
  }, [setSettingsNotice, userStateLoaded]);
  useEffect(() => {
    if (!userStateLoaded) return undefined;
    let disposed = false;
    let unlisten = () => {};
    void listenForBackgroundReviewStatus(() => { void hydrateUserState().catch((error) => setSettingsNotice({ type: "error", text: friendlyDataMessage(error, "后台复盘状态暂时无法刷新，请稍后重试") })); }).then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    }).catch((error) => {
      if (!disposed) setSettingsNotice({ type: "error", text: friendlyDataMessage(error, "后台复盘事件暂时不可用，请稍后重试") });
    });
    return () => { disposed = true; unlisten(); };
  }, [userStateLoaded, hydrateUserState, setSettingsNotice]);
  useEffect(() => {
    if (!userStateLoaded || !integrationStatus?.credentialConfigured) return undefined;
    if (typeof window === "undefined" || typeof document === "undefined") return undefined;
    const policy = refreshPolicyConfig(refreshPolicy);
    if (policy.id === "manual") {
      cancelLiveDataRefresh();
      return undefined;
    }
    const isVisible = () => document.visibilityState !== "hidden";
    const prioritySymbols = [...new Set(priorityRefreshKey.split("|").filter(Boolean))];
    const refreshPriority = () => {
      if (isVisible()) void refreshLiveData({ symbols: prioritySymbols });
    };
    const refreshFull = () => {
      if (isVisible()) void refreshLiveData();
    };
    // A channel change invalidates all cached quotes, so warm the complete
    // watchlist. Selection/position/rule changes only need the low-latency
    // priority tier and should not trigger a second full sweep.
    const channelChanged = pollingChannelRef.current !== integrationRefreshKey;
    pollingChannelRef.current = integrationRefreshKey;
    if (channelChanged) refreshFull();
    else refreshPriority();
    const priorityTimer = window.setInterval(refreshPriority, policy.priorityIntervalMs || LIVE_QUOTE_PRIORITY_REFRESH_INTERVAL_MS);
    const fullTimer = window.setInterval(refreshFull, policy.fullIntervalMs || LIVE_QUOTE_FULL_REFRESH_INTERVAL_MS);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refreshPriority();
    };
    const onWindowFocus = () => refreshPriority();
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onWindowFocus);
    return () => {
      window.clearInterval(priorityTimer);
      window.clearInterval(fullTimer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onWindowFocus);
    };
  }, [userStateLoaded, integrationRefreshKey, priorityRefreshKey, refreshLiveData, refreshPolicy, cancelLiveDataRefresh]);
  const renderSecondaryView = (view, withLiveQuotes = false) => <Suspense fallback={secondaryViewLoading}>
    {withLiveQuotes ? <div className="secondary-view-shell"><LiveQuotesStrip /><SecondaryViewModule view={view} /></div> : <SecondaryViewModule view={view} />}
  </Suspense>;
  const renderView = () => {
    if (activeView === "market") return renderSecondaryView("MarketView", true);
    if (activeView === "research") return renderSecondaryView("ResearchView", true);
    if (activeView === "monitor") return renderSecondaryView("MonitorView", true);
    if (activeView === "events") return renderSecondaryView("EventsView", true);
    if (activeView === "portfolio") return renderSecondaryView("PortfolioView");
    if (activeView === "notifications") return renderSecondaryView("NotificationsView");
    if (activeView === "skills") return renderSecondaryView("SkillsView");
    if (activeView === "chat") return renderSecondaryView("ChatView");
    if (activeView === "settings") return renderSecondaryView("SettingsView");
    return <><WatchlistSidebar /><StockWorkspace /><CopilotPanel /></>;
  };
  const showGlobalNotice = settingsNotice && activeView !== "settings";
  return <AppErrorBoundary><div className={`app-shell view-${activeView}`} data-user-state-loaded={userStateLoaded ? "true" : "false"}>
    <ActivityRail />
    {userStateError && <div className="global-notice error" role="alert" aria-live="assertive"><span>{userStateLoading ? "正在重新读取本地数据…" : userStateError}</span><button disabled={userStateLoading} onClick={() => { void hydrateUserState(); }}>{userStateLoading ? "读取中…" : "重新读取本地数据"}</button></div>}
    {showGlobalNotice && <div className={`global-notice ${settingsNotice.type === "error" ? "error" : "success"}`} role={settingsNotice.type === "error" ? "alert" : "status"} aria-live={settingsNotice.type === "error" ? "assertive" : "polite"}><span>{settingsNotice.text}</span>{settingsNotice.action === "retry" && <button disabled={persistenceRetrying} onClick={() => { void retryPersistedUserState(); }}>{persistenceRetrying ? "保存中…" : "重试保存"}</button>}{settingsNotice.action === "reload" && <button disabled={userStateLoading} onClick={() => { void hydrateUserState(); }}>{userStateLoading ? "读取中…" : "重新读取"}</button>}<button onClick={clearSettingsNotice} aria-label="关闭通知">关闭</button></div>}
    {renderView()}
    <CommandPalette />
    <DeveloperPanel />
  </div></AppErrorBoundary>;
}
