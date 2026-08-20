"use client";
import { serverActionError } from "@/lib/client/server-action";

import { useEffect, useState } from "react";
import { QUADRANTS, EFFORT_LABEL, type PriorityMatrix as Matrix } from "@/modules/audit/priority";
import type { QuoteSkeletonLine } from "@/modules/audit/service-map";
import {
  getPriorityView,
  previewQuoteSkeleton,
  leadForAudit,
} from "@/modules/audit/priority-actions";
import { createQuote } from "@/modules/documents/actions";

/**
 * Findings as a plan rather than an inventory (P2/4).
 *
 * Selecting findings previews the quote lines they map to; creating the draft
 * is a second, explicit press, because a quote is a legal document in this
 * system and must never appear as a side effect of clicking around.
 */
const QUADRANT_TONE: Record<string, string> = {
  "quick-wins": "border-[rgba(61,220,151,0.35)]",
  projects: "border-[rgba(116,39,198,0.45)]",
  "fill-ins": "border-line",
  later: "border-line",
};

function huf(n: number): string {
  return `${n.toLocaleString("hu-HU")} Ft`;
}

export function PriorityMatrixPanel({ auditId }: { auditId: string }) {
  const [view, setView] = useState<{ matrix: Matrix; pricesAreSeeded: boolean } | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [lines, setLines] = useState<QuoteSkeletonLine[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getPriorityView(auditId).then((v) => {
      if (active) setView(v);
    });
    return () => {
      active = false;
    };
  }, [auditId]);

  if (!view || view.matrix.ordered.length === 0) return null;

  const toggle = (key: string) =>
    setSelected((s) => (s.includes(key) ? s.filter((k) => k !== key) : [...s, key]));

  async function preview() {
    setBusy(true);
    setError(null);
    try {
      const res = await previewQuoteSkeleton({ auditId, checkKeys: selected });
      setLines(res.lines);
    } catch (e) {
      setError(serverActionError(e));
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    if (!lines || lines.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const leadId = await leadForAudit(auditId);
      if (!leadId) {
        setError("This audit has no lead yet — create the lead first, then quote.");
        return;
      }
      const validUntil = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
      const { documentId } = await createQuote({
        leadId,
        items: lines.map((l) => ({
          description: l.description,
          baseNet: l.baseNet,
          preset: l.preset,
        })),
        vatRatePct: 27,
        validUntil,
      });
      setResult(documentId);
    } catch (e) {
      setError(serverActionError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3.5 rounded-card border border-line bg-panel p-[18px]">
      <div className="mb-2.5 flex flex-wrap items-baseline gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
          What to fix first
        </span>
        <span className="text-[11px] text-muted">
          {view.matrix.ordered.length} findings · select to build a quote skeleton
        </span>
      </div>

      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        {QUADRANTS.map((q) => {
          const bucket = view.matrix.quadrants.find((x) => x.id === q.id);
          if (!bucket || bucket.findings.length === 0) return null;
          return (
            <div
              key={q.id}
              className={`rounded-[10px] border bg-panel-2 p-3 ${QUADRANT_TONE[q.id] ?? "border-line"}`}
            >
              <div className="text-[12px] font-bold">{q.hu}</div>
              <div className="mb-1.5 text-[10.5px] text-muted">{q.note.en}</div>
              {bucket.findings.map((f) => (
                <label
                  key={f.key}
                  className="flex cursor-pointer items-start gap-2 py-1 text-[12px] text-[#C9CEE3]"
                >
                  <input
                    type="checkbox"
                    checked={selected.includes(f.key)}
                    onChange={() => toggle(f.key)}
                    className="mt-0.5"
                    style={{ accentColor: "#7427C6" }}
                  />
                  <span>
                    {f.label}
                    {f.detail ? <span className="text-muted"> · {f.detail}</span> : null}
                    <span className="ml-1 text-[10.5px] text-muted">
                      [{EFFORT_LABEL[f.effort].en}]
                    </span>
                  </span>
                </label>
              ))}
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          onClick={preview}
          disabled={busy}
          className="rounded-[10px] border border-line bg-panel-2 px-3 py-1.5 text-[12px] font-semibold hover:border-accent disabled:opacity-60"
        >
          {selected.length === 0 ? "Quote skeleton from all findings" : `Quote skeleton from ${selected.length}`}
        </button>
        {view.pricesAreSeeded && (
          <span className="text-[11px] text-warn">
            Price bands are still the seeded placeholders — set your own in Settings.
          </span>
        )}
      </div>

      {error && <p className="mt-2 text-[11.5px] text-[#FFB3C2]">{error}</p>}

      {lines && lines.length > 0 && !result && (
        <div className="mt-3 rounded-[10px] border border-line bg-panel-2 p-3">
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
            Draft lines
          </div>
          {lines.map((l) => (
            <div key={l.description} className="border-b border-[rgba(239,241,248,0.05)] py-1.5">
              <div className="flex items-baseline gap-2 text-[12.5px]">
                <span className="text-[#C9CEE3]">{l.description}</span>
                <span className="ml-auto tabular-nums">{huf(l.baseNet)}</span>
              </div>
              <div className="text-[11px] text-muted">
                {huf(l.band.minHuf)}–{huf(l.band.maxHuf)} · from: {l.findings.join(", ")}
              </div>
            </div>
          ))}
          <button
            onClick={create}
            disabled={busy}
            className="mt-2.5 rounded-[10px] border-[1.5px] border-transparent bg-canvas px-3 py-1.5 text-[12px] font-semibold text-ink shadow-glow [background-clip:padding-box,border-box] [background-image:linear-gradient(#00051D,#00051D),linear-gradient(135deg,#310B59,#7427C6)] [background-origin:border-box] disabled:opacity-60"
          >
            {busy ? "Creating…" : "Create draft quote"}
          </button>
          <p className="mt-1.5 text-[11px] text-muted">
            Creates a DRAFT with the watermark, like every quote. Amounts are a starting point.
          </p>
        </div>
      )}

      {lines && lines.length === 0 && (
        <p className="mt-2 text-[11.5px] text-muted">
          None of the selected findings map to a service line yet.
        </p>
      )}

      {result && (
        <p className="mt-2 text-[12px]">
          Draft quote created ·{" "}
          <a href="/documents" className="text-accent-ink underline">
            open Documents
          </a>
        </p>
      )}
    </div>
  );
}
