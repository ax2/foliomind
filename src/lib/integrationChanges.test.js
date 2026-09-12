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
  expect(Object.keys(message).sort()).toEqual(["id", "source", "type"]);
  expect(channels[1].close).toHaveBeenCalledOnce();
  channels[0].onmessage({ data: message });
  channels[0].onmessage({ data: { ...message, type: "unknown" } });
  expect(changed).not.toHaveBeenCalled();
  channels[0].onmessage({ data: { ...message, source: "another-window" } });
  expect(changed).toHaveBeenCalledOnce();
  window.dispatchEvent(new StorageEvent("storage", { key: "foliomind.integration-changed.v1", newValue: JSON.stringify({ ...message, source: "another-window" }) }));
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

it("uses the same-origin storage event fallback and ignores malformed payloads", () => {
  vi.stubGlobal("BroadcastChannel", undefined);
  const localStorage = { setItem: vi.fn(), removeItem: vi.fn() };
  vi.stubGlobal("localStorage", localStorage);
  const changed = vi.fn();
  const dispose = subscribeIntegrationChanges(changed);
  publishIntegrationChange();
  const payload = JSON.parse(localStorage.setItem.mock.calls[0][1]);
  expect(Object.keys(payload).sort()).toEqual(["id", "source", "type"]);
  window.dispatchEvent(new StorageEvent("storage", { key: "foliomind.integration-changed.v1", newValue: "not-json" }));
  window.dispatchEvent(new StorageEvent("storage", { key: "foliomind.integration-changed.v1", newValue: JSON.stringify({ ...payload, source: "other-window" }) }));
  expect(changed).toHaveBeenCalledOnce();
  dispose();
});
