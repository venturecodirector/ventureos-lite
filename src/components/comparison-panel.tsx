"use client";
import { serverActionError } from "@/lib/client/server-action";

import { useEffect, useState } from "react";
import type { ComparisonTable } from "@/modules/audit/comparison";
import {
  suggestCompetitors,
  runComparison,
  getComparison,
  clearComparison,
  pendingComparisonCount,
  type CompetitorCandidate,
} from "@/modules/audit/comparison-actions";

/**
 * Competitor side-by-side, internal view (P2/3).
 *
 * Names and per-competitor numbers appear HERE and in the sales PDF. The
 * public share page gets an anonymised average from the same table — that
 * split is enforced in the module, not in this component.
 */
const DIRECTION_CLASS: Record<string, string> = {
  better: "text-[#3DDC97]",
  worse: "text-[#FF5C7A]",
  same: "text-muted",
};

function label(url: string, name: string | null): string {
  return name ?? url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

export function ComparisonPanel({ auditId }: { auditId: string }) {
  const [table, setTable] = useState<ComparisonTable | null>(null);
  const [candidates, setCandidates] = useState<CompetitorCandidate[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [manual, setManual] = useState("");
  const [cost, setCost] = useState<number | null>(null);
  const [busy, setBusy] = useState<"idle" | "suggesting" | "running">("idle");
  const [pending, setPending] = useState(0);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getComparison(auditId).then((t) => {
      if (active) setTable(t);
    });
    return () => {
      active = false;
    };
  }, [auditId]);

  // Competitor audits are ordinary audits in the same queue, so this polls the
  // same way the primary run does.
  useEffect(() => {
    if (pending === 0) return;
    const timer = setTimeout(async () => {
      const left = await pendingComparisonCount(auditId);
      setPending(left);
      if (left === 0) setTable(await getComparison(auditId));
    }, 2000);
    return () => clearTimeout(timer);
  }, [pending, auditId]);

  async function suggest() {
    setBusy("suggesting");
    setNote(null);
    try {
      const res = await suggestCompetitors(auditId);
      setCandidates(res.candidates);
      setCost(res.costUsd);
      if (res.unavailable) {
        setNote(
          {
            no_company: "This audit is not linked to a company, so there is nothing to search around.",
            no_category: "The company has no industry or city yet — add them, or paste URLs below.",
            no_key: "No Places API key configured (Settings → Integrations).",
            none_found: "No same-category businesses with a website nearby.",
          }[res.unavailable],
        );
      }
    } catch (e) {
      setNote(serverActionError(e));
    } finally {
      setBusy("idle");
    }
  }

  async function run(urls: string[]) {
    if (urls.length === 0) return;
    setBusy("running");
    setNote(null);
    try {
      const { auditIds } = await runComparison({ auditId, urls });
      setPending(auditIds.length);
      setTable(await getComparison(auditId));
    } catch (e) {
      setNote(serverActionError(e));
    } finally {
      setBusy("idle");
    }
  }

  return (
    <div className="mt-3.5 rounded-card border border-line bg-panel p-[18px]">
      <div className="mb-2.5 flex flex-wrap items-baseline gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
          Competitor comparison
        </span>
        {table && (
          <button
            onClick={async () => {
              await clearComparison(auditId);
              setTable(null);
              setCandidates(null);
              setPicked([]);
            }}
            className="ml-auto text-[11px] text-muted hover:text-ink"
          >
            Clear
          </button>
        )}
      </div>

      {note && <p className="mb-2 text-[11.5px] text-warn">{note}</p>}

      {!table && (
        <>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={suggest}
              disabled={busy !== "idle"}
              className="rounded-[10px] border border-line bg-panel-2 px-3 py-1.5 text-[12px] font-semibold hover:border-accent disabled:opacity-60"
            >
              {busy === "suggesting" ? "Searching…" : "Suggest nearby competitors"}
            </button>
            <input
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              placeholder="or paste competitor URLs, comma separated"
              className="min-w-[220px] flex-1 rounded-[10px] border border-line bg-[rgba(0,5,29,0.5)] px-3 py-1.5 text-[12px] text-ink outline-none focus:border-accent"
            />
            <button
              onClick={() =>
                run(
                  manual
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean)
                    .slice(0, 2),
                )
              }
              disabled={busy !== "idle" || manual.trim().length === 0}
              className="rounded-[10px] border border-line bg-panel-2 px-3 py-1.5 text-[12px] font-semibold hover:border-accent disabled:opacity-60"
            >
              Compare
            </button>
          </div>
          <p className="mt-1.5 text-[11px] text-muted">
            Two competitors max · each is an ordinary single-page audit, cached 30 days
            {cost !== null ? ` · Places search cost $${cost.toFixed(3)}` : ""}
          </p>
        </>
      )}

      {candidates && candidates.length > 0 && !table && (
        <div className="mt-3">
          <div className="mb-1.5 text-[11px] text-muted">
            Pick up to two — same category, nearby, with a website of their own.
          </div>
          <div className="space-y-1">
            {candidates.map((c) => {
              const on = picked.includes(c.url);
              return (
                <label
                  key={c.url}
                  className="flex cursor-pointer items-center gap-2 rounded-[8px] px-2 py-1.5 text-[12px] hover:bg-panel-2"
                >
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={!on && picked.length >= 2}
                    onChange={() =>
                      setPicked(on ? picked.filter((u) => u !== c.url) : [...picked, c.url])
                    }
                    style={{ accentColor: "#7427C6" }}
                  />
                  <span className="text-[#C9CEE3]">{c.name}</span>
                  <span className="truncate text-muted">
                    {c.url.replace(/^https?:\/\//, "")}
                  </span>
                </label>
              );
            })}
          </div>
          <button
            onClick={() => run(picked)}
            disabled={picked.length === 0 || busy !== "idle"}
            className="mt-2 rounded-[10px] border-[1.5px] border-transparent bg-canvas px-3 py-1.5 text-[12px] font-semibold text-ink shadow-glow [background-clip:padding-box,border-box] [background-image:linear-gradient(#00051D,#00051D),linear-gradient(135deg,#310B59,#7427C6)] [background-origin:border-box] disabled:opacity-60"
          >
            {busy === "running" ? "Auditing…" : `Audit ${picked.length || ""} and compare`}
          </button>
        </div>
      )}

      {pending > 0 && (
        <p className="mt-2 text-[11.5px] text-muted">
          {pending} competitor audit{pending > 1 ? "s" : ""} still running…
        </p>
      )}

      {table && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] border-collapse text-[12px]">
            <thead>
              <tr className="border-b border-line text-[10px] uppercase tracking-[0.08em] text-muted">
                <th className="py-1.5 pr-3 text-left font-semibold">Metric</th>
                {table.subjects.map((s, i) => (
                  <th key={s.auditId} className="py-1.5 pr-3 text-right font-semibold">
                    {i === 0 ? "This site" : label(s.url, s.name)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((r) => (
                <tr key={r.key} className="border-b border-[rgba(239,241,248,0.05)]">
                  <td className="py-1.5 pr-3 text-[#C9CEE3]">{r.en}</td>
                  {r.values.map((v, i) => (
                    <td
                      key={i}
                      className={`py-1.5 pr-3 text-right tabular-nums ${
                        i === 0 ? (DIRECTION_CLASS[r.direction] ?? "text-muted") : "text-muted"
                      }`}
                    >
                      {v === null ? "—" : v}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-2 space-y-0.5">
            {table.rows.map((r) => (
              <p key={r.key} className="text-[11.5px] text-muted">
                {r.takeawayHu}
              </p>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-muted">
            Competitor names stay internal — the public share page shows an anonymised average.
          </p>
        </div>
      )}
    </div>
  );
}
