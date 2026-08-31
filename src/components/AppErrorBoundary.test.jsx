import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppErrorBoundary } from "./AppErrorBoundary.jsx";

describe("AppErrorBoundary", () => {
  afterEach(() => cleanup());

  it("shows safe recovery actions without exposing the exception", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    function Broken() { throw new Error("private response payload"); }

    render(<AppErrorBoundary><Broken /></AppErrorBoundary>);

    expect(screen.getByRole("alert")).toHaveTextContent("页面暂时遇到问题");
    expect(screen.getByRole("alert")).not.toHaveTextContent("private response payload");
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新加载应用" })).toBeInTheDocument();
    expect(errorSpy).toHaveBeenCalledWith("FolioMind render failure", "Error");
    errorSpy.mockRestore();
  });

  it("can reset the failed tree", () => {
    let broken = true;
    function Flaky() {
      if (broken) throw new Error("temporary");
      return <p>已恢复</p>;
    }
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<AppErrorBoundary><Flaky /></AppErrorBoundary>);
    broken = false;
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(screen.getByText("已恢复")).toBeInTheDocument();
    errorSpy.mockRestore();
  });
});
