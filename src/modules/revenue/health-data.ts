/**
 * Gathering the health inputs (playbook-v3 P11/1c).
 *
 * Four inputs, all already in the system. The only one with a modelling gap is
 * payment lateness: Invoice has no due-date column, so lateness is measured
 * from the ISSUE date and the amber threshold effectively encodes the payment
 * term (15 days by default). Written down here rather than hidden, because a
 * real due date would change the numbers and should when it arrives.
 */

import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import {
  healthRulesFrom,
  scoreClientHealth,
  suggestedTaskFor,
  type HealthLevel,
  type HealthRules,
  type SuggestedTask,
} from "./health";
import { monthsBetween } from "./subscriptions";

export interface ClientHealthRow {
  companyId: string;
  companyName: string;
  level: HealthLevel;
  reasons: string[];
  /** What this client is worth per month, so the list sorts by what is at stake. */
  mrr: number;
  daysPaymentLate: number;
  monthsSinceTouchpoint: number;
  supportFlag: boolean;
  subscriptionAgeMonths: number;
  suggestedTask: SuggestedTask | null;
}

const DAY_MS = 86_400_000;

export async function loadHealthRules(workspaceId: string): Promise<HealthRules> {
  const ws = await prismaUnsafe.workspace.findUnique({
    where: { id: workspaceId },
    select: { featureFlags: true },
  });
  const flags = (ws?.featureFlags ?? {}) as Record<string, unknown>;
  return healthRulesFrom(flags.clientHealth);
}

/**
 * Score every client company.
 *
 * "Client" means a company with a live subscription — a former client has
 * nothing left to protect, and a prospect is not a client at all.
 */
export async function loadClientHealth(
  workspaceId: string,
  now: Date = new Date(),
): Promise<ClientHealthRow[]> {
  const db = getWorkspaceClient(workspaceId);
  const rules = await loadHealthRules(workspaceId);

  const subs = await db.subscription.findMany({
    where: { status: { in: ["ACTIVE", "PAUSED"] } },
    select: {
      companyId: true,
      monthlyNet: true,
      status: true,
      startDate: true,
      company: { select: { id: true, name: true, supportFlag: true } },
    },
  });
  if (subs.length === 0) return [];

  const companyIds = [...new Set(subs.map((s) => s.companyId))];

  const [unpaid, leads, threads] = await Promise.all([
    // Lateness reference: the issue date, because there is no due date column.
    db.invoice.findMany({
      where: { companyId: { in: companyIds }, paidAt: null, status: { in: ["SUBMITTED", "ISSUED"] } },
      select: { companyId: true, at: true },
    }),
    // Touchpoints hang off leads, so the lead ids come first.
    db.lead.findMany({
      where: { companyId: { in: companyIds } },
      select: { id: true, companyId: true, lastActivityAt: true },
    }),
    db.emailThread.findMany({
      where: { companyId: { in: companyIds } },
      select: { companyId: true, lastMessageAt: true },
    }),
  ]);

  const leadIds = leads.map((l) => l.id);
  const [activities, calls] = await Promise.all([
    leadIds.length
      ? db.activity.findMany({
          where: { leadId: { in: leadIds } },
          select: { leadId: true, at: true },
          orderBy: { at: "desc" },
          take: 2_000,
        })
      : Promise.resolve([]),
    leadIds.length
      ? db.call.findMany({
          where: { leadId: { in: leadIds } },
          select: { leadId: true, at: true },
          orderBy: { at: "desc" },
          take: 2_000,
        })
      : Promise.resolve([]),
  ]);

  const leadCompany = new Map(leads.map((l) => [l.id, l.companyId]));
  /** Newest touch of any kind, per company. */
  const lastTouch = new Map<string, Date>();
  const touch = (companyId: string | null | undefined, at: Date | null) => {
    if (!companyId || !at) return;
    const current = lastTouch.get(companyId);
    if (!current || at > current) lastTouch.set(companyId, at);
  };
  for (const lead of leads) touch(lead.companyId, lead.lastActivityAt);
  for (const a of activities) touch(leadCompany.get(a.leadId), a.at);
  for (const c of calls) touch(leadCompany.get(c.leadId), c.at);
  for (const t of threads) touch(t.companyId, t.lastMessageAt);

  /** Oldest unpaid invoice per company. */
  const oldestUnpaid = new Map<string, Date>();
  for (const inv of unpaid) {
    if (!inv.companyId) continue;
    const current = oldestUnpaid.get(inv.companyId);
    if (!current || inv.at < current) oldestUnpaid.set(inv.companyId, inv.at);
  }

  const byCompany = new Map<
    string,
    { name: string; supportFlag: boolean; mrr: number; oldestStart: Date }
  >();
  for (const sub of subs) {
    const entry = byCompany.get(sub.companyId);
    // MRR counts ACTIVE only, matching the headline number — a paused client
    // still deserves watching, but is not currently worth anything.
    const contributes = sub.status === "ACTIVE" ? sub.monthlyNet : 0;
    if (!entry) {
      byCompany.set(sub.companyId, {
        name: sub.company?.name ?? "—",
        supportFlag: sub.company?.supportFlag ?? false,
        mrr: contributes,
        oldestStart: sub.startDate,
      });
    } else {
      entry.mrr += contributes;
      if (sub.startDate < entry.oldestStart) entry.oldestStart = sub.startDate;
    }
  }

  const rows: ClientHealthRow[] = [];
  for (const [companyId, entry] of byCompany) {
    const unpaidSince = oldestUnpaid.get(companyId);
    const touched = lastTouch.get(companyId);
    const inputs = {
      companyName: entry.name,
      daysPaymentLate: unpaidSince
        ? Math.max(0, Math.floor((now.getTime() - unpaidSince.getTime()) / DAY_MS))
        : 0,
      // Never touched at all is measured from when they became a client, not
      // treated as zero — "no contact ever" is the loudest version of quiet.
      monthsSinceTouchpoint: Math.max(
        0,
        monthsBetween(touched ?? entry.oldestStart, now),
      ),
      supportFlag: entry.supportFlag,
      subscriptionAgeMonths: Math.max(0, monthsBetween(entry.oldestStart, now)),
    };
    const health = scoreClientHealth(inputs, rules);
    rows.push({
      companyId,
      ...inputs,
      level: health.level,
      reasons: health.reasons,
      mrr: entry.mrr,
      suggestedTask: suggestedTaskFor(inputs, health),
    });
  }

  // Worst first, then by what is at stake: a red client worth 400k outranks a
  // red client worth 40k when there is only time to ring one of them.
  const order: Record<HealthLevel, number> = { red: 0, amber: 1, green: 2 };
  return rows.sort(
    (a, b) => order[a.level] - order[b.level] || b.mrr - a.mrr || a.companyName.localeCompare(b.companyName, "hu"),
  );
}
