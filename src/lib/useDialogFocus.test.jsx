import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useRef, useState } from "react";
import { useDialogFocus } from "./useDialogFocus.js";

afterEach(cleanup);

function DialogHarness() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef(null);
  const { dialogRef, captureFocus } = useDialogFocus(open, () => setOpen(false));
  return <>
    <button ref={triggerRef} type="button" onClick={() => { triggerRef.current?.focus(); captureFocus(); setOpen(true); }}>打开弹窗</button>
    {open ? <section ref={dialogRef} role="dialog" aria-modal="true">
      <button type="button" aria-label="关闭弹窗" onClick={() => setOpen(false)}>关闭</button>
      <input aria-label="弹窗输入" autoFocus />
      <button type="button">确认</button>
    </section> : null}
  </>;
}

describe("useDialogFocus", () => {
  it("traps Tab, focuses the dialog and restores the trigger", async () => {
    render(<DialogHarness />);
    const trigger = screen.getByRole("button", { name: "打开弹窗" });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog");
    const input = screen.getByRole("textbox", { name: "弹窗输入" });
    expect(input).toHaveFocus();
    const confirm = screen.getByRole("button", { name: "确认" });
    confirm.focus();
    fireEvent.keyDown(confirm, { key: "Tab" });
    expect(screen.getByRole("button", { name: "关闭弹窗" })).toHaveFocus();
    const close = screen.getByRole("button", { name: "关闭弹窗" });
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(confirm).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Escape" });
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(trigger).toHaveFocus();
  });
});
