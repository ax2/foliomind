const pad = (value) => String(value).padStart(2, "0");
const EVENT_TIME_ZONE = "Asia/Shanghai";

function dateKeyFromTimestamp(value) {
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(String(value ?? ""));
  if (!Number.isFinite(timestamp)) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: EVENT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp)).filter((part) => part.type !== "literal");
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return values.year && values.month && values.day ? `${values.year}-${values.month}-${values.day}` : "";
}

/**
 * Keep provider date-only values as calendar dates. Parsing `YYYY-MM-DD` with
 * `new Date()` uses UTC and can move the event to the previous day for users
 * west of UTC, so date-only values are handled explicitly.
 */
export function eventDateKey(value) {
  const text = String(value ?? "").trim();
  const match = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(year, month - 1, day);
    if (date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day) return `${year}-${pad(month)}-${pad(day)}`;
  }
  return dateKeyFromTimestamp(text);
}

export function monthKey(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
}

export function monthCursorFromKey(value) {
  const match = String(value ?? "").match(/^(\d{4})-(\d{2})$/);
  if (!match) return new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  return new Date(year, month - 1, 1);
}

export function shiftMonth(cursor, offset) {
  return new Date(cursor.getFullYear(), cursor.getMonth() + Number(offset || 0), 1);
}

export function monthLabel(cursor, locale = "zh-CN") {
  return cursor.toLocaleDateString(locale, { year: "numeric", month: "long" });
}

export function buildMonthGrid(cursor) {
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  // Convert Sunday-first browser indexing to a Monday-first calendar.
  const mondayOffset = (first.getDay() + 6) % 7;
  const start = new Date(cursor.getFullYear(), cursor.getMonth(), 1 - mondayOffset);
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index);
    return {
      date,
      key: eventDateKey(`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`),
      inMonth: date.getMonth() === cursor.getMonth() && date.getFullYear() === cursor.getFullYear(),
      isToday: eventDateKey(date) === eventDateKey(new Date()),
    };
  });
}

export function eventsByDate(events = []) {
  const grouped = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    const key = eventDateKey(event?.date);
    if (!key) continue;
    const values = grouped.get(key) || [];
    values.push(event);
    grouped.set(key, values);
  }
  return grouped;
}
