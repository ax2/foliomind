import { ArrowDown, ArrowUp, Command, MagnifyingGlass } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { stocks } from "../data/market.js";
import { useLabStore } from "../store/useLabStore.js";

const NAV_ITEMS = Object.freeze([
  ["watchlist", "自选", "查看自选标的"],
  ["market", "行情", "查看市场行情"],
  ["research", "筛选", "打开研究筛选"],
  ["portfolio", "组合", "查看投资组合"],
  ["monitor", "盯盘", "管理盯盘规则"],
  ["events", "事件", "打开事件日历"],
  ["notifications", "消息", "查看站内消息"],
  ["chat", "对话", "打开 FolioMind Agent"],
  ["skills", "技能", "管理金融 Skills"],
  ["settings", "设置", "配置数据与模型"],
]);

function normalizeSearch(value) {
  return String(value || "").trim().toLocaleLowerCase("zh-CN");
}

function symbolEntries(watchlist) {
  const seen = new Set();
  return [...watchlist, ...Object.values(stocks)].filter((item) => {
    const symbol = String(item?.symbol || "").trim().toUpperCase();
    if (!symbol || seen.has(symbol)) return false;
    seen.add(symbol);
    return true;
  }).map((item) => ({
    type: "symbol",
    id: String(item.symbol).trim().toUpperCase(),
    label: String(item.name || item.symbol),
    description: `${item.symbol}${item.market ? ` · ${item.market}` : ""}${item.category ? ` · ${item.category}` : ""}`,
  }));
}

export function CommandPalette() {
  const watchlist = useLabStore((state) => state.watchlist);
  const setActiveView = useLabStore((state) => state.setActiveView);
  const selectSymbol = useLabStore((state) => state.selectSymbol);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef(null);
  const dialogRef = useRef(null);
  const returnFocusRef = useRef(null);
  const openRef = useRef(false);

  const rememberFocus = () => {
    const active = document.activeElement;
    returnFocusRef.current = active && typeof active.focus === "function" ? active : null;
  };

  const close = () => {
    openRef.current = false;
    setOpen(false);
    setQuery("");
  };

  useEffect(() => {
    openRef.current = open;
  }, [open]);

  useEffect(() => {
    const onGlobalKeyDown = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "k") {
        event.preventDefault();
        const nextOpen = !openRef.current;
        if (nextOpen) rememberFocus();
        openRef.current = nextOpen;
        setOpen(nextOpen);
        return;
      }
      if (event.key === "Escape" && openRef.current) {
        event.preventDefault();
        close();
      }
    };
    document.addEventListener("keydown", onGlobalKeyDown);
    return () => document.removeEventListener("keydown", onGlobalKeyDown);
  }, []);

  useEffect(() => {
    if (!open) {
      const target = returnFocusRef.current;
      returnFocusRef.current = null;
      if (target?.isConnected) requestAnimationFrame(() => target.focus());
      return undefined;
    }
    setActiveIndex(0);
    requestAnimationFrame(() => inputRef.current?.focus());
    return undefined;
  }, [open]);

  const entries = useMemo(() => {
    const normalized = normalizeSearch(query);
    const navigation = NAV_ITEMS.map(([id, label, description]) => ({ type: "nav", id, label, description }));
    const symbols = normalized ? symbolEntries(watchlist) : [];
    const all = [...navigation, ...symbols];
    if (!normalized) return all;
    return all.filter((entry) => normalizeSearch(`${entry.label} ${entry.description} ${entry.id}`).includes(normalized));
  }, [query, watchlist]);
  const visibleEntries = entries.slice(0, 20);
  useEffect(() => { setActiveIndex(0); }, [query]);

  const choose = (entry) => {
    if (!entry) return;
    if (entry.type === "symbol") selectSymbol(entry.id);
    else setActiveView(entry.id);
    close();
  };
  const trapFocus = (event) => {
    if (event.key !== "Tab") return;
    const focusable = [...(dialogRef.current?.querySelectorAll("button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])") || [])];
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
  const onInputKeyDown = (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((value) => visibleEntries.length ? (value + 1) % visibleEntries.length : 0);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((value) => visibleEntries.length ? (value - 1 + visibleEntries.length) % visibleEntries.length : 0);
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(visibleEntries[activeIndex]);
    }
  };

  if (!open) return null;
  return <div className="command-palette-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <section ref={dialogRef} className="command-palette" role="dialog" aria-modal="true" aria-label="快速打开" onKeyDown={trapFocus}>
      <div className="command-palette-search"><MagnifyingGlass size={19} /><input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={onInputKeyDown} placeholder="搜索页面、标的或代码…" aria-label="快速搜索" autoComplete="off" /><kbd>Esc</kbd></div>
      <div className="command-palette-hint"><span><Command size={14} />快速打开</span><span>↑↓选择</span><span>Enter确认</span></div>
      <div className="command-palette-results" role="listbox" aria-label="快速打开结果">
        {visibleEntries.length ? visibleEntries.map((entry, index) => <button type="button" role="option" aria-selected={index === activeIndex} className={index === activeIndex ? "command-palette-item active" : "command-palette-item"} key={`${entry.type}-${entry.id}`} onMouseEnter={() => setActiveIndex(index)} onClick={() => choose(entry)}><span className="command-palette-item-main"><strong>{entry.label}</strong><small>{entry.description}</small></span><span className="command-palette-item-kind">{entry.type === "symbol" ? "标的" : "页面"}</span></button>) : <p className="command-palette-empty" role="status">没有匹配的页面或标的</p>}
      </div>
    </section>
  </div>;
}
