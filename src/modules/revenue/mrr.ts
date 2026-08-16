/**
 * The MRR maths (playbook-v3 P11/1b). Pure.
 *
 * Everything here reads the append-only event log rather than the current state
 * of the book, which is what makes the movement chart exact: it can say what
 * happened in March even if the subscription has since been re-priced twice and
 * churned.
 */

import { monthKey, type EventKind } from "./subscriptions";

export interface MovementEvent {
  kind: EventKind;
  deltaNet: number;
  at: Date;
}

export interface MovementRow {
  month: string;
  new: number;
  expansion: number;
  contraction: number;
  churn: number;
  reactivation: number;
  /** The five buckets summed — always equal to the deltas in that month. */
  net: number;
  /** Running MRR at the end of the month. */
  endingMrr: number;
}

/** Contiguous `YYYY-MM` keys from one date to another, both ends included. */
export function monthRange(from: Date, to: Date): string[] {
  const out: string[] = [];
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  const end = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1));
  while (cursor <= end) {
    out.push(monthKey(cursor));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return out;
}

/**
 * Which column an event lands in.
 *
 * The playbook names four buckets. A PAUSE takes MRR off the book in exactly
 * the way a churn does, and a RESUME puts it back exactly as a reactivation
 * does, so they render in the bucket that describes what happened to the money
 * rather than adding two more columns a reader has to interpret. The event log
 * keeps the distinction; only the chart folds it.
 */
function bucketOf(kind: EventKind): keyof Omit<MovementRow, "month" | "net" | "endingMrr"> {
  switch (kind) {
    case "new":
      return "new";
    case "expansion":
      return "expansion";
    case "contraction":
      return "contraction";
    case "churn":
    case "pause":
      return "churn";
    case "reactivation":
    case "resume":
      return "reactivation";
  }
}

function emptyRow(month: string): MovementRow {
  return {
    month,
    new: 0,
    expansion: 0,
    contraction: 0,
    churn: 0,
    reactivation: 0,
    net: 0,
    endingMrr: 0,
  };
}

/**
 * Bucket every event by month and run the balance forward.
 *
 * Events BEFORE the window are not shown but are not ignored either: they set
 * the opening balance. Without that, a chart of the last six months claims the
 * book started at zero six months ago.
 */
export function buildMovement(events: MovementEvent[], months: string[]): MovementRow[] {
  if (months.length === 0) return [];
  const first = months[0];

  const rows = new Map(months.map((m) => [m, emptyRow(m)]));
  let opening = 0;

  for (const event of events) {
    const month = monthKey(event.at);
    if (month < first) {
      opening += event.deltaNet;
      continue;
    }
    const row = rows.get(month);
    // After the window — a chart of January to March does not show April.
    if (!row) continue;
    row[bucketOf(event.kind)] += event.deltaNet;
    row.net += event.deltaNet;
  }

  let running = opening;
  const out: MovementRow[] = [];
  for (const month of months) {
    const row = rows.get(month)!;
    running += row.net;
    row.endingMrr = running;
    out.push(row);
  }
  return out;
}

// ---- headline numbers -----------------------------------------------------

export interface BookEntry {
  monthlyNet: number;
  status: "ACTIVE" | "PAUSED" | "CHURNED";
  companyId: string;
}

export interface BookSummary {
  mrr: number;
  arr: number;
  clientCount: number;
  averagePerClient: number;
  activeCount: number;
  pausedCount: number;
  churnedCount: number;
}

/**
 * The headline numbers.
 *
 * Only ACTIVE subscriptions count towards MRR: a paused one bills nothing this
 * month, and including it would report revenue that is not going to arrive.
 * Clients are counted DISTINCT — a client on hosting and a retainer is one
 * client, and counting subscriptions instead would flatter both the count and
 * the average.
 */
export function summarizeBook(book: BookEntry[]): BookSummary {
  const active = book.filter((b) => b.status === "ACTIVE");
  const mrr = active.reduce((n, b) => n + b.monthlyNet, 0);
  const clients = new Set(active.map((b) => b.companyId));
  return {
    mrr,
    arr: mrr * 12,
    clientCount: clients.size,
    averagePerClient: clients.size === 0 ? 0 : Math.round(mrr / clients.size),
    activeCount: active.length,
    pausedCount: book.filter((b) => b.status === "PAUSED").length,
    churnedCount: book.filter((b) => b.status === "CHURNED").length,
  };
}

// ---- churn breakdown (P11/1e) --------------------------------------------

export interface ChurnRow {
  reason: string;
  count: number;
  /** Positive: the MRR this reason took off the book. */
  lostMrr: number;
}

/**
 * Why the book shrank, worst first.
 *
 * A churn with no recorded reason still gets a row rather than being dropped —
 * otherwise the breakdown stops adding up to the churn on the chart, and the
 * difference is invisible.
 */
export function churnBreakdown(
  churnEvents: Array<{ reason: string | null; deltaNet: number }>,
): ChurnRow[] {
  const byReason = new Map<string, ChurnRow>();
  for (const event of churnEvents) {
    const reason = event.reason ?? "unknown";
    const row = byReason.get(reason) ?? { reason, count: 0, lostMrr: 0 };
    row.count += 1;
    row.lostMrr += Math.abs(event.deltaNet);
    byReason.set(reason, row);
  }
  return [...byReason.values()].sort(
    (a, b) => b.lostMrr - a.lostMrr || a.reason.localeCompare(b.reason),
  );
}
