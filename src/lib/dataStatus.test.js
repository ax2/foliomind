import { describe, expect, it } from "vitest";
import { DATA_STATES, liveDataStateCopy, resolveLiveDataState } from "./dataStatus.js";

describe("live data status", () => {
  it.each([
    [{ configured: false }, DATA_STATES.NO_CREDENTIAL],
    [{ configured: true, loading: true }, DATA_STATES.LOADING],
    [{ configured: true, error: "timeout" }, DATA_STATES.ERROR],
    [{ configured: true }, DATA_STATES.EMPTY],
    [{ configured: true, receivedCount: 2, totalCount: 4 }, DATA_STATES.PARTIAL],
    [{ configured: true, receivedCount: 4, totalCount: 4 }, DATA_STATES.SUCCESS],
  ])("resolves %o as %s", (input, expected) => {
    expect(resolveLiveDataState(input)).toBe(expected);
  });

  it("keeps partial-data copy explicit about missing values", () => {
    expect(liveDataStateCopy(DATA_STATES.PARTIAL, { receivedCount: 2, totalCount: 5 })).toEqual(expect.objectContaining({
      description: expect.stringContaining("2/5 个标的"),
      action: "retry",
    }));
  });

  it("does not claim more data is missing when every requested symbol has returned", () => {
    expect(liveDataStateCopy(DATA_STATES.LOADING, { receivedCount: 2, totalCount: 2 }).description)
      .toBe("2/2 个标的已返回，正在确认最新数据。");
  });
});
