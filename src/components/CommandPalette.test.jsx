import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommandPalette } from "./CommandPalette.jsx";
import { initialLabState, useLabStore } from "../store/useLabStore.js";

afterEach(cleanup);

beforeEach(() => {
  useLabStore.setState({ ...initialLabState, selectedSymbol: "", activeView: "watchlist", watchlist: [{ symbol: "600519", name: "贵州茅台", market: "沪深", category: "白酒" }] });
});

describe("CommandPalette", () => {
  it("opens with Ctrl+K and navigates to a page with keyboard", () => {
    render(<CommandPalette />);
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    expect(screen.getByRole("dialog", { name: "快速打开" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "快速搜索" }), { target: { value: "事件" } });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "快速搜索" }), { key: "Enter" });
    expect(useLabStore.getState()).toMatchObject({ activeView: "events" });
    expect(screen.queryByRole("dialog", { name: "快速打开" })).not.toBeInTheDocument();
  });

  it("searches a watchlist symbol and opens its detail workspace state", () => {
    render(<CommandPalette />);
    fireEvent.keyDown(document, { key: "k", metaKey: true });
    fireEvent.change(screen.getByRole("textbox", { name: "快速搜索" }), { target: { value: "茅台" } });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "快速搜索" }), { key: "Enter" });
    expect(useLabStore.getState()).toMatchObject({ activeView: "watchlist", selectedSymbol: "600519" });
  });

  it("closes on Escape without changing the current view", () => {
    render(<CommandPalette />);
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(useLabStore.getState().activeView).toBe("watchlist");
    expect(screen.queryByRole("dialog", { name: "快速打开" })).not.toBeInTheDocument();
  });

  it("returns focus to the invoking control after closing", async () => {
    render(<><button type="button">打开命令面板</button><CommandPalette /></>);
    const trigger = screen.getByRole("button", { name: "打开命令面板" });
    trigger.focus();
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    const input = await screen.findByRole("textbox", { name: "快速搜索" });
    expect(input).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" });
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(trigger).toHaveFocus();
  });

  it("keeps Tab focus inside the dialog", async () => {
    render(<CommandPalette />);
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    const input = await screen.findByRole("textbox", { name: "快速搜索" });
    const options = screen.getAllByRole("option");
    const lastOption = options.at(-1);
    lastOption.focus();
    fireEvent.keyDown(lastOption, { key: "Tab" });
    expect(input).toHaveFocus();
    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
    expect(lastOption).toHaveFocus();
  });
});
