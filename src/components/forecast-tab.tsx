"use client";
import { attempt } from "@/lib/client/server-action";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ForecastView } from "@/modules/deals/forecast-data";
import { UNSCHEDULED } from "@/modules/deals/logic";
import { setCommitThreshold } from "@/modules/deals/config-actions";

/**
 * The weighted forecast (playbook-v2 P4/c).
 *
 * A table AND a bar per month, because the two answer different questions: the
 * table is what you paste into a board pack, the bars are how you see that
 * March is thin. The commit/upside split is drawn as one stacked bar rather
 * than two, so "how much of this is real" is a proportion you can see rather
 * than two numbers to subtract.
 */

function huf(n: number): string {
  return `${Math.round(n).toLocaleString("hu-HU")} Ft`;
}

function hufShort(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(".", ",")} M`;
  if (abs >= 1_000) return `${Math.round(n / 1_000)} e`;
  return String(n);
}

function monthLabel(key: string): string {
  if (key === UNSCHEDULED) return "no date";
  const [, month] = key.split("-");
  return (
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"][
      Number(month) - 1
    ] ?? key
  );
}

function Stat({ label, value, hint, testId }: { label: string; value: string; hint?: string; testId: string }) {
  return (
    <div className="rounded-card border border-line bg-panel p-[18px]">
      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
        {label}
      </div>
      <b data-testid={testId} className="block text-[24px] leading-none tabular-nums">
        {value}
      </b>
      {hint && <span className="mt-1.5 block text-[11.5px] text-muted">{hint}</span>}
    </div>
  );
}

export function ForecastTab({ view, isOwner }: { view: ForecastView; isOwner: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [threshold, setThreshold] = useState(view.commitThreshold);
  const [error, setError] = useState<string | null>(null);

  const rows = view.overall.rows;
  const scale = Math.max(1, ...rows.map((r) => r.weighted));

  return (
    <div className="grid gap-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat
          label="Weighted pipeline"
          value={huf(view.overall.totals.weighted)}
          hint={`${view.overall.totals.count} open deals · ${huf(view.overall.totals.total)} at face value`}
          testId="forecast-weighted"
        />
        <Stat
          label="Commit"
          value={huf(view.overall.totals.commit)}
          hint={`at or above ${view.commitThreshold}% probability`}
          testId="forecast-commit"
        />
        <Stat
          label="Upside"
          value={huf(view.overall.totals.upside)}
          hint={`below ${view.commitThreshold}%`}
          testId="forecast-upside"
        />
      </div>

      {/* Bars: commit stacked under upside, with the monthly target as a line. */}
      <section className="rounded-card border border-line bg-panel p-[18px]">
        <div className="mb-3 flex items-baseline gap-2">
          <h3 className="text-[13px] font-semibold">By expected close month</h3>
          {view.monthlyTarget !== null && (
            <span className="ml-auto text-[11px] text-muted">
              monthly revenue target {huf(view.monthlyTarget)}
            </span>
          )}
        </div>

        <div className="flex h-[180px] items-end gap-2" data-testid="forecast-bars">
          {rows.map((r) => {
            const target = view.monthlyTarget;
            const targetPct = target && target > 0 ? (target / scale) * 100 : null;
            return (
              <div key={r.month} className="relative flex min-w-0 flex-1 flex-col justify-end">
                {targetPct !== null && targetPct <= 100 && r.month !== UNSCHEDULED && (
                  <i
                    aria-hidden
                    className="absolute left-0 right-0 border-t border-dashed border-[rgba(239,241,248,0.28)]"
                    style={{ bottom: `${targetPct}%` }}
                  />
                )}
                <div
                  className="flex flex-col justify-end"
                  style={{ height: `${(r.weighted / scale) * 100}%` }}
                  title={`${monthLabel(r.month)} · ${huf(r.weighted)} weighted`}
                >
                  <i
                    className="block w-full rounded-t-[3px] bg-[rgba(116,39,198,0.35)]"
                    style={{ height: `${r.weighted ? (r.upside / r.weighted) * 100 : 0}%` }}
                  />
                  <i
                    className="block w-full bg-grad"
                    style={{ height: `${r.weighted ? (r.commit / r.weighted) * 100 : 0}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
        <div className="mt-1.5 flex gap-2">
          {rows.map((r) => (
            <div key={r.month} className="min-w-0 flex-1 text-center">
              <span className="block truncate text-[10.5px] text-muted">{monthLabel(r.month)}</span>
              <span className="block truncate text-[10.5px] tabular-nums">{hufShort(r.weighted)}</span>
            </div>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-[11px] text-muted">
          <span className="flex items-center gap-1.5">
            <i className="h-2 w-3 rounded-[2px] bg-grad" /> commit
          </span>
          <span className="flex items-center gap-1.5">
            <i className="h-2 w-3 rounded-[2px] bg-[rgba(116,39,198,0.35)]" /> upside
          </span>
          {view.monthlyTarget !== null && (
            <span className="flex items-center gap-1.5">
              <i className="h-px w-3 border-t border-dashed border-[rgba(239,241,248,0.5)]" /> target
            </span>
          )}
        </div>
      </section>

      {/* The table. Per pipeline, because a forecast that mixes web projects
          with grants hides that one of them is carrying the quarter. */}
      <section className="overflow-x-auto rounded-card border border-line bg-panel p-[18px]">
        <h3 className="mb-3 text-[13px] font-semibold">Month by month</h3>
        <table className="w-full min-w-[640px] border-collapse text-[12.5px]">
          <thead>
            <tr className="text-left text-[10.5px] uppercase tracking-[0.1em] text-muted">
              <th className="pb-2 pr-3 font-semibold">Month</th>
              <th className="pb-2 pr-3 text-right font-semibold">Deals</th>
              <th className="pb-2 pr-3 text-right font-semibold">Face value</th>
              <th className="pb-2 pr-3 text-right font-semibold">Weighted</th>
              <th className="pb-2 pr-3 text-right font-semibold">Commit</th>
              <th className="pb-2 pr-3 text-right font-semibold">Upside</th>
              {view.monthlyTarget !== null && (
                <th className="pb-2 text-right font-semibold">vs target</th>
              )}
            </tr>
          </thead>
          <tbody data-testid="forecast-table">
            {rows.map((r) => {
              const gap = view.monthlyTarget === null ? null : r.weighted - view.monthlyTarget;
              return (
                <tr key={r.month} className="border-t border-line">
                  <td className="py-2 pr-3">{monthLabel(r.month)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{r.count}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{huf(r.total)}</td>
                  <td className="py-2 pr-3 text-right font-semibold tabular-nums">
                    {huf(r.weighted)}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">{huf(r.commit)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums text-muted">{huf(r.upside)}</td>
                  {gap !== null && (
                    <td
                      className={`py-2 text-right tabular-nums ${
                        r.month === UNSCHEDULED ? "text-muted" : gap >= 0 ? "text-pos" : "text-warn"
                      }`}
                    >
                      {r.month === UNSCHEDULED ? "—" : `${gap >= 0 ? "+" : ""}${huf(gap)}`}
                    </td>
                  )}
                </tr>
              );
            })}
            <tr className="border-t border-line font-semibold">
              <td className="py-2 pr-3">total</td>
              <td className="py-2 pr-3 text-right tabular-nums">{view.overall.totals.count}</td>
              <td className="py-2 pr-3 text-right tabular-nums">{huf(view.overall.totals.total)}</td>
              <td className="py-2 pr-3 text-right tabular-nums">{huf(view.overall.totals.weighted)}</td>
              <td className="py-2 pr-3 text-right tabular-nums">{huf(view.overall.totals.commit)}</td>
              <td className="py-2 pr-3 text-right tabular-nums">{huf(view.overall.totals.upside)}</td>
              {view.monthlyTarget !== null && <td />}
            </tr>
          </tbody>
        </table>
      </section>

      <section className="grid gap-3 rounded-card border border-line bg-panel p-[18px] sm:grid-cols-2">
        {view.perPipeline.map((p) => (
          <div key={p.pipelineId} className="rounded-[11px] border border-line p-3">
            <div className="mb-1.5 flex items-baseline gap-2">
              <b className="text-[12.5px]">{p.pipelineName}</b>
              <span className="ml-auto text-[11px] text-muted tabular-nums">
                {p.forecast.totals.count} open
              </span>
            </div>
            <b className="block text-[18px] tabular-nums">{huf(p.forecast.totals.weighted)}</b>
            <span className="text-[11px] text-muted">
              {huf(p.forecast.totals.commit)} commit · {huf(p.forecast.totals.upside)} upside
            </span>
          </div>
        ))}
      </section>

      {isOwner && (
        <section className="rounded-card border border-line bg-panel p-[18px]">
          <h3 className="mb-1.5 text-[13px] font-semibold">Commit threshold</h3>
          <p className="mb-3 max-w-[560px] text-[12px] text-muted">
            The probability at or above which a deal counts as commit rather than upside.
            Nothing else changes — the weighted total is the same either way.
          </p>
          {error && <p className="mb-2 text-[12px] text-[#FFB3C2]">{error}</p>}
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={0}
              max={100}
              value={threshold}
              onChange={(e) => setThreshold(Number(e.target.value))}
              aria-label="Commit threshold"
              className="w-[90px] rounded-[9px] border border-line bg-[rgba(0,5,29,0.5)] px-2.5 py-2 text-[13px] tabular-nums text-ink outline-none focus:border-accent"
            />
            <span className="text-[12px] text-muted">%</span>
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const res = await attempt(setCommitThreshold(threshold));
                  if (!res.ok) setError(res.error);
                  else {
                    setError(null);
                    router.refresh();
                  }
                })
              }
              className="ml-2 min-h-[40px] rounded-[9px] bg-grad px-3.5 py-2 text-[12.5px] font-semibold text-ink disabled:opacity-45"
            >
              {pending ? "Saving…" : "Save"}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
