"use client";

import { useEffect, useRef, useState } from "react";
import { exportAnalyticsPdf } from "@/modules/analytics/actions";

/**
 * Export the analytics on screen to a branded PDF.
 *
 * The render runs in the worker (Chromium is not in the app image), so this
 * enqueues and then polls the authenticated file route until the PDF appears.
 * Polling the file rather than a job-status endpoint keeps it simple and means
 * the button can never claim success before the bytes are actually readable.
 */
const POLL_MS = 1200;
const TIMEOUT_MS = 60_000;

type State =
  | { kind: "idle" }
  | { kind: "working"; startedAt: number }
  | { kind: "ready"; path: string }
  | { kind: "failed"; message: string };

export function AnalyticsExport() {
  const [state, setState] = useState<State>({ kind: "idle" });
  const [elapsed, setElapsed] = useState(0);
  const cancelled = useRef(false);

  useEffect(() => {
    return () => {
      cancelled.current = true;
    };
  }, []);

  // Drives the "…for Ns" counter so a slow render still visibly progresses.
  useEffect(() => {
    if (state.kind !== "working") return;
    const iv = setInterval(() => setElapsed(Math.round((Date.now() - state.startedAt) / 1000)), 500);
    return () => clearInterval(iv);
  }, [state]);

  async function run() {
    setState({ kind: "working", startedAt: Date.now() });
    setElapsed(0);
    try {
      const { path } = await exportAnalyticsPdf();
      const started = Date.now();
      while (Date.now() - started < TIMEOUT_MS) {
        if (cancelled.current) return;
        await new Promise((r) => setTimeout(r, POLL_MS));
        // HEAD would be cheaper, but the route only implements GET.
        const res = await fetch(`/api/files/${path}`, { method: "GET", cache: "no-store" });
        if (res.ok) {
          setState({ kind: "ready", path });
          return;
        }
      }
      setState({
        kind: "failed",
        message: "The export is taking longer than a minute — the worker may be busy. Try again.",
      });
    } catch (e) {
      setState({ kind: "failed", message: (e as Error).message });
    }
  }

  return (
    <div className="mb-4 flex flex-wrap items-center gap-3">
      <button
        onClick={run}
        disabled={state.kind === "working"}
        data-testid="analytics-export"
        className="rounded-[10px] border-[1.5px] border-transparent bg-canvas px-4 py-2 text-[13px] font-semibold text-ink shadow-glow [background-clip:padding-box,border-box] [background-image:linear-gradient(#00051D,#00051D),linear-gradient(135deg,#310B59,#7427C6)] [background-origin:border-box] disabled:opacity-60"
      >
        {state.kind === "working" ? "Rendering…" : "Export PDF"}
      </button>

      {state.kind === "working" && (
        <span className="flex items-center gap-2 text-[12px] text-muted" role="status">
          <span
            aria-hidden
            className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-[rgba(239,241,248,0.18)] border-t-accent"
          />
          Rendering in the background{elapsed > 2 ? ` — ${elapsed}s` : ""}
        </span>
      )}

      {state.kind === "ready" && (
        <a
          href={`/api/files/${state.path}`}
          target="_blank"
          rel="noreferrer"
          data-testid="analytics-export-download"
          className="rounded-[10px] border border-accent-soft bg-accent-soft px-3.5 py-2 text-[12.5px] font-semibold text-accent-ink hover:bg-[rgba(116,39,198,0.22)]"
        >
          Download PDF ↓
        </a>
      )}

      {state.kind === "failed" && (
        <span className="text-[12px] text-[#FFB3C2]">{state.message}</span>
      )}

      <span className="text-[11.5px] text-muted">
        Exactly the figures on this screen · 0 Claude calls
      </span>
    </div>
  );
}
