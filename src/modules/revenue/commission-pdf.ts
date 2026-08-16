/**
 * The payroll PDF (playbook-v3 P11/1d).
 *
 * Branded from Workspace.brand like every other artefact (P2/6), and rendered
 * from data only — no AI anywhere near a document that decides what somebody is
 * paid, which is the same rule CLAUDE.md sets for legal documents and for the
 * same reason.
 */

import type { WorkspaceBrand } from "@/modules/workspaces/brand";
import type { CommissionReport, SettlementReport } from "./commission-data";
import { COMMISSION_RATE, WINDOW_MONTHS } from "./commission";

function huf(n: number): string {
  return `${Math.round(n).toLocaleString("hu-HU")} Ft`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function shell(brand: WorkspaceBrand, title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  @page { size: A4; margin: 18mm 14mm; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
         color: #12162B; font-size: 11px; margin: 0; }
  .head { display: flex; align-items: flex-end; border-bottom: 2px solid ${brand.color}; padding-bottom: 8px; margin-bottom: 14px; }
  .brand { font-size: 20px; letter-spacing: -0.02em; }
  .brand b { font-weight: 800; } .brand span { font-weight: 300; color: #6B7290; margin-left: 5px; }
  .title { margin-left: auto; text-align: right; }
  .title b { display: block; font-size: 15px; }
  .title span { color: #6B7290; }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: #6B7290; margin: 16px 0 6px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 9px; text-transform: uppercase; letter-spacing: 0.06em;
       color: #6B7290; border-bottom: 1px solid #D7DAE6; padding: 4px 6px; }
  td { padding: 5px 6px; border-bottom: 1px solid #EEF0F6; }
  td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; }
  .user { margin-top: 14px; page-break-inside: avoid; }
  .user h3 { font-size: 13px; margin: 0 0 4px; }
  .totals { background: #F4F5FA; font-weight: 700; }
  .muted { color: #6B7290; }
  .note { margin-top: 16px; padding: 8px 10px; background: #F4F5FA; border-left: 3px solid ${brand.color};
          color: #444B66; font-size: 10px; }
  .foot { margin-top: 18px; border-top: 1px solid #D7DAE6; padding-top: 6px; color: #6B7290; font-size: 9px; }
</style></head><body>
  <div class="head">
    <div class="brand"><b>${esc(brand.markBold)}</b><span>${esc(brand.markLight)}</span></div>
    <div class="title"><b>${esc(title)}</b><span>Computation only — no payment is made by this system</span></div>
  </div>
  ${body}
  <div class="foot">${esc(brand.footerIdentity)} · generated ${new Date().toISOString().slice(0, 10)}</div>
</body></html>`;
}

export function buildCommissionPdfHtml(
  report: CommissionReport,
  brand: WorkspaceBrand,
): string {
  const rate = `${Math.round(COMMISSION_RATE * 100)}%`;
  const users = report.users
    .map((user) => {
      const name = user.userId
        ? esc(report.userNames[user.userId] ?? user.userId)
        : "Unattributed";
      const rows = user.lines
        .map((line) => {
          const referrer = report.referrers[line.companyId];
          return `<tr>
            <td>${esc(line.companyName)}${
              referrer ? `<br><span class="muted">via ${esc(referrer)}</span>` : ""
            }</td>
            <td>${line.recurring ? "recurring" : "one-off"}</td>
            <td class="n">${line.recurring ? `${line.monthsRemaining} / ${WINDOW_MONTHS}` : "—"}</td>
            <td class="n">${huf(line.receivedNet)}</td>
            <td class="n">${
              line.outsideWindow
                ? `<span class="muted">outside window</span>`
                : huf(line.commission)
            }</td>
          </tr>`;
        })
        .join("");

      return `<div class="user">
        <h3>${name}</h3>
        <table>
          <thead><tr>
            <th>Client</th><th>Type</th><th class="n">Window left</th>
            <th class="n">Received (net)</th><th class="n">Commission</th>
          </tr></thead>
          <tbody>
            ${rows}
            ${
              user.carriedIn !== 0
                ? `<tr><td colspan="4" class="muted">Balance carried forward</td><td class="n">${huf(user.carriedIn)}</td></tr>`
                : ""
            }
            <tr class="totals"><td colspan="4">Due to ${name}</td><td class="n">${huf(user.payable)}</td></tr>
            ${
              user.carriedOut !== 0
                ? `<tr><td colspan="4" class="muted">Carried to next month</td><td class="n">${huf(user.carriedOut)}</td></tr>`
                : ""
            }
          </tbody>
        </table>
      </div>`;
    })
    .join("");

  const body = `
    <h2>Commission — ${esc(report.month)}</h2>
    ${users || `<p class="muted">No payments were received in this month.</p>`}
    <table style="margin-top:14px">
      <tbody><tr class="totals"><td>Total payable</td><td class="n">${huf(report.totalPayable)}</td></tr></tbody>
    </table>
    <div class="note">
      ${rate} of the net (VAT-excluded) revenue actually received in the month.
      One-off sales are commissioned once on full payment. Recurring revenue is
      commissioned for ${WINDOW_MONTHS} months from the client's first payment, and only
      in months where a payment was received. Refunds reduce the month and any
      remainder offsets future payouts — never a negative payment.
    </div>`;

  return shell(brand, `Commission ${report.month}`, body);
}

export function buildSettlementPdfHtml(
  report: SettlementReport,
  brand: WorkspaceBrand,
): string {
  const users = report.users
    .map((user) => {
      const name = user.userId
        ? esc(report.userNames[user.userId] ?? user.userId)
        : "Unattributed";
      const rows = user.lines
        .map(
          (line) => `<tr>
            <td>${esc(line.companyName)}</td>
            <td class="n">${huf(line.currentMonthlyNet)}</td>
            <td class="n">${line.monthsRemaining}</td>
            <td class="n">${huf(line.remainingNet)}</td>
            <td class="n">${huf(line.commission)}</td>
          </tr>`,
        )
        .join("");
      return `<div class="user">
        <h3>${name}</h3>
        <table>
          <thead><tr>
            <th>Client</th><th class="n">Monthly net</th><th class="n">Months left</th>
            <th class="n">Remaining revenue</th><th class="n">Remaining commission</th>
          </tr></thead>
          <tbody>${rows}
            <tr class="totals"><td colspan="3">Settlement for ${name}</td>
              <td class="n">${huf(user.totalRemainingNet)}</td>
              <td class="n">${huf(user.totalCommission)}</td></tr>
          </tbody>
        </table>
      </div>`;
    })
    .join("");

  const body = `
    <h2>Termination settlement — end date ${esc(report.endDate)}</h2>
    ${users || `<p class="muted">No commission window is still open on that date.</p>`}
    <table style="margin-top:14px">
      <tbody><tr class="totals">
        <td>Total</td>
        <td class="n">${huf(report.totalRemainingNet)} revenue</td>
        <td class="n">${huf(report.totalCommission)} commission</td>
      </tr></tbody>
    </table>
    <div class="note">
      Each open ${WINDOW_MONTHS}-month window is valued at its current monthly net recurring
      fee × the months remaining after the end date. BOTH figures are shown:
      the remaining revenue (the clause's formula as written) and
      ${Math.round(COMMISSION_RATE * 100)}% of it (consistent with the monthly rule).
      Confirm which of the two is the settlement figure before paying.
    </div>`;

  return shell(brand, `Settlement ${report.endDate}`, body);
}
