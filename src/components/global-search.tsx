"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { searchWorkspace } from "@/modules/search/actions";
import { MIN_QUERY_LENGTH, type SearchHit, type SearchKind } from "@/modules/search/query";
import { SearchIcon } from "./nav-icons";

const DEBOUNCE_MS = 200;

const KIND_LABEL: Record<SearchKind, string> = {
  lead: "Lead",
  company: "Company",
  document: "Doc",
};

/**
 * Top-bar global search (spec §4.1).
 *
 * Scoped to the active workspace by the server action; this component only
 * renders what it is given. "/" focuses it from anywhere, ↑/↓ move, Enter
 * opens, Escape closes.
 */
export function GlobalSearch({ className = "" }: { className?: string }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);

  /** Guards against a slow earlier request overwriting a newer one's results. */
  const requestId = useRef(0);

  useEffect(() => {
    const term = q.trim();
    if (term.length < MIN_QUERY_LENGTH) {
      setHits([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const id = ++requestId.current;
    const timer = setTimeout(async () => {
      try {
        const results = await searchWorkspace({ q: term });
        if (id !== requestId.current) return; // a newer keystroke won
        setHits(results);
        setActive(0);
        setOpen(true);
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [q]);

  // "/" focuses the box from anywhere, unless the user is already typing.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement;
      const typing =
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement ||
        (el instanceof HTMLElement && el.isContentEditable);
      if (typing) return;
      e.preventDefault();
      inputRef.current?.focus();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Close when focus or a click leaves the widget.
  useEffect(() => {
    function onPointerDown(e: MouseEvent) {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, []);

  const go = useCallback(
    (hit: SearchHit) => {
      setOpen(false);
      setQ("");
      setHits([]);
      router.push(hit.href);
    },
    [router],
  );

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      setOpen(false);
      inputRef.current?.blur();
      return;
    }
    if (!open || hits.length === 0) {
      if (e.key === "ArrowDown" && hits.length > 0) setOpen(true);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % hits.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i - 1 + hits.length) % hits.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = hits[active];
      if (hit) go(hit);
    }
  }

  const showDropdown = open && q.trim().length >= MIN_QUERY_LENGTH;

  return (
    <div ref={boxRef} className={`relative ${className}`}>
      <div className="flex items-center gap-2 rounded-[10px] border border-line bg-panel px-3 py-2 focus-within:border-accent">
        <SearchIcon className="h-3.5 w-3.5 flex-none text-muted" />
        <input
          ref={inputRef}
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => hits.length > 0 && setOpen(true)}
          placeholder="Search leads, companies…"
          aria-label="Search leads, companies and documents"
          aria-expanded={showDropdown}
          aria-controls="global-search-results"
          aria-autocomplete="list"
          role="combobox"
          data-testid="global-search-input"
          className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-muted [&::-webkit-search-cancel-button]:appearance-none"
        />
        {loading ? (
          <span className="flex-none text-[11px] text-muted">…</span>
        ) : (
          <span className="flex-none rounded-[5px] border border-line px-1.5 text-[11px] text-muted">
            /
          </span>
        )}
      </div>

      {showDropdown && (
        <div
          id="global-search-results"
          role="listbox"
          data-testid="global-search-results"
          className="absolute right-0 top-[calc(100%+6px)] z-50 max-h-[60vh] w-[min(420px,90vw)] overflow-y-auto rounded-[12px] border border-line bg-canvas p-1.5 shadow-glow-lg"
        >
          {hits.length === 0 ? (
            <p className="px-3 py-3 text-[12.5px] text-muted" data-testid="global-search-empty">
              {loading ? "Searching…" : `Nothing matches “${q.trim()}”.`}
            </p>
          ) : (
            hits.map((hit, i) => (
              <button
                key={`${hit.kind}:${hit.id}`}
                type="button"
                role="option"
                aria-selected={i === active}
                data-testid="global-search-hit"
                onMouseEnter={() => setActive(i)}
                onClick={() => go(hit)}
                className={[
                  "flex min-h-[44px] w-full items-center gap-2.5 rounded-[9px] px-2.5 py-1.5 text-left",
                  i === active ? "bg-panel-2" : "hover:bg-panel",
                ].join(" ")}
              >
                <span className="flex-none rounded-[5px] border border-line px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-[0.1em] text-muted">
                  {KIND_LABEL[hit.kind]}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-ink">{hit.title}</span>
                  <span className="block truncate text-[11.5px] text-muted">{hit.subtitle}</span>
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
