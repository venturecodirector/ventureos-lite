"use client";

import { useMemo, useState } from "react";
import type { RevenueView, SubscriptionRow } from "@/modules/revenue/dashboard";
import { CHURN_REASONS } from "@/modules/revenue/subscriptions";

/**
 * The Revenue tab (playbook-v3 P11/1b).
 *
 * The movement chart is a stacked column per month rather than a line: the
 * question it answers is "what MOVED", and a line of ending balances hides
 * whether a flat month was quiet or was a big new deal cancelling a big churn.
 */

function huf(n: number): string {
  return `${Math.round(n).toLocaleString("hu-HU")} Ft`;
}

/** Compact for axis labels — "1,2 M" reads faster than eight digits. */
function hufShort(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(".", ",")} M`;
  if (abs >= 1_000) return `${Math.round(n / 1_000)} e`;
  return String(n);
}

function monthLabel(key: string): string {
  const [, month] = key.split("-");
  return ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"][
    Number(month) - 1
  ] ?? key;
}

function humanReason(reason: string): string {
  return reason.replace(/_/g, " ");
}

function Stat({
  label,
  value,
  hint,
  testId,
}: {
  label: string;
  value: string;
  hint?: string;
  testId: string;
}) {
  return (
    <div className="rounded-card border border-line bg-panel p-[18px]">
      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
        {label}
      </div>
      <b data-testid={testId} className="block text-[24px] tabular-nums leading-none">
        {value}
      </b>
      {hint && <span className="mt-1.5 block text-[11.5px] text-muted">{hint}</span>}
    </div>
  );
}

/** One month of the movement chart: gains stack up, losses stack down. */
function MovementColumn({
  row,
  scale,
}: {
  row: RevenueView["movement"][number];
  scale: number;
}) {
  const height = (value: number) => `${(Math.abs(value) / scale) * 100}%`;
  const gains: Array<[string, number, string]> = [
    ["new", row.new, "bg-grad"],
    ["expansion", row.expansion, "bg-[#A76BF0]"],
    ["reactivation", row.reactivation, "bg-pos"],
  ];
  const losses: Array<[string, number, string]> = [
    ["contraction", row.contraction, "bg-warn"],
    ["churn", row.churn, "bg-neg"],
  ];

  return (
    <div className="flex min-w-[34px] flex-1 flex-col items-center gap-1">
      <div className="flex h-[70px] w-full flex-col justify-end">
        {gains.map(([key, value, cls]) =>
          value > 0 ? (
            <i
              key={key}
              title={`${key}: ${huf(value)}`}
              style={{ height: height(value) }}
              className={`block w-full rounded-t-[2px] ${cls}`}
            />
          ) : null,
        )}
      </div>
      {/* The zero line, so up and down are unmistakable. */}
      <div className="h-px w-full bg-line" />
      <div className="flex h-[70px] w-full flex-col justify-start">
        {losses.map(([key, value, cls]) =>
          value < 0 ? (
            <i
              key={key}
              title={`${key}: ${huf(value)}`}
              style={{ height: height(value) }}
              className={`block w-full rounded-b-[2px] ${cls}`}
            />
          ) : null,
        )}
      </div>
      <span className="text-[10px] text-muted">{monthLabel(row.month)}</span>
    </div>
  );
}

const STATUS_FILTERS = ["ALL", "ACTIVE", "PAUSED", "CHURNED"] as const;

export function RevenueTab({ view }: { view: RevenueView }) {
  const [status, setStatus] = useState<(typeof STATUS_FILTERS)[number]>("ACTIVE");

  const rows = useMemo(
    () =>
      status === "ALL"
        ? view.subscriptions
        : view.subscriptions.filter((s) => s.status === status),
    [view.subscriptions, status],
  );

  // One scale for gains and losses, so a 500k churn looks twice a 250k one.
  const scale = Math.max(
    1,
    ...view.movement.map((m) =>
      Math.max(m.new + m.expansion + m.reactivation, Math.abs(m.contraction + m.churn)),
    ),
  );

  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="MRR" value={huf(view.summary.mrr)} testId="revenue-mrr" hint="active subscriptions" />
        <Stat label="ARR" value={huf(view.summary.arr)} testId="revenue-arr" hint="MRR × 12" />
        <Stat
          label="Clients"
          value={String(view.summary.clientCount)}
          testId="revenue-clients"
          hint={`${view.summary.activeCount} active subscriptions`}
        />
        <Stat
          label="Per client"
          value={huf(view.summary.averagePerClient)}
          testId="revenue-arpc"
          hint="average monthly"
        />
      </div>

      <div className="rounded-card border border-line bg-panel p-[18px]">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
            MRR movement
          </span>
          <span className="flex flex-wrap items-center gap-2.5 text-[11px] text-muted">
            {[
              ["new", "bg-grad"],
              ["expansion", "bg-[#A76BF0]"],
              ["reactivation", "bg-pos"],
              ["contraction", "bg-warn"],
              ["churn", "bg-neg"],
            ].map(([label, cls]) => (
              <span key={label} className="inline-flex items-center gap-1">
                <i className={`h-2 w-2 rounded-[2px] ${cls}`} />
                {label}
              </span>
            ))}
          </span>
          <span className="ml-auto text-[11px] text-muted tabular-nums">
            scale ±{hufShort(scale)}
          </span>
        </div>

        {view.movement.every((m) => m.net === 0) && view.summary.mrr === 0 ? (
          <p data-testid="revenue-empty" className="py-6 text-center text-[12.5px] text-muted">
            No recurring revenue yet. Add a subscription on a client to start the book.
          </p>
        ) : (
          <>
            <div data-testid="movement-chart" className="flex items-end gap-1.5 overflow-x-auto">
              {view.movement.map((row) => (
                <MovementColumn key={row.month} row={row} scale={scale} />
              ))}
            </div>
            <div className="mt-3 flex justify-between border-t border-line pt-2 text-[11.5px] text-muted">
              <span>
                {view.movement[0]?.month} → {view.movement[view.movement.length - 1]?.month}
              </span>
              <span className="tabular-nums">
                ending {huf(view.movement[view.movement.length - 1]?.endingMrr ?? 0)}
              </span>
            </div>
          </>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <div className="min-w-0 rounded-card border border-line bg-panel p-[18px]">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
              Subscriptions
            </span>
            <span className="ml-auto flex gap-1.5">
              {STATUS_FILTERS.map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setStatus(f)}
                  data-testid={`sub-filter-${f}`}
                  aria-pressed={status === f}
                  className={`rounded-[8px] px-2 py-1 text-[11.5px] ${
                    status === f
                      ? "border border-accent bg-accent-soft text-[#E4D3FF]"
                      : "border border-line text-muted hover:text-ink"
                  }`}
                >
                  {f.toLowerCase()}
                </button>
              ))}
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-[10.5px] uppercase tracking-[0.1em] text-muted">
                  <th className="pb-2 text-left font-semibold">Client</th>
                  <th className="pb-2 text-left font-semibold">Plan</th>
                  <th className="pb-2 text-left font-semibold">Source</th>
                  <th className="pb-2 text-right font-semibold">Monthly net</th>
                  <th className="pb-2 text-left font-semibold">Status</th>
                </tr>
              </thead>
              <tbody data-testid="subscriptions-table">
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={5} className="py-6 text-center text-muted">
                      Nothing {status === "ALL" ? "yet" : `in ${status.toLowerCase()}`}.
                    </td>
                  </tr>
                )}
                {rows.map((s: SubscriptionRow) => (
                  <tr key={s.id} data-testid="subscription-row" className="border-t border-line">
                    <td className="py-2 font-semibold">{s.companyName}</td>
                    <td className="py-2 text-muted">{s.planName}</td>
                    <td className="py-2 text-muted">{s.source}</td>
                    <td className="py-2 text-right tabular-nums">{huf(s.monthlyNet)}</td>
                    <td className="py-2">
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10.5px] ${
                          s.status === "ACTIVE"
                            ? "bg-[rgba(61,220,151,0.15)] text-pos"
                            : s.status === "PAUSED"
                              ? "bg-[rgba(245,184,65,0.15)] text-warn"
                              : "bg-[rgba(255,92,122,0.15)] text-neg"
                        }`}
                      >
                        {s.status.toLowerCase()}
                      </span>
                      {s.churnReason && (
                        <span className="ml-1.5 text-[10.5px] text-muted">
                          {humanReason(s.churnReason)}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="min-w-0 rounded-card border border-line bg-panel p-[18px]">
          <div className="mb-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
            Why clients left
          </div>
          {view.churn.length === 0 ? (
            <p data-testid="churn-empty" className="py-4 text-[12.5px] text-muted">
              Nobody has churned. Long may it last.
            </p>
          ) : (
            <div data-testid="churn-breakdown" className="grid gap-1.5">
              {view.churn.map((row) => (
                <div key={row.reason} className="flex items-baseline gap-2 text-[12px]">
                  <span className="min-w-0 flex-1 truncate">{humanReason(row.reason)}</span>
                  <span className="text-muted">×{row.count}</span>
                  <span className="tabular-nums text-neg">−{huf(row.lostMrr)}</span>
                </div>
              ))}
              <p className="mt-1.5 border-t border-line pt-2 text-[11px] text-muted">
                Reasons come from a fixed list ({CHURN_REASONS.length} of them), so the
                breakdown counts rather than collects synonyms.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
