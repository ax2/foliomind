const SHANGHAI_TIME_ZONE = "Asia/Shanghai";
const DAY_MS = 86_400_000;

export const EVENT_REMINDER_WINDOW_DAYS = 7;
export const EVENT_REMINDER_PHASES = Object.freeze({ UPCOMING: "upcoming", SAME_DAY: "same-day" });

function text(value, max = 512) {
  return String(value ?? "").trim().slice(0, max);
}

function dateKeyFromParts(value, timeZone = SHANGHAI_TIME_ZONE) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date).filter((part) => part.type !== "literal");
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return values.year && values.month && values.day ? `${values.year}-${values.month}-${values.day}` : "";
}

/**
 * Normalize a provider event date without allowing JavaScript's UTC parsing of
 * a date-only string to move it to the previous day in Shanghai.
 */
export function eventDateKey(value, timeZone = SHANGHAI_TIME_ZONE) {
  const raw = text(value, 128);
  const dateOnly = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|[T\s])/);
  if (dateOnly) {
    const [, year, month, day] = dateOnly;
    const candidate = `${year}-${month}-${day}`;
    const parsed = Date.UTC(Number(year), Number(month) - 1, Number(day));
    return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === candidate ? candidate : "";
  }
  return dateKeyFromParts(raw, timeZone);
}

function dayNumber(key) {
  const match = String(key || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const value = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isFinite(value) ? value : null;
}

function stableHash(value) {
  let hash = 2166136261;
  for (const character of String(value || "")) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function eventReminderPhase(event, { now = new Date(), windowDays = EVENT_REMINDER_WINDOW_DAYS, timeZone = SHANGHAI_TIME_ZONE } = {}) {
  const eventDay = eventDateKey(event?.date, timeZone);
  const today = eventDateKey(now, timeZone);
  const eventNumber = dayNumber(eventDay);
  const todayNumber = dayNumber(today);
  if (eventNumber == null || todayNumber == null) return null;
  const daysUntil = Math.round((eventNumber - todayNumber) / DAY_MS);
  if (daysUntil === 0) return { phase: EVENT_REMINDER_PHASES.SAME_DAY, daysUntil, eventDay };
  const limit = Number.isInteger(windowDays) ? Math.max(1, windowDays) : EVENT_REMINDER_WINDOW_DAYS;
  if (daysUntil > 0 && daysUntil <= limit) return { phase: EVENT_REMINDER_PHASES.UPCOMING, daysUntil, eventDay };
  return null;
}

export function eventReminderKey(event) {
  const symbol = text(event?.symbol, 64).toUpperCase();
  const date = eventDateKey(event?.date);
  const type = text(event?.type || "其他", 64);
  const title = text(event?.title || event?.detail || "未命名事件", 256);
  return `${symbol}|${date}|${type}|${title}`.slice(0, 512);
}

export function buildEventReminder(event, reminder, { now = new Date() } = {}) {
  if (!event || !reminder?.phase) return null;
  const name = text(event.name || event.symbol || "自选标的", 128);
  const symbol = text(event.symbol, 64).toUpperCase();
  const title = text(event.title || event.detail || "未命名事件", 256);
  const source = text(event.source || "数据服务", 128);
  const date = reminder.eventDay || eventDateKey(event.date);
  const isSameDay = reminder.phase === EVENT_REMINDER_PHASES.SAME_DAY;
  const lead = isSameDay ? "今天" : `还有 ${reminder.daysUntil} 天`;
  const created = now instanceof Date ? now : new Date(now);
  return {
    id: `event-reminder-${stableHash(`${eventReminderKey(event)}|${reminder.phase}`)}`,
    kind: "event",
    symbol,
    name,
    ruleId: "",
    eventKey: eventReminderKey(event),
    reminderPhase: reminder.phase,
    title: `${name} · ${isSameDay ? "事件今日提醒" : "事件提前提醒"}`,
    body: `${lead}（${date}）有${event.type ? `“${text(event.type, 64)}”` : "一项"}：${title}。来源：${source}。仅作信息提示，不构成投资建议。`,
    severity: isSameDay ? "warning" : "info",
    createdAt: Number.isFinite(created.getTime()) ? created.toISOString() : new Date().toISOString(),
    read: false,
    source: "data-service",
  };
}

/**
 * Return only newly due reminders. Existing eventKey + phase pairs are
 * idempotent, so repeated event refreshes cannot spam the notification center.
 */
export function collectEventReminders(events, notifications = [], options = {}) {
  const existing = new Set((Array.isArray(notifications) ? notifications : []).map((item) => `${text(item?.eventKey, 512)}|${text(item?.reminderPhase, 32)}`).filter((key) => key !== "|"));
  const emitted = new Set();
  const reminders = [];
  for (const event of Array.isArray(events) ? events : []) {
    if (!text(event?.symbol, 64) || !eventDateKey(event?.date, options.timeZone || SHANGHAI_TIME_ZONE)) continue;
    const due = eventReminderPhase(event, options);
    if (!due) continue;
    const eventKey = eventReminderKey(event);
    const dedupeKey = `${eventKey}|${due.phase}`;
    if (existing.has(dedupeKey) || emitted.has(dedupeKey)) continue;
    const reminder = buildEventReminder(event, due, options);
    if (reminder) {
      emitted.add(dedupeKey);
      reminders.push(reminder);
    }
  }
  return reminders;
}
