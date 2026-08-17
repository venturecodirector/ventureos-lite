/**
 * Feeding the commission calculation from the ledger (playbook-v3 P11/1d).
 *
 * Two jobs: turn invoices into payment records, and work out who sourced each
 * client. The arithmetic itself lives in `commission.ts` and never touches a
 * database, so a payroll figure can be reproduced from its inputs alone.
 */

import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import { monthKey } from "./subscriptions";
import {
  computeMonthlyCommission,
  terminationSettlement,
  windowStartFor,
  type OpenWindow,
  type PaymentRecord,
  type UserCommission,
  type UserSettlement,
} from "./commission";

export interface CommissionReport {
  month: string;
  users: UserCommission[];
  /** Display names for the ids on the lines. */
  userNames: Record<string, string>;
  /** Who introduced each client, when anyone did — context, not attribution. */
  referrers: Record<string, string>;
  totalPayable: number;
}

/**
 * Who a client's revenue is credited to.
 *
 * The chain, in order:
 *   1. the owner of a WON DEAL for that company (v2 P4 — the deal is the sale,
 *      and whoever closed it is the person the commission clause is about);
 *   2. failing that, the owner of any deal at all;
 *   3. the lead's OWNER (P3/2 put an owner on every lead precisely so this
 *      question has an answer);
 *   4. whoever first worked the lead according to the activity log.
 *
 * Deals took the top of the chain rather than replacing the rest: a client can
 * predate the deals layer entirely, and dropping the lead-owner fallback would
 * silently unattribute every one of them. A referrer is deliberately NOT part
 * of this — a Referrer is an outside person or company who made an
 * introduction, not a user who can be paid, so it travels with the report as
 * context instead.
 */
async function attributionByCompany(
  workspaceId: string,
  companyIds: string[],
): Promise<{ owner: Map<string, string | null>; referrer: Map<string, string> }> {
  const owner = new Map<string, string | null>();
  const referrer = new Map<string, string>();
  if (companyIds.length === 0) return { owner, referrer };

  const db = getWorkspaceClient(workspaceId);

  // 1 + 2 — the deal's owner, newest first, won deals preferred. Resolved for
  // every company up front rather than inside the lead loop below, because a
  // client can have a deal and no lead at all (a renewal outlived the contact),
  // and iterating leads would never reach it.
  const deals = await db.deal.findMany({
    where: { companyId: { in: companyIds }, ownerId: { not: null } },
    orderBy: [{ closedAt: "desc" }, { createdAt: "desc" }],
    select: { companyId: true, ownerId: true, status: true },
  });
  const wonOwner = new Map<string, string>();
  const anyDealOwner = new Map<string, string>();
  for (const deal of deals) {
    if (!deal.companyId || !deal.ownerId) continue;
    if (deal.status === "WON" && !wonOwner.has(deal.companyId)) {
      wonOwner.set(deal.companyId, deal.ownerId);
    }
    if (!anyDealOwner.has(deal.companyId)) anyDealOwner.set(deal.companyId, deal.ownerId);
  }
  for (const companyId of companyIds) {
    const fromDeal = wonOwner.get(companyId) ?? anyDealOwner.get(companyId);
    if (fromDeal) owner.set(companyId, fromDeal);
  }

  const leads = await db.lead.findMany({
    where: { companyId: { in: companyIds } },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      companyId: true,
      ownerId: true,
      referrer: { select: { name: true } },
    },
  });

  const unowned: string[] = [];
  for (const lead of leads) {
    if (!lead.companyId) continue;
    if (lead.referrer?.name && !referrer.has(lead.companyId)) {
      referrer.set(lead.companyId, lead.referrer.name);
    }
    if (owner.get(lead.companyId)) continue;
    if (lead.ownerId) owner.set(lead.companyId, lead.ownerId);
    else {
      owner.set(lead.companyId, null);
      unowned.push(lead.id);
    }
  }

  // Fallback for a client whose lead nobody owns: whoever first did something
  // on it. Better than dropping the revenue into "unattributed", and it is the
  // same person a human would name.
  if (unowned.length > 0) {
    const activities = await db.activity.findMany({
      where: { leadId: { in: unowned }, byUserId: { not: null } },
      orderBy: { at: "asc" },
      select: { leadId: true, byUserId: true },
    });
    const firstToucher = new Map<string, string>();
    for (const a of activities) {
      if (a.byUserId && !firstToucher.has(a.leadId)) firstToucher.set(a.leadId, a.byUserId);
    }
    for (const lead of leads) {
      if (!lead.companyId || owner.get(lead.companyId)) continue;
      const user = firstToucher.get(lead.id);
      if (user) owner.set(lead.companyId, user);
    }
  }

  return { owner, referrer };
}

/**
 * Every payment and reversal the workspace has ever received.
 *
 * The whole history, not one month: the recurring window is anchored on the
 * client's FIRST payment, which is almost never in the month being reported,
 * and carried balances are replayed from the beginning (see below).
 */
