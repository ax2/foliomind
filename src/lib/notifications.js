const csvCell = (value) => {
  const text = String(value ?? "").replace(/\r?\n/g, " ");
  return /[",]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const notificationKindLabel = (kind) => ({
  monitor: "盯盘",
  "portfolio-alert": "组合提醒",
  event: "事件提醒",
  briefing: "摘要",
})[kind] || "消息";

export function notificationCsv(items = []) {
  const rows = [
    ["时间", "类型", "级别", "状态", "代码", "标题", "内容", "来源"],
    ...((Array.isArray(items) ? items : []).map((item) => [
      item?.createdAt || "",
      notificationKindLabel(item?.kind),
      item?.severity || "info",
      item?.read === true ? "已读" : "未读",
      item?.symbol || "",
      item?.title || "",
      item?.body || "",
      item?.source || "",
    ])),
  ];
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}
