import { Component } from "react";

/**
 * Keeps a component render failure from taking down the entire WebView.
 *
 * The fallback intentionally exposes no exception text: render errors can
 * contain provider responses or user-entered content. Recovery is limited to
 * retrying the tree and, if the tree remains unhealthy, reloading the app.
 */
export class AppErrorBoundary extends Component {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    // Keep diagnostics safe for production logs; never print the error body.
    if (typeof console?.error === "function") console.error("FolioMind render failure", error?.name || "unknown");
  }

  retry = () => {
    this.setState({ failed: false });
  };

  reload = () => {
    if (typeof window?.location?.reload === "function") window.location.reload();
  };

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="app-error-boundary" role="alert" aria-live="assertive">
        <div className="app-error-card">
          <div className="app-error-mark" aria-hidden="true">!</div>
          <h1>页面暂时遇到问题</h1>
          <p>当前视图没有正常加载。你的 API Key、持仓和自选数据不会因此被删除。</p>
          <div className="app-error-actions">
            <button type="button" className="primary-action" onClick={this.retry}>重试</button>
            <button type="button" className="secondary-button" onClick={this.reload}>重新加载应用</button>
          </div>
          <small>如果问题持续，请打开开发者面板查看运行状态。</small>
        </div>
      </main>
    );
  }
}
