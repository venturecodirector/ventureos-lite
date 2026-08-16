"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { RevenueView, SubscriptionRow } from "@/modules/revenue/dashboard";
import type { ClientHealthRow } from "@/modules/revenue/health-data";
import { createHealthTask, setSupportFlag } from "@/modules/revenue/health-actions";
import { CHURN_REASONS } from "@/modules/revenue/subscriptions";
import { setSubscriptionStatus } from "@/modules/revenue/actions";
import { AddSubscriptionDialog, ChurnDialog } from "./subscription-dialogs";

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

const LEVEL_STYLE: Record<string, string> = {
  red: "bg-[rgba(255,92,122,0.15)] text-neg",
  amber: "bg-[rgba(245,184,65,0.15)] text-warn",
  green: "bg-[rgba(61,220,151,0.15)] text-pos",
};

/**
 * "Figyelmet igényel" — the clients worth ringing (P11/1c).
 *
 * Reds first and sorted by MRR within a level, because when there is time for
 * one phone call it should be the expensive one. Every row shows WHY, since a
 * traffic light with no explanation is a colour people learn to ignore.
 */
function HealthPanel({ rows }: { rows: ClientHealthRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const attention = rows.filter((r) => r.level !== "green");
  const visible = showAll ? rows : attention;

  async function queueTask(row: ClientHealthRow) {
    setBusy(row.companyId);
    setNote(null);
    try {
      const res = await createHealthTask(row.companyId);
      setNote(
        !res.ok
          ? res.error
          : res.created
            ? `Task queued for ${row.companyName}.`
            : `Already queued for ${row.companyName} today.`,
      );
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function toggleFlag(row: ClientHealthRow) {
    setBusy(row.companyId);
    try {
      await setSupportFlag(row.companyId, !row.supportFlag);
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-card border border-line bg-panel p-[18px]">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
          Figyelmet igényel
        </span>
        {attention.length > 0 && (
          <span className="rounded-full bg-[rgba(255,92,122,0.15)] px-2 py-0.5 text-[11px] text-neg">
            {rows.filter((r) => r.level === "red").length} red · {rows.filter((r) => r.level === "amber").length} amber
          </span>
        )}
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          data-testid="health-show-all"
          className="ml-auto text-[12px] text-muted underline hover:text-ink"
        >
          {showAll ? "only those needing attention" : `show all ${rows.length}`}
        </button>
      </div>

      {note && <p className="mb-2 text-[12px] text-accent-ink">{note}</p>}

      {visible.length === 0 ? (
        <p data-testid="health-empty" className="py-4 text-[12.5px] text-muted">
          {rows.length === 0
            ? "No clients yet."
            : "Every client is green — nothing needs chasing."}
        </p>
      ) : (
        <div data-testid="health-list" className="grid gap-1.5">
          {visible.map((row) => (
            <div
              key={row.companyId}
              data-testid="health-row"
              data-level={row.level}
              className="flex flex-wrap items-center gap-2 rounded-[10px] border border-line bg-[rgba(0,5,29,0.35)] px-3 py-2"
            >
              <span
                className={`rounded-full px-2 py-0.5 text-[10.5px] font-semibold ${LEVEL_STYLE[row.level]}`}
              >
                {row.level}
              </span>
              <span className="min-w-0 flex-1">
                <b className="block text-[12.5px]">{row.companyName}</b>
                <span className="block text-[11.5px] text-muted">
                  {row.reasons.length > 0 ? row.reasons.join(" · ") : "Healthy"}
                </span>
              </span>
              <span className="tabular-nums text-[12px] text-muted">{huf(row.mrr)}/mo</span>
              <button
                type="button"
                onClick={() => toggleFlag(row)}
                disabled={busy === row.companyId}
                data-testid="health-flag"
                title="Manual support flag"
                className={`rounded-[8px] border px-2 py-1 text-[11.5px] ${
                  row.supportFlag
                    ? "border-warn text-warn"
                    : "border-line text-muted hover:text-ink"
                }`}
              >
                {row.supportFlag ? "flagged" : "flag"}
              </button>
              {row.level === "red" && (
                <button
                  type="button"
                  onClick={() => queueTask(row)}
                  disabled={busy === row.companyId}
                  data-testid="health-task"
                  className="rounded-[8px] border border-line bg-panel px-2 py-1 text-[11.5px] hover:bg-panel-2 disabled:opacity-50"
                >
                  Queue call
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const STATUS_FILTERS = ["ALL", "ACTIVE", "PAUSED", "CHURNED"] as const;

export function RevenueTab({ view }: { view: RevenueView }) {
  const router = useRouter();
  const [status, setStatus] = useState<(typeof STATUS_FILTERS)[number]>("ACTIVE");
  const [adding, setAdding] = useState(false);
  const [churning, setChurning] = useState<SubscriptionRow | null>(null);
  const [rowBusy, setRowBusy] = useState<string | null>(null);

  async function togglePause(row: SubscriptionRow) {
    setRowBusy(row.id);
    try {
      await setSubscriptionStatus({
        subscriptionId: row.id,
        status: row.status === "PAUSED" ? "ACTIVE" : "PAUSED",
      });
      router.refresh();
    } finally {
      setRowBusy(null);
    }
  }

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

      <HealthPanel rows={view.health} />

      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <div className="min-w-0 rounded-card border border-line bg-panel p-[18px]">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
              Subscriptions
            </span>
            <button
              type="button"
              onClick={() => setAdding(true)}
              data-testid="add-subscription"
              className="rounded-[8px] border border-line bg-panel px-2 py-1 text-[11.5px] hover:bg-panel-2"
            >
              + Add
            </button>
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
                  <th className="pb-2 text-right font-semibold" />
                </tr>
              </thead>
              <tbody data-testid="subscriptions-table">
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="py-6 text-center text-muted">
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
                    <td className="py-2 text-right">
                      {s.status !== "CHURNED" && (
                        <span className="inline-flex gap-1.5">
                          <button
                            type="button"
                            onClick={() => togglePause(s)}
                            disabled={rowBusy === s.id}
                            data-testid="sub-pause"
                            className="rounded-[8px] border border-line px-2 py-1 text-[11px] text-muted hover:text-ink disabled:opacity-50"
                          >
                            {s.status === "PAUSED" ? "resume" : "pause"}
                          </button>
                          <button
                            type="button"
                            onClick={() => setChurning(s)}
                            data-testid="sub-churn"
                            className="rounded-[8px] border border-line px-2 py-1 text-[11px] text-muted hover:text-[#FFB3C2]"
                          >
                            end
                          </button>
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

      {adding && <AddSubscriptionDialog onClose={() => setAdding(false)} />}
      {churning && (
        <ChurnDialog
          subscriptionId={churning.id}
          companyName={churning.companyName}
          monthlyNet={churning.monthlyNet}
          onClose={() => setChurning(null)}
        />
      )}
    </div>
  );
}
