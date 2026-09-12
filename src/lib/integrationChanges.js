const CHANNEL = "foliomind.integration-changed.v1";
const STORAGE_KEY = "foliomind.integration-changed.v1";
const MESSAGE = "integration-changed";
const randomId = (prefix) => typeof globalThis.crypto?.randomUUID === "function"
  ? `${prefix}-${globalThis.crypto.randomUUID()}`
  : `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const source = randomId("window");

function changeMessage() {
  return { type: MESSAGE, source, id: randomId("change") };
}

function isChangeMessage(value) {
  return value?.type === MESSAGE
    && typeof value.source === "string"
    && value.source !== source
    && typeof value.id === "string";
}

// Only an invalidation signal crosses windows. The authenticated Host remains
// the source of credentials and settings; no response payload is broadcast.
// BroadcastChannel is preferred, while localStorage is a same-origin fallback
// for embedded WebViews that expose storage events but not BroadcastChannel.
export function publishIntegrationChange() {
  const message = changeMessage();
  let channel;
  try {
    if (typeof BroadcastChannel === "function") {
      channel = new BroadcastChannel(CHANNEL);
      channel.postMessage(message);
    }
  } catch { /* Some embedded browsers disable cross-window messaging. */ }
  finally { channel?.close(); }
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(message));
    globalThis.localStorage?.removeItem(STORAGE_KEY);
  } catch { /* Private or restricted storage is optional. */ }
}

export function subscribeIntegrationChanges(onChange) {
  let channel;
  const seen = new Set();
  const notify = (value) => {
    if (!isChangeMessage(value) || seen.has(value.id)) return;
    seen.add(value.id);
    if (seen.size > 32) seen.delete(seen.values().next().value);
    onChange();
  };
  try {
    if (typeof BroadcastChannel === "function") {
      channel = new BroadcastChannel(CHANNEL);
      channel.onmessage = (event) => notify(event.data);
    }
  } catch { channel = undefined; }
  const onStorage = (event) => {
    if (event.key !== STORAGE_KEY || !event.newValue) return;
    try { notify(JSON.parse(event.newValue)); } catch { /* Ignore malformed optional signals. */ }
  };
  if (typeof window === "undefined") return () => { if (channel) { channel.onmessage = null; channel.close(); } };
  window.addEventListener("storage", onStorage);
  return () => {
    if (channel) { channel.onmessage = null; channel.close(); }
    window.removeEventListener("storage", onStorage);
  };
}
