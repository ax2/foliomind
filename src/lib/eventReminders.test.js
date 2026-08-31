import { describe, expect, it } from "vitest";
import { buildEventReminder, collectEventReminders, eventDateKey, eventReminderKey, eventReminderPhase } from "./eventReminders.js";

describe("real event reminders", () => {
  const event = { symbol: "600519", name: "贵州茅台", date: "2026-09-08", type: "股东会", title: "2026 年第一次临时股东会", source: "真实事件源" };

  it("keeps date-only provider values on the same Shanghai calendar day", () => {
    expect(eventDateKey("2026-09-08")).toBe("2026-09-08");
    expect(eventDateKey("2026-09-08T00:30:00+08:00")).toBe("2026-09-08");
    expect(eventDateKey("2026-02-30")).toBe("");
  });

  it("returns a same-day reminder or a bounded upcoming reminder", () => {
    expect(eventReminderPhase(event, { now: "2026-09-08T01:00:00+08:00" })).toMatchObject({ phase: "same-day", daysUntil: 0, eventDay: "2026-09-08" });
    expect(eventReminderPhase(event, { now: "2026-09-03T09:00:00+08:00" })).toMatchObject({ phase: "upcoming", daysUntil: 5 });
    expect(eventReminderPhase(event, { now: "2026-08-31T09:00:00+08:00" })).toBeNull();
    expect(eventReminderPhase({ ...event, date: "not-a-date" }, { now: "2026-09-03T09:00:00+08:00" })).toBeNull();
  });

  it("deduplicates each event phase while allowing the two planned reminders", () => {
    const upcoming = collectEventReminders([event, { ...event }], [], { now: "2026-09-03T09:00:00+08:00" });
    expect(upcoming).toHaveLength(1);
    expect(upcoming[0]).toMatchObject({ kind: "event", reminderPhase: "upcoming", symbol: "600519", source: "data-service" });
    expect(upcoming[0].body).toContain("还有 5 天");
    const existing = upcoming;
    expect(collectEventReminders([event], existing, { now: "2026-09-03T09:00:00+08:00" })).toEqual([]);
    const sameDay = collectEventReminders([event], existing, { now: "2026-09-08T09:00:00+08:00" });
    expect(sameDay).toHaveLength(1);
    expect(sameDay[0].reminderPhase).toBe("same-day");
  });

  it("uses a stable bounded key and never emits undated events", () => {
    expect(eventReminderKey(event)).toBe("600519|2026-09-08|股东会|2026 年第一次临时股东会");
    expect(buildEventReminder({ symbol: "600519", title: "没有日期" }, { phase: "upcoming", daysUntil: 3 }, { now: "2026-09-03T00:00:00+08:00" })).toMatchObject({ reminderPhase: "upcoming" });
    expect(collectEventReminders([{ symbol: "600519", title: "没有日期" }], [], { now: "2026-09-03T00:00:00+08:00" })).toEqual([]);
  });
});

