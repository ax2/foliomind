import { describe, expect, it } from "vitest";
import { DATA_STATES, hasModelAccess, hasRealDataAccess, liveDataStateCopy, resolveLiveDataState } from "./dataStatus.js";

describe("live data status", () => {
  it("treats the CAP credential and model selection as independent access gates", () => {
    expect(hasRealDataAccess({ credentialConfigured: true, settings: { modelId: "" } })).toBe(true);
    expect(hasModelAccess({ credentialConfigured: true, settings: { modelId: "" } })).toBe(false);
    expect(hasRealDataAccess({ credentialConfigured: false, settings: { modelId: "model-a" } })).toBe(false);
    expect(hasModelAccess({ credentialConfigured: true, settings: { modelId: "model-a" } })).toBe(true);
  });

  it.each([
    [{ configured: false }, DATA_STATES.NO_CREDENTIAL],
    [{ configured: true, loading: true }, DATA_STATES.LOADING],
    [{ configured: true, error: "timeout" }, DATA_STATES.ERROR],
    [{ configured: true }, DATA_STATES.EMPTY],
    [{ configured: true, receivedCount: 2, totalCount: 4 }, DATA_STATES.PARTIAL],
    [{ configured: true, receivedCount: 4, totalCount: 4, staleCount: 4 }, DATA_STATES.STALE],
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

  it("keeps stale data distinct from a fresh successful sweep", () => {
    expect(liveDataStateCopy(DATA_STATES.STALE, { receivedCount: 2, totalCount: 2 })).toEqual(expect.objectContaining({
      title: "行情可能已延迟",
      description: expect.stringContaining("超过新鲜度阈值"),
      action: "retry",
    }));
    expect(resolveLiveDataState({ configured: true, receivedCount: 2, totalCount: 3, staleCount: 2 })).toBe(DATA_STATES.PARTIAL);
  });
});
