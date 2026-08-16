/**
 * BDR commission (playbook-v3 P11/1d). Pure, and deliberately so: this decides
 * what a person is paid, so every figure has to be reproducible from its inputs
 * without a database, a clock or a network.
 *
 * THE CONTRACT, clause by clause:
 *
 *   1. 10% of the NET (VAT-excluded) revenue actually RECEIVED in that month.
 *   2. One-off sales: commission once, after the client's full payment has been
 *      received. Not limited by the window — a sale is a sale.
 *   3. Recurring revenue: monthly for 12 months counted from the client's FIRST
 *      payment, and only months with an actual received payment pay anything.
 *      An open window is not itself a reason to pay.
 *   4. Refunds and reversals remove the commission for that amount and offset
 *      against FUTURE payouts — they never produce a negative payment.
 *   5. Termination: the remaining commission across every open window.
 *
 * The system computes. It never moves money.
 *
 * ⚠️ ONE AMBIGUITY IN CLAUSE 5, resolved explicitly rather than silently. The
 * clause gives the formula as (current monthly net recurring fee × remaining
 * months in the window) and calls the result "the remaining commission". Taken
 * literally that is the remaining REVENUE, ten times the rate every other
 * clause uses. `terminationSettlement` therefore reports BOTH — `remainingNet`
 * (the formula as written) and `commission` (10% of it, consistent with clause
 * 1) — so the settlement figure is unambiguous whichever reading is intended,
 * and changing the answer is a choice of column rather than a code change.
 */

import { monthKey, monthsBetween } from "./subscriptions";

export const COMMISSION_RATE = 0.1;
export const WINDOW_MONTHS = 12;

/** Whole forints. Money is an integer (CLAUDE.md). */
function commissionOn(net: number): number {
  return Math.round(net * COMMISSION_RATE);
}

export interface PaymentRecord {
  companyId: string;
  companyName: string;
  /** NET forints received. NEGATIVE for a refund or reversal. */
  netAmount: number;
  receivedAt: Date;
  /** Recurring payments are governed by the 12-month window; one-offs are not. */
  recurring: boolean;
  /** The sourcing user. Null when nobody is attributable. */
  attributedUserId: string | null;
}

export interface CommissionLine {
  companyId: string;
  companyName: string;
  windowStart: Date | null;
  /** Months left in the 12-month window AFTER the reported month. */
  monthsRemaining: number;
  /** Net received from this client in the month; can be negative. */
  receivedNet: number;
  commission: number;
  recurring: boolean;
  /** Received, but the recurring window had closed — shown, not paid. */
  outsideWindow: boolean;
}

export interface UserCommission {
  userId: string | null;
  lines: CommissionLine[];
  /** Sum of the lines. Can be negative when refunds outweigh receipts. */
  grossCommission: number;
  /** Negative balance brought forward from earlier months. */
  carriedIn: number;
  /** What payroll should pay. Never negative. */
  payable: number;
  /** Negative remainder to offset against the next month. */
  carriedOut: number;
}

/**
 * The client's FIRST payment, which anchors the recurring window.
 *
 * Any payment, not merely the first recurring one: the contract says "the
 * client's first payment", and a client who bought a one-off project before
 * signing a retainer started paying on the earlier date.
 */
export function windowStartFor(payments: PaymentRecord[]): Date | null {
  const receipts = payments.filter((p) => p.netAmount > 0);
  if (receipts.length === 0) return null;
  return receipts.reduce(
    (earliest, p) => (p.receivedAt < earliest ? p.receivedAt : earliest),
    receipts[0].receivedAt,
  );
}

/** Is this month inside the client's 12-month recurring window? */
function insideWindow(windowStart: Date | null, at: Date): boolean {
  if (!windowStart) return false;
  const elapsed = monthsBetween(windowStart, at);
  return elapsed >= 0 && elapsed < WINDOW_MONTHS;
}

/**
 * Months left in the window after `endDate`.
 *
 * The month containing `endDate` is treated as spent — it has been worked and
 * is being paid in the ordinary monthly run, so counting it again in the lump
 * sum would pay for it twice.
 */
export function monthsRemainingInWindow(windowStart: Date, endDate: Date): number {
  const elapsed = monthsBetween(windowStart, endDate);
  return Math.max(0, WINDOW_MONTHS - 1 - elapsed);
}

/**
 * The monthly commission run.
 *
 * Payments from EVERY month are passed in, not only the reported one: the
 * window anchor is the client's first payment ever, which is usually outside
 * the month being reported.
 */
