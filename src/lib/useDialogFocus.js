import { useEffect, useRef } from "react";

const FOCUSABLE_SELECTOR = "button, input, select, textarea, a[href], [tabindex]:not([tabindex=\"-1\"]), [contenteditable=\"true\"]";

function focusableElements(dialog) {
  if (!dialog) return [];
  return [...dialog.querySelectorAll(FOCUSABLE_SELECTOR)].filter((element) => {
    if (element.hasAttribute("disabled") || element.getAttribute("aria-hidden") === "true") return false;
    const style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  });
}

/** Keep modal keyboard focus contained and return it to the opening control. */
export function useDialogFocus(open, onClose) {
  const dialogRef = useRef(null);
  const returnFocusRef = useRef(null);
  const lastOutsideFocusRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const captureFocus = () => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body) returnFocusRef.current = active;
  };

  useEffect(() => {
    const onFocusIn = (event) => {
      if (!dialogRef.current?.contains(event.target)) lastOutsideFocusRef.current = event.target;
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, []);

  useEffect(() => {
    if (!open) {
      const target = returnFocusRef.current;
      returnFocusRef.current = null;
      if (target?.isConnected) window.requestAnimationFrame(() => target.focus());
      return undefined;
    }

    const active = document.activeElement;
    const captured = returnFocusRef.current;
    const candidate = captured && !dialogRef.current?.contains(captured)
      ? captured
      : dialogRef.current?.contains(active) ? lastOutsideFocusRef.current : active;
    returnFocusRef.current = candidate instanceof HTMLElement && candidate !== document.body ? candidate : null;
    const initialFocus = window.requestAnimationFrame(() => {
      const first = dialogRef.current?.querySelector("[autofocus]") || focusableElements(dialogRef.current)[0];
      first?.focus();
    });
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current?.();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = focusableElements(dialogRef.current);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(initialFocus);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return { dialogRef, captureFocus };
}
