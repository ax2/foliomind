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

