import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  desktop: vi.fn(),
  invoke: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("./piRuntime.js", () => ({ isDesktopRuntime: mocks.desktop }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));

import { listenForDesktopReconcile, loadDesktopLifecycleStatus, reconcileDesktopNow } from "./desktopLifecycle.js";

describe("desktop resident lifecycle bridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.desktop.mockReturnValue(true);
  });

  it("uses typed lifecycle commands only in desktop runtime", async () => {
    mocks.invoke.mockResolvedValue({ residentMode: true, hiddenToTray: false });
    await expect(loadDesktopLifecycleStatus()).resolves.toMatchObject({ residentMode: true });
    await reconcileDesktopNow();
    expect(mocks.invoke.mock.calls.map(([command]) => command)).toEqual(["desktop_lifecycle_status", "desktop_reconcile_now"]);
    mocks.desktop.mockReturnValue(false);
    await expect(loadDesktopLifecycleStatus()).rejects.toThrow("仅在桌面版");
  });

  it("forwards native reconcile events and returns the unlisten handle", async () => {
    const unlisten = vi.fn();
    let listener;
    mocks.listen.mockImplementation(async (_event, callback) => { listener = callback; return unlisten; });
    const handler = vi.fn();
    await expect(listenForDesktopReconcile(handler)).resolves.toBe(unlisten);
    listener();
    expect(mocks.listen).toHaveBeenCalledWith("foliomind://background-reconcile", expect.any(Function));
    expect(handler).toHaveBeenCalledOnce();
  });
});
