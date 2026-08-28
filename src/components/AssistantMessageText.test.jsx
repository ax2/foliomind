import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const opener = vi.hoisted(() => ({ openUrl: vi.fn() }));

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: opener.openUrl }));
import { AssistantMessageText } from "./AssistantMessageText.jsx";

afterEach(() => {
  cleanup();
  delete window.__TAURI_INTERNALS__;
  opener.openUrl.mockReset();
});

describe("assistant message markdown", () => {
  it("renders financial report structure with safe external links", async () => {
    render(<AssistantMessageText text={`## 核心结论

- 收入同比增长 **12%**
- 风险等级：中

| 指标 | 数值 |
| --- | ---: |
| ROE | 18.5% |

[数据来源](https://example.com/source)`} />);

    expect(await screen.findByRole("heading", { level: 2, name: "核心结论" })).toBeInTheDocument();
    expect(screen.getByText("12%")).toHaveProperty("tagName", "STRONG");
    expect(screen.getByRole("table")).toHaveTextContent("ROE18.5%");
    expect(screen.getByRole("link", { name: "数据来源" })).toHaveAttribute("target", "_blank");
    expect(screen.getByRole("link", { name: "数据来源" })).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("ignores raw HTML, remote images, and unsafe link protocols", async () => {
    const { container } = render(<AssistantMessageText text={`安全正文

<script>alert(1)</script>

<img src=x onerror=alert(1)>

![远程跟踪图](https://example.com/tracker.png)

[危险链接](javascript:alert(1))

[明文链接](http://example.com)

[含凭据链接](https://user:pass@example.com)`} />);

    expect(await screen.findByText("安全正文")).toBeInTheDocument();
    expect(container.querySelector("script")).not.toBeInTheDocument();
    expect(container.querySelector("img")).not.toBeInTheDocument();
    expect(screen.queryByText("alert(1)")).not.toBeInTheDocument();
    expect(screen.getByText("危险链接")).toHaveClass("assistant-link-disabled");
    expect(screen.getByText("危险链接").closest("a")).toBeNull();
    expect(screen.getByText("明文链接")).toHaveClass("assistant-link-disabled");
    expect(screen.getByText("含凭据链接")).toHaveClass("assistant-link-disabled");
  });

  it("keeps partial streaming text lightweight until completion", () => {
    render(<AssistantMessageText text={"## 尚未完成\n下一段"} streaming />);
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
    expect(screen.getByText(/尚未完成/)).toHaveClass("assistant-stream-text");
  });

  it("opens HTTPS sources with the Tauri system opener on desktop", async () => {
    window.__TAURI_INTERNALS__ = {};
    render(<AssistantMessageText text="[来源](https://example.com/report)" />);
    const source = await screen.findByRole("link", { name: "来源" });
    source.click();
    await vi.waitFor(() => expect(opener.openUrl).toHaveBeenCalledWith("https://example.com/report"));
  });
});