export function computeMonthlyCommission(params: {
  /** `YYYY-MM`. */
  month: string;
  payments: PaymentRecord[];
  /** Negative balances carried in per user, from the previous run. */
  carryIn?: Record<string, number>;
}): UserCommission[] {
  const { month, payments, carryIn = {} } = params;

  // Window anchors need the client's whole payment history.
  const byCompany = new Map<string, PaymentRecord[]>();
  for (const payment of payments) {
    const list = byCompany.get(payment.companyId) ?? [];
    list.push(payment);
    byCompany.set(payment.companyId, list);
  }
  const windowStarts = new Map<string, Date | null>();
  for (const [companyId, list] of byCompany) {
    windowStarts.set(companyId, windowStartFor(list));
  }

  // One line per user per CLIENT, not per payment: a client who paid twice in
  // March is one row on a payroll report, not two.
  const lines = new Map<string, Map<string, CommissionLine>>();
  for (const payment of payments) {
    if (monthKey(payment.receivedAt) !== month) continue;

    const userKey = payment.attributedUserId ?? "";
    const forUser = lines.get(userKey) ?? new Map<string, CommissionLine>();
    const windowStart = windowStarts.get(payment.companyId) ?? null;

    // A one-off is commissioned whenever it lands; only recurring revenue is
    // fenced by the window.
    const outsideWindow = payment.recurring && !insideWindow(windowStart, payment.receivedAt);

    const line =
      forUser.get(payment.companyId) ??
      ({
        companyId: payment.companyId,
        companyName: payment.companyName,
        windowStart,
        monthsRemaining: windowStart
          ? monthsRemainingInWindow(windowStart, payment.receivedAt)
          : 0,
        receivedNet: 0,
        commission: 0,
        recurring: payment.recurring,
        outsideWindow,
      } satisfies CommissionLine);

    line.receivedNet += payment.netAmount;
    if (!outsideWindow) line.commission += commissionOn(payment.netAmount);
    // A client with both kinds in one month is recurring for reporting; the
    // commission itself was already decided per payment above.
    line.recurring = line.recurring || payment.recurring;
    line.outsideWindow = line.outsideWindow && outsideWindow;

    forUser.set(payment.companyId, line);
    lines.set(userKey, forUser);
  }

  const out: UserCommission[] = [];
  for (const [userKey, forUser] of lines) {
    const userId = userKey === "" ? null : userKey;
    const rows = [...forUser.values()].sort(
      (a, b) => b.commission - a.commission || a.companyName.localeCompare(b.companyName, "hu"),
    );
    const gross = rows.reduce((n, l) => n + l.commission, 0);
    const carried = carryIn[userKey] ?? 0;
    const balance = gross + carried;
    out.push({
      userId,
      lines: rows,
      grossCommission: gross,
      carriedIn: carried,
      // Never negative: the system does not claw money back, it offsets.
      payable: Math.max(0, balance),
      carriedOut: Math.min(0, balance),
    });
  }

  return out.sort((a, b) => b.payable - a.payable);
}

// ---- clause 5: termination -------------------------------------------------

export interface OpenWindow {
  companyId: string;
  companyName: string;
  attributedUserId: string | null;
  windowStart: Date;
  /** The live monthly recurring fee, which is what the clause values it at. */
  currentMonthlyNet: number;
}

export interface SettlementLine {
  companyId: string;
  companyName: string;
  monthsRemaining: number;
  currentMonthlyNet: number;
  /** The clause's formula as written: fee × months remaining. */
  remainingNet: number;
  /** 10% of it, consistent with clause 1. */
  commission: number;
}

export interface UserSettlement {
  userId: string | null;
  lines: SettlementLine[];
  totalRemainingNet: number;
  totalCommission: number;
}

/**
 * The final settlement figure at termination.
 *
 * Windows that have already closed contribute nothing and are dropped — there
 * is no remaining commission on a relationship whose twelve months are up.
 */
export function terminationSettlement(
  windows: OpenWindow[],
  endDate: Date,
): UserSettlement[] {
  const byUser = new Map<string, SettlementLine[]>();

  for (const w of windows) {
    const monthsRemaining = monthsRemainingInWindow(w.windowStart, endDate);
    if (monthsRemaining <= 0) continue;
    const remainingNet = w.currentMonthlyNet * monthsRemaining;
    const userKey = w.attributedUserId ?? "";
    const rows = byUser.get(userKey) ?? [];
    rows.push({
      companyId: w.companyId,
      companyName: w.companyName,
      monthsRemaining,
      currentMonthlyNet: w.currentMonthlyNet,
      remainingNet,
      commission: commissionOn(remainingNet),
    });
    byUser.set(userKey, rows);
  }

  return [...byUser.entries()]
    .map(([userKey, rows]) => {
      const sorted = rows.sort(
        (a, b) => b.remainingNet - a.remainingNet || a.companyName.localeCompare(b.companyName, "hu"),
      );
      const totalRemainingNet = sorted.reduce((n, l) => n + l.remainingNet, 0);
      return {
        userId: userKey === "" ? null : userKey,
        lines: sorted,
        totalRemainingNet,
        // Rounded once on the total rather than summing rounded lines, so the
        // total is 10% of the total rather than 10% of each line added up.
        totalCommission: commissionOn(totalRemainingNet),
      };
    })
    .sort((a, b) => b.totalCommission - a.totalCommission);
}