export async function loadPaymentLedger(workspaceId: string): Promise<PaymentRecord[]> {
  const db = getWorkspaceClient(workspaceId);
  const invoices = await db.invoice.findMany({
    where: { OR: [{ paidAt: { not: null } }, { refundedAt: { not: null } }] },
    select: {
      companyId: true,
      netAmount: true,
      paidAt: true,
      refundedAt: true,
      refundedNet: true,
      subscriptionId: true,
      company: { select: { name: true } },
      document: { select: { lead: { select: { companyId: true, company: { select: { name: true } } } } } },
    },
  });

  const records: PaymentRecord[] = [];
  const companyIds = new Set<string>();
  for (const inv of invoices) {
    // A one-off invoice may reach its company only through the document chain.
    const companyId = inv.companyId ?? inv.document?.lead?.companyId ?? null;
    if (!companyId) continue;
    companyIds.add(companyId);
    const companyName = inv.company?.name ?? inv.document?.lead?.company?.name ?? "—";
    const recurring = inv.subscriptionId !== null;

    if (inv.paidAt && inv.netAmount) {
      records.push({
        companyId,
        companyName,
        netAmount: inv.netAmount,
        receivedAt: inv.paidAt,
        recurring,
        attributedUserId: null,
      });
    }
    // The reversal is its own record, dated when the money went back out — it
    // belongs to THAT month's run, not to the month of the original payment.
    if (inv.refundedAt && inv.refundedNet) {
      records.push({
        companyId,
        companyName,
        netAmount: -inv.refundedNet,
        receivedAt: inv.refundedAt,
        recurring,
        attributedUserId: null,
      });
    }
  }

  const { owner } = await attributionByCompany(workspaceId, [...companyIds]);
  for (const record of records) {
    record.attributedUserId = owner.get(record.companyId) ?? null;
  }
  return records;
}

async function nameUsers(userIds: string[]): Promise<Record<string, string>> {
  const ids = userIds.filter(Boolean);
  if (ids.length === 0) return {};
  const users = await prismaUnsafe.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true },
  });
  return Object.fromEntries(users.map((u) => [u.id, u.name]));
}

/**
 * The monthly run for one month.
 *
 * Carried balances are REPLAYED from the first payment rather than stored. A
 * stored balance is a number that can drift from the ledger it came from and
 * that nobody can re-derive when it does; replaying makes every month's figure
 * a pure function of the invoices, which is exactly the property a payroll
 * number should have. The cost is a few months of arithmetic over data already
 * in memory.
 */
export async function buildCommissionReport(
  workspaceId: string,
  month: string,
): Promise<CommissionReport> {
  const payments = await loadPaymentLedger(workspaceId);
  const companyIds = [...new Set(payments.map((p) => p.companyId))];
  const { referrer } = await attributionByCompany(workspaceId, companyIds);

  const months = [...new Set(payments.map((p) => monthKey(p.receivedAt)))]
    .filter((m) => m < month)
    .sort();

  let carry: Record<string, number> = {};
  for (const past of months) {
    const run = computeMonthlyCommission({ month: past, payments, carryIn: carry });
    const next: Record<string, number> = { ...carry };
    for (const user of run) {
      next[user.userId ?? ""] = user.carriedOut;
    }
    carry = next;
  }

  const users = computeMonthlyCommission({ month, payments, carryIn: carry });
  return {
    month,
    users,
    userNames: await nameUsers(users.map((u) => u.userId ?? "")),
    referrers: Object.fromEntries(referrer),
    totalPayable: users.reduce((n, u) => n + u.payable, 0),
  };
}

export interface SettlementReport {
  endDate: string;
  users: UserSettlement[];
  userNames: Record<string, string>;
  totalRemainingNet: number;
  totalCommission: number;
}

/**
 * The termination lump sum: every open window valued at its live monthly fee.
 *
 * Only ACTIVE subscriptions count — a paused or churned one has no "current
 * monthly recurring fee" to multiply.
 */
export async function buildSettlementReport(
  workspaceId: string,
  endDate: Date,
): Promise<SettlementReport> {
  const db = getWorkspaceClient(workspaceId);
  const [subs, payments] = await Promise.all([
    db.subscription.findMany({
      where: { status: "ACTIVE" },
      select: {
        companyId: true,
        monthlyNet: true,
        company: { select: { name: true } },
      },
    }),
    loadPaymentLedger(workspaceId),
  ]);

  const byCompany = new Map<string, PaymentRecord[]>();
  for (const p of payments) {
    const list = byCompany.get(p.companyId) ?? [];
    list.push(p);
    byCompany.set(p.companyId, list);
  }

  const windows: OpenWindow[] = [];
  for (const sub of subs) {
    const history = byCompany.get(sub.companyId);
    const start = history ? windowStartFor(history) : null;
    // No payment ever received means no window has opened, so there is nothing
    // remaining to settle.
    if (!start) continue;
    windows.push({
      companyId: sub.companyId,
      companyName: sub.company?.name ?? "—",
      attributedUserId: history?.[0]?.attributedUserId ?? null,
      windowStart: start,
      currentMonthlyNet: sub.monthlyNet,
    });
  }

  const users = terminationSettlement(windows, endDate);
  return {
    endDate: endDate.toISOString().slice(0, 10),
    users,
    userNames: await nameUsers(users.map((u) => u.userId ?? "")),
    totalRemainingNet: users.reduce((n, u) => n + u.totalRemainingNet, 0),
    totalCommission: users.reduce((n, u) => n + u.totalCommission, 0),
  };
}
