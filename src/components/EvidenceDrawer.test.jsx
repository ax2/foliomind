import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { EvidenceDrawer } from "./EvidenceDrawer.jsx";

describe("EvidenceDrawer", () => {
  afterEach(() => cleanup());
  it("shows source, freshness and missing fields without inventing values", () => {
    render(<EvidenceDrawer
      open
      onClose={vi.fn()}
      quote={{ price: 1297.4, change: 0.39, asOf: "2026-08-30T10:00:00Z", source: "真实 CAP", previousClose: 1292.3 }}
      symbol="600519"
      name="贵州茅台"
      market="沪深"
      provider="qveris_finance"
      channel="qveris-cap"
      lastRefreshAt="2026-08-30T10:01:00Z"
      onRefresh={vi.fn()}
    />);

    expect(screen.getByRole("dialog", { name: "行情证据" })).toHaveTextContent("真实 CAP");
    expect(screen.getByRole("dialog")).toHaveTextContent("MKT.L1.RT");
    expect(screen.getByRole("dialog")).toHaveTextContent("北京时间");
    expect(screen.getByRole("dialog")).toHaveTextContent("3/10 项");
    expect(screen.getByText(/缺失字段保持为空/)).toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("closes on Escape and exposes a retry action", () => {
    const onClose = vi.fn();
    const onRefresh = vi.fn();
    render(<EvidenceDrawer open onClose={onClose} onRefresh={onRefresh} quote={null} symbol="AAPL" name="Apple" />);
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "重新获取当前行情" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("keeps keyboard focus in the drawer and restores the trigger", async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return <>
        <button type="button" onClick={() => setOpen(true)}>打开行情证据</button>
        <EvidenceDrawer open={open} onClose={() => setOpen(false)} onRefresh={vi.fn()} quote={null} symbol="AAPL" />
      </>;
    }
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "打开行情证据" });
    trigger.focus();
    fireEvent.click(trigger);
    const drawer = screen.getByRole("dialog", { name: "行情证据" });
    const buttons = screen.getAllByRole("button");
    const refresh = screen.getByRole("button", { name: "重新获取当前行情" });
    refresh.focus();
    fireEvent.keyDown(refresh, { key: "Tab" });
    expect(buttons.find((button) => button.getAttribute("aria-label") === "关闭行情证据")).toHaveFocus();
    const close = screen.getByRole("button", { name: "关闭行情证据" });
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(refresh).toHaveFocus();
    fireEvent.keyDown(drawer, { key: "Escape" });
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(trigger).toHaveFocus();
  });
});
