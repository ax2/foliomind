export const BRIEFING_TIME_ZONE = "Asia/Shanghai";
export const DEFAULT_BRIEFING_SCHEDULE = Object.freeze({ enabled: false, closeTime: "15:35", timeZone: BRIEFING_TIME_ZONE, retryMinutes: 15, lastAttemptAt: "", lastSuccessKey: "", lastResult: "idle", lastError: "", calendarDate: "", calendarStatus: "unknown", calendarCheckedAt: "", calendarSource: "", calendarToolId: "" });

const RESULT_STATES = new Set(["idle", "success", "waiting-data", "waiting-calendar", "market-closed", "error"]);
const CALENDAR_STATES = new Set(["unknown", "trading", "closed", "error"]);

function dateParts(value, timeZone = BRIEFING_TIME_ZONE) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const values = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return { day: `${values.year}-${values.month}-${values.day}`, weekday: values.weekday, minutes: Number(values.hour) * 60 + Number(values.minute) };
}

export function normalizeBriefingSchedule(value = {}) {
  const closeTime = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value?.closeTime || "")) ? String(value.closeTime) : DEFAULT_BRIEFING_SCHEDULE.closeTime;
  const retry = Number(value?.retryMinutes);
  return {
    enabled: value?.enabled === true, closeTime, timeZone: BRIEFING_TIME_ZONE,
    retryMinutes: Number.isInteger(retry) ? Math.min(60, Math.max(5, retry)) : DEFAULT_BRIEFING_SCHEDULE.retryMinutes,
    lastAttemptAt: String(value?.lastAttemptAt || "").slice(0, 64), lastSuccessKey: String(value?.lastSuccessKey || "").slice(0, 128),
    lastResult: RESULT_STATES.has(value?.lastResult) ? value.lastResult : "idle", lastError: String(value?.lastError || "").trim().slice(0, 512),
    calendarDate: /^\d{4}-\d{2}-\d{2}$/.test(String(value?.calendarDate || "")) ? String(value.calendarDate) : "",
    calendarStatus: CALENDAR_STATES.has(value?.calendarStatus) ? value.calendarStatus : "unknown",
    calendarCheckedAt: String(value?.calendarCheckedAt || "").slice(0, 64), calendarSource: String(value?.calendarSource || "").slice(0, 128), calendarToolId: String(value?.calendarToolId || "").slice(0, 256),
  };
}

export function briefingSlot({ now = new Date(), schedule = DEFAULT_BRIEFING_SCHEDULE, reviews = [], positionCount = 0 } = {}) {
  const config = normalizeBriefingSchedule(schedule);
  const local = dateParts(now, config.timeZone);
  if (!local) return { status: "invalid-time" };
  const key = `close:${local.day}`;
  if (!config.enabled) return { status: "disabled", key, tradingDate: local.day };
  if (!positionCount) return { status: "no-positions", key, tradingDate: local.day };
  const [hour, minute] = config.closeTime.split(":").map(Number);
  if (local.minutes < hour * 60 + minute) return { status: "not-due", key, tradingDate: local.day };
  if (config.lastSuccessKey === key || reviews.some((review) => review?.kind === "close" && review?.tradingDate === local.day)) return { status: "completed", key, tradingDate: local.day };
  if (config.calendarDate !== local.day || !["trading", "closed"].includes(config.calendarStatus)) return { status: "calendar-needed", key, tradingDate: local.day };
  if (config.calendarStatus === "closed") return { status: "market-closed", key, tradingDate: local.day };
  const lastAttempt = Date.parse(config.lastAttemptAt);
  if (Number.isFinite(lastAttempt) && new Date(now).getTime() - lastAttempt < config.retryMinutes * 60_000) return { status: "retry-wait", key, tradingDate: local.day };
  return { status: "due", key, tradingDate: local.day };
}

export function hasFreshPortfolioQuote({ positions = [], liveQuotes = {}, now = new Date(), timeZone = BRIEFING_TIME_ZONE } = {}) {
  const today = dateParts(now, timeZone)?.day;
  if (!today) return false;
  return positions.some((position) => {
    const quote = liveQuotes[position?.symbol];
    return Number.isFinite(Number(quote?.price)) && dateParts(quote?.asOf, timeZone)?.day === today;
  });
}

export function nextBriefingLabel(schedule, now = new Date()) {
  const config = normalizeBriefingSchedule(schedule);
  if (!config.enabled) return "未启用";
  const local = dateParts(now, config.timeZone);
  if (!local) return `交易日 ${config.closeTime}`;
  return `交易日 ${config.closeTime}（北京时间）`;
}
