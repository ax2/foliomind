import { afterEach, expect, it, vi } from "vitest";
import { publishIntegrationChange, subscribeIntegrationChanges } from "./integrationChanges.js";

afterEach(() => vi.unstubAllGlobals());

it("sends only invalidation metadata, ignores its own signal, and closes listeners", () => {
  const channels = [];
  vi.stubGlobal("BroadcastChannel", class {
    constructor() { channels.push(this); }
    close = vi.fn();
    postMessage = vi.fn();
  });
  const changed = vi.fn();
  const dispose = subscribeIntegrationChanges(changed);
  publishIntegrationChange();
  const message = channels[1].postMessage.mock.calls[0][0];
  expect(Object.keys(message).sort()).toEqual(["source", "type"]);
  expect(channels[1].close).toHaveBeenCalledOnce();
  channels[0].onmessage({ data: message });
  channels[0].onmessage({ data: { ...message, type: "unknown" } });
  expect(changed).not.toHaveBeenCalled();
  channels[0].onmessage({ data: { ...message, source: "another-window" } });
  expect(changed).toHaveBeenCalledOnce();
  dispose();
  expect(channels[0].onmessage).toBeNull();
  expect(channels[0].close).toHaveBeenCalledOnce();
});

it("keeps credential operations usable when messaging is unavailable", () => {
  vi.stubGlobal("BroadcastChannel", undefined);
  expect(() => publishIntegrationChange()).not.toThrow();
  expect(() => subscribeIntegrationChanges(vi.fn())()).not.toThrow();
});
