const CHANNEL = "foliomind.integration-changed.v1";
const MESSAGE = "integration-changed";
const source = globalThis.crypto.randomUUID();

// Only an invalidation signal crosses windows. The authenticated Host remains
// the source of credentials and settings; no response payload is broadcast.
export function publishIntegrationChange() {
  let channel;
  try {
    channel = new BroadcastChannel(CHANNEL);
    channel.postMessage({ type: MESSAGE, source });
  } catch { /* Some embedded browsers disable cross-window messaging. */ }
  finally { channel?.close(); }
}

export function subscribeIntegrationChanges(onChange) {
  let channel;
  try {
    channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = (event) => {
      if (event.data?.type === MESSAGE && typeof event.data.source === "string" && event.data.source !== source) onChange();
    };
  } catch { return () => {}; }
  return () => { channel.onmessage = null; channel.close(); };
}
