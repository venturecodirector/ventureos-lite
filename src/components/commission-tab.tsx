"use client";

import { useState } from "react";
import {
  exportCommissionPdf,
  exportSettlementPdf,
  getCommissionReport,
  getSettlementReport,
} from "@/modules/revenue/commission-actions";
import type { CommissionReport, SettlementReport } from "@/modules/revenue/commission-data";
import { COMMISSION_RATE, WINDOW_MONTHS } from "@/modules/revenue/commission";

/**
 * The commission report (playbook-v3 P11/1d). Owner-only, computation only.
 *
 * Everything is on screen before it is on a PDF: a payroll number nobody can
 * check in the app is a number nobody can argue with, and this one is somebody's
 * pay.
 */

function huf(n: number): string {
  return `${Math.round(n).toLocaleString("hu-HU")} Ft`;
}

function thisMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function CommissionTab({ initialMonth }: { initialMonth?: string }) {
  const [month, setMonth] = useState(initialMonth ?? thisMonth());
  const [report, setReport] = useState<CommissionReport | null>(null);
  const [endDate, setEndDate] = useState(today());
  const [settlement, setSettlement] = useState<SettlementReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const res = await getCommissionReport(month);
      if (!res.ok) {
        setError(res.error);
        setReport(null);
        return;
      }
      setReport(res.report);
    } finally {
      setBusy(false);
    }
  }

  async function runSettlement() {
    setBusy(true);
    setError(null);
    try {
      const res = await getSettlementReport(endDate);
      if (!res.ok) {
        setError(res.error);
        setSettlement(null);
        return;
      }
      setSettlement(res.report);
    } finally {
      setBusy(false);
    }
  }

  async function exportPdf(kind: "monthly" | "settlement") {
    setBusy(true);
    setNote(null);
    try {
      const res =
        kind === "monthly" ? await exportCommissionPdf(month) : await exportSettlementPdf(endDate);
      if (!res.ok) setError(res.error);
      else
        setNote(
          `Queued for rendering. It will appear at ${res.path} — the export is recorded in the audit log.`,
        );
    } finally {
      setBusy(false);
    }
  }

  const button =
    "rounded-[10px] border border-line bg-panel px-3 py-1.5 text-[12.5px] hover:bg-panel-2 disabled:opacity-50";

  return (
    <div className="grid gap-4">
      <div className="rounded-card border border-line bg-panel p-[18px]">
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <h2 className="font-display text-lg font-bold lowercase">monthly commission</h2>
          <span className="rounded-full border border-line px-2 py-0.5 text-[10.5px] text-muted">
            owner-only
          </span>
          <span className="rounded-full border border-line px-2 py-0.5 text-[10.5px] text-muted">
            computation only — no money moves
          </span>
        </div>
        <p className="mb-3 text-[12.5px] text-muted">
          {Math.round(COMMISSION_RATE * 100)}% of the net received in the month. One-offs
          commission once on full payment; recurring revenue for {WINDOW_MONTHS} months from the
          client&apos;s first payment, and only in months a payment arrived. Refunds
          reduce the month and any remainder offsets the next one.
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <input
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            data-testid="commission-month"
            className="rounded-[8px] border border-line bg-[rgba(0,5,29,0.5)] px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-accent"
          />
          <button type="button" onClick={run} disabled={busy} data-testid="commission-run" className={button}>
            {busy ? "Working…" : "Compute"}
          </button>
          <button
            type="button"
            onClick={() => exportPdf("monthly")}
            disabled={busy || !report}
            data-testid="commission-export"
            className={button}
          >
            Export PDF for payroll
          </button>
        </div>

        {error && <p className="mt-2 text-[12.5px] text-[#FFB3C2]">{error}</p>}
        {note && <p className="mt-2 text-[12.5px] text-accent-ink">{note}</p>}

        {report && (
          <div className="mt-4" data-testid="commission-report">
            {report.users.length === 0 ? (
              <p data-testid="commission-empty" className="py-4 text-[12.5px] text-muted">
                No payments were received in {report.month}.
              </p>
            ) : (
              report.users.map((user) => (
                <div key={user.userId ?? "none"} data-testid="commission-user" className="mb-4">
                  <div className="mb-1.5 flex items-baseline gap-2">
                    <b className="text-[13px]">
                      {user.userId ? (report.userNames[user.userId] ?? user.userId) : "Unattributed"}
                    </b>
                    <span className="ml-auto tabular-nums text-[13px]">
                      due <b data-testid="commission-payable">{huf(user.payable)}</b>
                    </span>
                  </div>
                  <table className="w-full text-[12px]">
                    <thead>
                      <tr className="text-[10.5px] uppercase tracking-[0.1em] text-muted">
                        <th className="pb-1.5 text-left font-semibold">Client</th>
                        <th className="pb-1.5 text-left font-semibold">Type</th>
                        <th className="pb-1.5 text-right font-semibold">Window left</th>
                        <th className="pb-1.5 text-right font-semibold">Received (net)</th>
                        <th className="pb-1.5 text-right font-semibold">Commission</th>
                      </tr>
                    </thead>
                    <tbody>
                      {user.lines.map((line) => (
                        <tr
                          key={line.companyId}
                          data-testid="commission-line"
                          className="border-t border-line"
                        >
                          <td className="py-1.5">
                            {line.companyName}
                            {report.referrers[line.companyId] && (
                              <span className="block text-[11px] text-muted">
                                via {report.referrers[line.companyId]}
                              </span>
                            )}
                          </td>
                          <td className="py-1.5 text-muted">
                            {line.recurring ? "recurring" : "one-off"}
                          </td>
                          <td className="py-1.5 text-right tabular-nums text-muted">
                            {line.recurring ? `${line.monthsRemaining}/${WINDOW_MONTHS}` : "—"}
                          </td>
                          <td className="py-1.5 text-right tabular-nums">{huf(line.receivedNet)}</td>
                          <td className="py-1.5 text-right tabular-nums">
                            {line.outsideWindow ? (
                              <span className="text-muted">outside window</span>
                            ) : (
                              huf(line.commission)
                            )}
                          </td>
                        </tr>
                      ))}
                      {user.carriedIn !== 0 && (
                        <tr className="border-t border-line text-muted">
                          <td className="py-1.5" colSpan={4}>
                            Balance carried forward
                          </td>
                          <td className="py-1.5 text-right tabular-nums">{huf(user.carriedIn)}</td>
                        </tr>
                      )}
                      {user.carriedOut !== 0 && (
                        <tr className="border-t border-line text-warn">
                          <td className="py-1.5" colSpan={4}>
                            Carried to next month
                          </td>
                          <td
                            className="py-1.5 text-right tabular-nums"
                            data-testid="commission-carry"
                          >
                            {huf(user.carriedOut)}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              ))
            )}
            <div className="border-t border-line pt-2 text-right text-[13px]">
              total payable{" "}
              <b className="tabular-nums" data-testid="commission-total">
                {huf(report.totalPayable)}
              </b>
            </div>
          </div>
        )}
      </div>

      <div className="rounded-card border border-line bg-panel p-[18px]">
        <h2 className="mb-1 font-display text-lg font-bold lowercase">termination settlement</h2>
        <p className="mb-3 text-[12.5px] text-muted">
          Every open {WINDOW_MONTHS}-month window valued at its current monthly net fee ×
          the months remaining after the end date.{" "}
          <b>Both figures are shown</b> — the remaining revenue (the clause&apos;s
          formula as written) and {Math.round(COMMISSION_RATE * 100)}% of it. Confirm which one
          is the settlement figure before paying.
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            data-testid="settlement-date"
            className="rounded-[8px] border border-line bg-[rgba(0,5,29,0.5)] px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-accent"
          />
          <button
            type="button"
            onClick={runSettlement}
            disabled={busy}
            data-testid="settlement-run"
            className={button}
          >
            Calculate
          </button>
          <button
            type="button"
            onClick={() => exportPdf("settlement")}
            disabled={busy || !settlement}
            data-testid="settlement-export"
            className={button}
          >
            Export PDF
          </button>
        </div>

        {settlement && (
          <div className="mt-4" data-testid="settlement-report">
            {settlement.users.length === 0 ? (
              <p data-testid="settlement-empty" className="py-4 text-[12.5px] text-muted">
                No commission window is still open on {settlement.endDate}.
              </p>
            ) : (
              settlement.users.map((user) => (
                <div key={user.userId ?? "none"} className="mb-4" data-testid="settlement-user">
                  <b className="mb-1.5 block text-[13px]">
                    {user.userId ? (settlement.userNames[user.userId] ?? user.userId) : "Unattributed"}
                  </b>
                  <table className="w-full text-[12px]">
                    <thead>
                      <tr className="text-[10.5px] uppercase tracking-[0.1em] text-muted">
                        <th className="pb-1.5 text-left font-semibold">Client</th>
                        <th className="pb-1.5 text-right font-semibold">Monthly net</th>
                        <th className="pb-1.5 text-right font-semibold">Months left</th>
                        <th className="pb-1.5 text-right font-semibold">Remaining revenue</th>
                        <th className="pb-1.5 text-right font-semibold">Remaining commission</th>
                      </tr>
                    </thead>
                    <tbody>
                      {user.lines.map((line) => (
                        <tr key={line.companyId} className="border-t border-line" data-testid="settlement-line">
                          <td className="py-1.5">{line.companyName}</td>
                          <td className="py-1.5 text-right tabular-nums">{huf(line.currentMonthlyNet)}</td>
                          <td className="py-1.5 text-right tabular-nums">{line.monthsRemaining}</td>
                          <td className="py-1.5 text-right tabular-nums">{huf(line.remainingNet)}</td>
                          <td className="py-1.5 text-right tabular-nums">{huf(line.commission)}</td>
                        </tr>
                      ))}
                      <tr className="border-t border-line font-semibold">
                        <td className="py-1.5" colSpan={3}>
                          Settlement
                        </td>
                        <td className="py-1.5 text-right tabular-nums" data-testid="settlement-net">
                          {huf(user.totalRemainingNet)}
                        </td>
                        <td
                          className="py-1.5 text-right tabular-nums"
                          data-testid="settlement-commission"
                        >
                          {huf(user.totalCommission)}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
