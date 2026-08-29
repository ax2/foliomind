import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DataState } from "./DataState.jsx";

describe("DataState", () => {
  it("announces a loading state without exposing a dead action", () => {
    render(<DataState state="loading" title="正在获取真实行情" description="请稍候" />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-busy", "true");
    expect(status).toHaveTextContent("正在获取真实行情");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("announces an error and runs its recovery action", () => {
    const onAction = vi.fn();
    render(<DataState state="error" title="暂时无法获取行情" description="可以重试" actionLabel="立即重试" onAction={onAction} />);
    expect(screen.getByRole("alert")).toHaveTextContent("暂时无法获取行情");
    fireEvent.click(screen.getByRole("button", { name: "立即重试" }));
    expect(onAction).toHaveBeenCalledOnce();
  });
});
