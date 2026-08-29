import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({
  clearDeveloperLogs: vi.fn().mockResolvedValue({ cleared: true }),
  loadDeveloperOverview: vi.fn().mockResolvedValue({ logs: [{ id: "1", at: "2026-08-29T03:00:00Z", method: "POST", path: "/api/data/query", status: 200, durationMs: 42 }], state: { activeRequest: false, keyPrefix: "cap_demo…", settings: { modelId: "model-a" }, toolCache: [{ kind: "quote" }] }, variables: { toolCacheEnabled: true, requestTimeoutMs: 120000, maxConcurrentDataRequests: 1, logLevel: "info" } }),
  updateDeveloperVariables: vi.fn().mockResolvedValue({ variables: { toolCacheEnabled: false, requestTimeoutMs: 120000, maxConcurrentDataRequests: 1, logLevel: "info" } }),
}));
vi.mock("../lib/localHost.js", () => ({ ...host, isLocalWebRuntime: () => true }));
import { DeveloperPanel } from "./DeveloperPanel.jsx";

describe("DeveloperPanel", () => {
  it("stays collapsed until opened and exposes redacted diagnostics", async () => {
    render(<DeveloperPanel />);
    expect(screen.queryByText(/\/api\/data\/query/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /开发者面板/ }));
    expect(await screen.findByText(/\/api\/data\/query/)).toBeInTheDocument();
    expect(screen.getByText("cap_demo…")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "启用工具固化缓存" }));
    await waitFor(() => expect(host.updateDeveloperVariables).toHaveBeenCalledWith({ toolCacheEnabled: false }));
  });
});
