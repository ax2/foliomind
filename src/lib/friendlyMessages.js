const textOf = (error) => String(error instanceof Error ? error.message : error || "").toLowerCase();

export function friendlyDataMessage(error, fallback = "数据暂时未返回，请稍后重试") {
  const text = textOf(error);
  if (!text) return fallback;
  if (/401|403|credential|api key|apikey|密钥|凭据|unauthorized|forbidden/.test(text)) return "数据服务凭据需要重新确认，请到设置中检查配置";
  if (/429|rate.?limit|too many|请求过多/.test(text)) return "请求较多，数据服务正在稍后重试";
  if (/timeout|timed out|超时|aborted|取消/.test(text)) return "数据响应较慢，系统会稍后自动重试";
  if (/host|connection|network|fetch|socket|503|502|500|gateway|上游|服务不可用|无法连接/.test(text)) return "数据服务暂时繁忙，系统会稍后自动重试";
  if (/未返回|empty|no valid|没有真实/.test(text)) return "暂时没有可用数据，系统会稍后再查";
  return fallback;
}

export function friendlySettingsMessage(error) {
  return friendlyDataMessage(error, "设置暂时无法保存，请稍后重试");
}

export function friendlyModelMessage(error, fallback = "模型暂时没有完成响应，请稍后重试") {
  const text = textOf(error);
  if (!text) return fallback;
  if (/401|403|credential|api key|apikey|密钥|凭据|unauthorized|forbidden/.test(text)) return "模型网关凭据需要重新确认，请到设置中检查 API Key";
  if (/429|rate.?limit|too many|请求过多|额度不足/.test(text)) return "模型请求较多或额度不足，请稍后重试或更换模型";
  if (/timeout|timed out|超时/.test(text)) return "模型响应较慢，已停止本次测试；请稍后重试";
  if (/aborted|取消/.test(text)) return "模型连接测试已取消";
  if (/金融工具|工具调用|tool/.test(text)) return "模型测试触发了金融工具，请重试；测试不会接受工具调用结果";
  if (/runtime|pi|host|connection|network|fetch|socket|503|502|500|gateway|上游|服务不可用|无法连接/.test(text)) return "模型运行时暂时不可用，请检查网关地址后重试";
  if (/empty|空|没有返回/.test(text)) return "模型网关已响应，但没有返回可识别内容";
  return fallback;
}
