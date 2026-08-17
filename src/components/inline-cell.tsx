"use client";

import { useEffect, useRef, useState } from "react";

/**
 * An editable table cell (playbook-v2 P7/1).
 *
 * Reads as text until you click it or press Enter on it; Esc cancels, Enter and
 * blur save. The value updates optimistically and the SERVER'S answer replaces
 * it — a trimmed string, a cleared field, a coerced number — so a cell can never
 * end up showing something the database does not hold.
 *
 * A refusal (the score gate, a bad email, a missing grant) puts the previous
 * value back and shows the reason in the cell's title and colour. It does not
 * pop a dialog: a table where every mistyped email opens a modal is a table
 * nobody edits twice.
 *
 * KEYBOARD. Arrow keys move focus between cells, Tab moves right, and both are
 * driven by `data-cell` coordinates on the DOM rather than by a focus manager
 * in state — the table re-renders on every save, and a stateful focus index
 * would point at the wrong row the moment a sort changed under it.
 */

export type InlineKind = "text" | "number" | "date" | "select" | "multiselect" | "checkbox";

export interface InlineOption {
  value: string;
  label: string;
}

const BASE =
  "w-full min-w-0 rounded-[6px] px-1 py-0.5 text-left outline-none transition-colors";

export function InlineCell({
  value,
  display,
  kind,
  label,
  options = [],
  row,
  col,
  editable = true,
  onSave,
}: {
  value: string | string[] | boolean | null;
  /** What the cell shows when it is not being edited. */
  display: React.ReactNode;
  kind: InlineKind;
  label: string;
  options?: InlineOption[];
  /** Grid coordinates, used only for keyboard movement. */
  row: number;
  col: number;
  editable?: boolean;
  /** Resolves to the value the server stored, or an error to show. */
  onSave: (next: string | string[] | boolean | null) => Promise<
    { ok: true; value: unknown } | { ok: false; error: string }
  >;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string | string[] | boolean | null>(value);
  const [shown, setShown] = useState<React.ReactNode>(display);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLInputElement | HTMLSelectElement | null>(null);

  // A fresh server render is the truth; drop any local echo of an older one.
  useEffect(() => {
    setShown(display);
    setDraft(value);
    // `display` is a node and changes identity every render, so the effect is
    // keyed on the VALUE — the thing that actually decides what to show.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(value)]);

  useEffect(() => {
    if (editing) ref.current?.focus();
  }, [editing]);

  function move(dRow: number, dCol: number) {
    const target = document.querySelector<HTMLElement>(
      `[data-cell="${row + dRow}:${col + dCol}"]`,
    );
    target?.focus();
  }

  async function commit(next: string | string[] | boolean | null) {
    setEditing(false);
    if (JSON.stringify(next) === JSON.stringify(value)) return;

    setSaving(true);
    setError(null);
    const res = await onSave(next);
    setSaving(false);

    if (!res.ok) {
      setDraft(value);
      setShown(display);
      setError(res.error);
      return;
    }
    setError(null);
    // The server's value, formatted the plainest way a cell can: the parent
    // re-renders with its own formatting on the next navigation.
    setShown(formatSaved(res.value, options));
    setFlash(true);
    window.setTimeout(() => setFlash(false), 700);
  }

  if (!editable) {
    return <span className="text-[12.5px] text-muted">{shown}</span>;
  }

  if (!editing) {
    return (
      <button
        type="button"
        data-cell={`${row}:${col}`}
        data-testid="inline-cell"
        aria-label={`Edit ${label}`}
        title={error ?? `Edit ${label}`}
        onClick={() => setEditing(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setEditing(true);
            return;
          }
          if (e.key === "ArrowRight" || (e.key === "Tab" && !e.shiftKey)) {
            e.preventDefault();
            move(0, 1);
          } else if (e.key === "ArrowLeft" || (e.key === "Tab" && e.shiftKey)) {
            e.preventDefault();
            move(0, -1);
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            move(1, 0);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            move(-1, 0);
          }
        }}
        className={`${BASE} hover:bg-panel focus-visible:ring-1 focus-visible:ring-accent ${
          error ? "text-[#FFB3C2]" : ""
        } ${flash ? "bg-[rgba(61,220,151,0.14)]" : ""} ${saving ? "opacity-60" : ""}`}
      >
        {shown || <span className="text-muted">—</span>}
      </button>
    );
  }

  if (kind === "checkbox") {
    return (
      <input
        ref={ref as React.RefObject<HTMLInputElement>}
        type="checkbox"
        aria-label={label}
        checked={draft === true}
        onChange={(e) => void commit(e.target.checked)}
        onBlur={() => setEditing(false)}
        className="accent-[#7427C6]"
      />
    );
  }

  if (kind === "select" || kind === "multiselect") {
    const current = Array.isArray(draft) ? draft : draft === null ? "" : String(draft);
    return (
      <select
        ref={ref as React.RefObject<HTMLSelectElement>}
        aria-label={label}
        multiple={kind === "multiselect"}
        value={current as string | string[]}
        onChange={(e) => {
          const next =
            kind === "multiselect"
              ? [...e.target.selectedOptions].map((o) => o.value)
              : e.target.value || null;
          setDraft(next);
          if (kind === "select") void commit(next);
        }}
        onBlur={() => (kind === "multiselect" ? void commit(draft) : setEditing(false))}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            setDraft(value);
            setEditing(false);
          }
        }}
        className="w-full rounded-[6px] border border-accent bg-[rgba(0,5,29,0.6)] px-1 py-0.5 text-[12.5px] text-ink outline-none"
      >
        {kind === "select" && <option value="">—</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }

  return (
    <input
      ref={ref as React.RefObject<HTMLInputElement>}
      type={kind === "number" ? "number" : kind === "date" ? "date" : "text"}
      aria-label={label}
      value={draft === null || typeof draft === "boolean" ? "" : String(draft)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => void commit(draft)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          void commit(draft);
        } else if (e.key === "Escape") {
          e.preventDefault();
          setDraft(value);
          setEditing(false);
        }
      }}
      className="w-full min-w-0 rounded-[6px] border border-accent bg-[rgba(0,5,29,0.6)] px-1 py-0.5 text-[12.5px] text-ink outline-none"
    />
  );
}

function formatSaved(value: unknown, options: InlineOption[]): React.ReactNode {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (Array.isArray(value)) {
    return value.map((v) => options.find((o) => o.value === v)?.label ?? String(v)).join(", ");
  }
  const option = options.find((o) => o.value === String(value));
  return option ? option.label : String(value);
}
