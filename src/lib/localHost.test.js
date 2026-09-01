import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearLocalHostSession, localHostRequest, LOCAL_HOST_ABORTED } from "./localHost.js";

const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

describe("local Web Host client", () => {
  beforeEach(() => {
    clearLocalHostSession();
    window.sessionStorage.clear();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("pairs once and sends the short-lived token on API requests", async () => {
    fetch
      .mockResolvedValueOnce(response({ token: "fh_test" }))
      .mockResolvedValueOnce(response({ credentialConfigured: true }));

    await expect(localHostRequest("/api/integration/status")).resolves.toEqual({ credentialConfigured: true });
    expect(fetch).toHaveBeenNthCalledWith(1, "http://127.0.0.1:43123/api/session", expect.objectContaining({ headers: expect.objectContaining({ Accept: "application/json" }) }));
    expect(fetch).toHaveBeenNthCalledWith(2, "http://127.0.0.1:43123/api/integration/status", expect.objectContaining({ headers: expect.objectContaining({ "X-FolioMind-Host": "fh_test" }) }));
  });

  it("re-pairs after an expired host session", async () => {
    fetch
      .mockResolvedValueOnce(response({ token: "fh_old" }))
      .mockResolvedValueOnce(response({ error: "expired" }, 401))
      .mockResolvedValueOnce(response({ token: "fh_new" }))
      .mockResolvedValueOnce(response({ ok: true }));

    await expect(localHostRequest("/api/health")).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenNthCalledWith(4, "http://127.0.0.1:43123/api/health", expect.objectContaining({ headers: expect.objectContaining({ "X-FolioMind-Host": "fh_new" }) }));
  });

  it("surfaces a clear error when the local Host is offline", async () => {
    fetch.mockRejectedValue(new TypeError("connection refused"));
    await expect(localHostRequest("/api/integration/status")).rejects.toMatchObject({ code: "LOCAL_HOST_UNAVAILABLE" });
  });

  it("propagates caller cancellation without misreporting a timeout", async () => {
    window.sessionStorage.setItem("foliomind.local-host-token", "fh_test");
    const controller = new AbortController();
    fetch.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      const abort = () => { const error = new Error("aborted"); error.name = "AbortError"; reject(error); };
      if (options.signal.aborted) abort();
      else options.signal.addEventListener("abort", abort, { once: true });
    }));
    const request = localHostRequest("/api/data/query", { signal: controller.signal });
    controller.abort("superseded");
    await expect(request).rejects.toMatchObject({ code: LOCAL_HOST_ABORTED, message: "本次本地数据请求已取消" });
  });
});
