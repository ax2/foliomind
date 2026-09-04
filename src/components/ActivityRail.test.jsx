import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ActivityRail } from "./ActivityRail.jsx";
import { initialLabState, useLabStore } from "../store/useLabStore.js";

afterEach(cleanup);

beforeEach(() => {
  useLabStore.setState({ ...initialLabState, activeView: "watchlist", notifications: [] });
});

describe("ActivityRail", () => {
  it("announces the unread count without treating the visual badge as an ambiguous label", () => {
    useLabStore.setState({ notifications: [{ id: "notice-1", read: false }] });
    render(<ActivityRail />);

    expect(screen.getByRole("button", { name: "消息，1 条未读" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "消息，1 条未读" }).querySelector("em")).toHaveAttribute("aria-hidden", "true");
  });

  it("keeps the message label stable when there are no unread items", () => {
    render(<ActivityRail />);

    expect(screen.getByRole("button", { name: "消息" })).toBeInTheDocument();
  });
});
