import { describe, expect, it } from "vitest";
import { buildMonthGrid, eventDateKey, eventsByDate, monthCursorFromKey, monthKey, shiftMonth } from "./eventCalendar.js";

describe("event calendar helpers", () => {
  it("keeps provider date-only values on their stated day", () => {
    expect(eventDateKey("2026-09-01")).toBe("2026-09-01");
    expect(eventDateKey("2026/09/01 09:30:00")).toBe("2026-09-01");
    expect(eventDateKey("not-a-date")).toBe("");
  });

  it("builds a Monday-first six-week grid", () => {
    const cursor = monthCursorFromKey("2026-09");
    const grid = buildMonthGrid(cursor);
    expect(grid).toHaveLength(42);
    expect(grid[0].key).toBe("2026-08-31");
    expect(grid.find((cell) => cell.key === "2026-09-01").inMonth).toBe(true);
    expect(grid.filter((cell) => cell.inMonth)).toHaveLength(30);
  });

  it("groups only dated events and shifts months without mutating the cursor", () => {
    const cursor = monthCursorFromKey("2026-12");
    expect(monthKey(cursor)).toBe("2026-12");
    expect(monthKey(shiftMonth(cursor, 1))).toBe("2027-01");
    const grouped = eventsByDate([{ id: "a", date: "2026-09-01" }, { id: "b", date: "2026-09-01T09:00:00+08:00" }, { id: "c", date: "" }]);
    expect(grouped.get("2026-09-01")).toHaveLength(2);
    expect(grouped.has("")).toBe(false);
  });
});
