/**
 * Loading the Revenue tab (playbook-v3 P11/1b).
 *
 * Reads the event log for the chart and the current book for the headline
 * numbers, then hands both to the pure maths in `mrr.ts`.
 */

import { getWorkspaceClient } from "@/lib/db";
import {
  buildMovement,
  churnBreakdown,
  monthRange,
  summarizeBook,
  type BookSummary,
  type ChurnRow,
  type MovementRow,
} from "./mrr";
import type { EventKind } from "./subscriptions";
import { loadClientHealth, type ClientHealthRow } from "./health-data";

/** How far back the movement chart looks by default. */
export const MOVEMENT_MONTHS = 12;

export interface SubscriptionRow {
  id: string;
  companyId: string;
  companyName: string;
  planName: string;
  monthlyNet: number;
  status: "ACTIVE" | "PAUSED" | "CHURNED";
  source: string;
  startDate: Date;
  churnedAt: Date | null;
  churnReason: string | null;
}

export interface RevenueView {
  summary: BookSummary;
  movement: MovementRow[];
  subscriptions: SubscriptionRow[];
  churn: ChurnRow[];
  /** "Figyelmet igényel" — every client scored, worst first (P11/1c). */
  health: ClientHealthRow[];
}

export async function loadRevenue(
  workspaceId: string,
  now: Date = new Date(),
): Promise<RevenueView> {
  const db = getWorkspaceClient(workspaceId);

  const [subs, events, health] = await Promise.all([
    db.subscription.findMany({
      orderBy: [{ status: "asc" }, { monthlyNet: "desc" }],
      select: {
        id: true,
        companyId: true,
        planName: true,
        monthlyNet: true,
        status: true,
        source: true,
        startDate: true,
        churnedAt: true,
        churnReason: true,
        company: { select: { name: true } },
      },
    }),
    // EVERY event, not just the window: anything before it sets the opening
    // balance, and without that the chart claims the book started at zero.
    db.subscriptionEvent.findMany({
      orderBy: { at: "asc" },
      select: { kind: true, deltaNet: true, at: true, reason: true },
    }),
    loadClientHealth(workspaceId, now),
  ]);

  const from = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (MOVEMENT_MONTHS - 1), 1),
  );
  const movement = buildMovement(
    events.map((e) => ({ kind: e.kind as EventKind, deltaNet: e.deltaNet, at: e.at })),
    monthRange(from, now),
  );

  return {
    summary: summarizeBook(
      subs.map((s) => ({
        monthlyNet: s.monthlyNet,
        status: s.status as "ACTIVE" | "PAUSED" | "CHURNED",
        companyId: s.companyId,
      })),
    ),
    movement,
    subscriptions: subs.map((s) => ({
      id: s.id,
      companyId: s.companyId,
      companyName: s.company?.name ?? "—",
      planName: s.planName,
      monthlyNet: s.monthlyNet,
      status: s.status as "ACTIVE" | "PAUSED" | "CHURNED",
      source: s.source,
      startDate: s.startDate,
      churnedAt: s.churnedAt,
      churnReason: s.churnReason,
    })),
    health,
    churn: churnBreakdown(
      events
        .filter((e) => e.kind === "churn")
        .map((e) => ({ reason: e.reason, deltaNet: e.deltaNet })),
    ),
  };
}
