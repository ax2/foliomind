import { describe, expect, it } from "vitest";
import { capabilityArray, capabilityData, capabilityExplicitFailure, capabilitySource, capabilityStatusCode } from "./capabilityEnvelope.js";

describe("capability envelope", () => {
  it("unwraps the same bounded envelope used by web and desktop data paths", () => {
    const response = {
      success: true,
      result: { payload: { data: { bars: [{ date: "2026-09-05", close: 12.3 }], _meta: { source: "qveris_finance" } } } },
    };
    expect(capabilityData(response)).toEqual({ bars: [{ date: "2026-09-05", close: 12.3 }], _meta: { source: "qveris_finance" } });
    expect(capabilityArray(response, ["bars", "items"])).toHaveLength(1);
    expect(capabilitySource(response)).toBe("qveris_finance");
  });

  it("keeps arbitrary debug objects from being mistaken for the data payload", () => {
    const response = { result: { payload: { data: { rows: [{ id: 1 }] } } }, debug: { price: 0 } };
    expect(capabilityData(response)).toMatchObject({ rows: [{ id: 1 }] });
    expect(capabilityData({ result: { nested: { price: 99 } }, debug: { price: 1 } })).toEqual({ nested: { price: 99 } });
  });

  it("propagates nested status and explicit failures without trusting outer success", () => {
    const response = { result: { payload: { data: { statusCode: "503", success: false } } } };
    expect(capabilityStatusCode(response)).toBe(503);
    expect(capabilityExplicitFailure(response)).toBe(true);
  });
});
