export const DATA_STATES = Object.freeze({
  LOADING: "loading",
  NO_CREDENTIAL: "no-credential",
  EMPTY: "empty",
  ERROR: "error",
  PARTIAL: "partial",
  STALE: "stale",
  SUCCESS: "success",
});

/**
 * CAP data and model chat are separate capabilities. A saved credential is
 * sufficient for real market pages; a model selection is only required when
 * the user starts an Agent conversation.
 */
export function hasRealDataAccess(integrationStatus) {
  return Boolean(integrationStatus?.credentialConfigured);
}

export function hasModelAccess(integrationStatus) {
  return Boolean(integrationStatus?.credentialConfigured && integrationStatus?.settings?.modelId);
}

export function resolveLiveDataState({ configured, loading, error, receivedCount = 0, totalCount = 0, staleCount = 0 }) {
  if (!configured) return DATA_STATES.NO_CREDENTIAL;
  if (loading) return DATA_STATES.LOADING;
  if (receivedCount <= 0 && error) return DATA_STATES.ERROR;
  if (receivedCount <= 0 || totalCount <= 0) return DATA_STATES.EMPTY;
  if (error || receivedCount < totalCount) return DATA_STATES.PARTIAL;
  if (staleCount > 0) return DATA_STATES.STALE;
  return DATA_STATES.SUCCESS;
}

export function liveDataStateCopy(state, { receivedCount = 0, totalCount = 0 } = {}) {
  const coverage = totalCount > 0 ? `${receivedCount}/${totalCount} 个标的` : "当前范围";
  if (state === DATA_STATES.NO_CREDENTIAL) return {
    title: "连接真实数据后开始",
    description: "请先在设置中保存 API Key 并应用；如需使用 Agent 对话，再同步并选择模型。页面不会使用示例行情填充。",
    action: "settings",
  };
  if (state === DATA_STATES.LOADING) return {
    title: "正在获取真实行情",
    description: receivedCount > 0
      ? totalCount > 0 && receivedCount >= totalCount
        ? `${coverage}已返回，正在确认最新数据。`
        : `${coverage}已返回，其他数据会继续补齐。`
      : "正在连接已配置的数据渠道，请稍候。",
    action: "none",
  };
  if (state === DATA_STATES.ERROR) return {
    title: "暂时无法获取行情",
    description: "数据渠道暂未返回可用结果，可以立即重试；详细调用状态可在开发面板查看。",
    action: "retry",
  };
  if (state === DATA_STATES.EMPTY) return {
    title: "尚无可用行情",
    description: "当前渠道没有返回这些标的的数据，系统会稍后自动重试。",
    action: "retry",
  };
  if (state === DATA_STATES.PARTIAL) return {
    title: "部分行情暂未更新",
    description: `${coverage}已返回；缺失值保持为空，不参与组合和研究计算。`,
    action: "retry",
  };
  if (state === DATA_STATES.STALE) return {
    title: "行情可能已延迟",
    description: `${coverage}已返回，但数据时间超过新鲜度阈值；刷新后再使用这些数值。`,
    action: "retry",
  };
  return {
    title: "真实行情已更新",
    description: `${coverage}已返回。`,
    action: "none",
  };
}
