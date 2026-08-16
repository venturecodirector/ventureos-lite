/**
 * Writing the recurring book and the payment ledger (playbook-v3 P11/1a).
 *
 * Takes the workspace explicitly rather than resolving a session, because the
 * commission job and the invoice poll both run in the WORKER where there is no
 * request. Server actions supply it from the session.
 *
 * The rule this module exists to enforce: nothing changes a subscription
 * without appending an event. A status or amount written without its delta
 * silently corrupts the movement chart, and nothing downstream can tell.
 */

import { getWorkspaceClient } from "@/lib/db";
import {
  eventForAmountChange,
  eventForStatusChange,
  isChurnReason,
  isSubscriptionSource,
  type SubscriptionStatus,
} from "./subscriptions";

/** A mutation that returns a value on success. */
export type Result<T> = ({ ok: true } & T) | { ok: false; error: string };
/** A mutation that returns nothing on success. */
export type Done = { ok: true } | { ok: false; error: string };

export interface NewSubscriptionInput {
  companyId: string;
  leadId?: string | null;
  planName: string;
  monthlyNet: number;
  startDate: Date;
  source: string;
  billingDay?: number;
  note?: string | null;
}

type Db = ReturnType<typeof getWorkspaceClient>;

/**
 * Promote a company to client status, dated from `at`.
 *
 * Never moves an existing date FORWARD: a company that has been a client since
 * March does not become one in June because a second engagement started then.
 * Client tenure feeds the health score, and a resetting start date would keep
 * long-standing clients looking permanently new.
 */
export async function promoteToClient(
  workspaceId: string,
  companyId: string,
  at: Date,
): Promise<void> {
  const db = getWorkspaceClient(workspaceId);
  const company = await db.company.findUnique({
    where: { id: companyId },
    select: { clientSince: true },
  });
  if (!company) return;
  await db.company.update({
    where: { id: companyId },
    data: {
      clientStatus: "CLIENT",
      clientSince:
        company.clientSince && company.clientSince <= at ? company.clientSince : at,
    },
  });
}

/**
 * Re-evaluate whether a company is still a client.
 *
 * FORMER rather than back to PROSPECT: someone who bought and left is not the
 * same as someone who never bought, and the two behave differently in every
 * list they appear in.
 */
async function refreshClientStatus(db: Db, companyId: string): Promise<void> {
  const live = await db.subscription.count({
    where: { companyId, status: { in: ["ACTIVE", "PAUSED"] } },
  });
  const company = await db.company.findUnique({
    where: { id: companyId },
    select: { clientStatus: true },
  });
  if (!company || company.clientStatus === "PROSPECT") return;
  await db.company.update({
    where: { id: companyId },
    data: { clientStatus: live > 0 ? "CLIENT" : "FORMER" },
  });
}

export async function createSubscription(
  workspaceId: string,
  input: NewSubscriptionInput,
): Promise<Result<{ subscription: { id: string; startDate: Date } }>> {
  if (!isSubscriptionSource(input.source)) {
    return { ok: false, error: "Unknown subscription source." };
  }
  if (!input.planName.trim()) return { ok: false, error: "A subscription needs a plan name." };
  if (!Number.isInteger(input.monthlyNet) || input.monthlyNet <= 0) {
    return { ok: false, error: "The monthly net must be a positive whole number of forints." };
  }
  const billingDay = input.billingDay ?? 1;
  // 1-28 only: a billing day of 29-31 does not exist in every month, and the
  // first February would silently move or skip the invoice.
  if (!Number.isInteger(billingDay) || billingDay < 1 || billingDay > 28) {
    return { ok: false, error: "The billing day must be between 1 and 28." };
  }

  const db = getWorkspaceClient(workspaceId);
  // Guarded client: a company from another workspace is simply not found.
  const company = await db.company.findUnique({
    where: { id: input.companyId },
    select: { id: true },
  });
  if (!company) return { ok: false, error: "Company not found." };

  const subscription = await db.subscription.create({
    data: {
      workspaceId,
      companyId: input.companyId,
      leadId: input.leadId ?? null,
      planName: input.planName.trim(),
      monthlyNet: input.monthlyNet,
      billingDay,
      startDate: input.startDate,
      source: input.source,
      note: input.note ?? null,
    },
    select: { id: true, startDate: true },
  });

  await db.subscriptionEvent.create({
    data: {
      workspaceId,
      subscriptionId: subscription.id,
      kind: "new",
      deltaNet: input.monthlyNet,
      monthlyNetAfter: input.monthlyNet,
      // Dated from the START, not from when the row was typed: a subscription
      // backfilled in April that began in January belongs in January's chart.
      at: input.startDate,
    },
  });

  await promoteToClient(workspaceId, input.companyId, input.startDate);
  return { ok: true, subscription };
}

export async function changeSubscriptionAmount(
  workspaceId: string,
  subscriptionId: string,
  monthlyNet: number,
  at: Date = new Date(),
): Promise<Done> {
  if (!Number.isInteger(monthlyNet) || monthlyNet <= 0) {
    return { ok: false, error: "The monthly net must be a positive whole number of forints." };
  }
  const db = getWorkspaceClient(workspaceId);
  const sub = await db.subscription.findUnique({
    where: { id: subscriptionId },
    select: { monthlyNet: true, status: true },
  });
  if (!sub) return { ok: false, error: "Subscription not found." };

  const event = eventForAmountChange(
    { monthlyNet: sub.monthlyNet, status: sub.status as SubscriptionStatus },
    monthlyNet,
  );
  await db.subscription.update({ where: { id: subscriptionId }, data: { monthlyNet } });
  if (event) {
    await db.subscriptionEvent.create({
      data: { workspaceId, subscriptionId, ...event, at },
    });
  }
  return { ok: true };
}

export async function changeSubscriptionStatus(
  workspaceId: string,
  subscriptionId: string,
  next: SubscriptionStatus,
  reason?: string,
  at: Date = new Date(),
): Promise<Done> {
  // Churn without a reason is a data point nobody can learn from, and the
  // breakdown on the Revenue tab is only worth rendering if every row has one.
  if (next === "CHURNED" && !isChurnReason(reason)) {
    return { ok: false, error: "Churn needs a reason from the list." };
  }

  const db = getWorkspaceClient(workspaceId);
  const sub = await db.subscription.findUnique({
    where: { id: subscriptionId },
    select: { monthlyNet: true, status: true, companyId: true },
  });
  if (!sub) return { ok: false, error: "Subscription not found." };

  const event = eventForStatusChange(
    { monthlyNet: sub.monthlyNet, status: sub.status as SubscriptionStatus },
    next,
  );
  if (!event) return { ok: true };

  await db.subscription.update({
    where: { id: subscriptionId },
    data: {
      status: next,
      churnedAt: next === "CHURNED" ? at : null,
      churnReason: next === "CHURNED" ? (reason ?? null) : null,
    },
  });
  await db.subscriptionEvent.create({
    data: {
      workspaceId,
      subscriptionId,
      ...event,
      reason: next === "CHURNED" ? (reason ?? null) : null,
      at,
    },
  });

  if (next === "ACTIVE") await promoteToClient(workspaceId, sub.companyId, at);
  else await refreshClientStatus(db, sub.companyId);
  return { ok: true };
}

// ---- the payment ledger ---------------------------------------------------

/**
 * Record that money arrived. Called by the Számlázz.hu poll.
 *
 * Idempotent on `paidAt`: the commission run keys off that date, so re-stamping
 * an already-paid invoice would move a payment into a different month after the
 * fact and change a report that has already been handed to payroll.
 */
export async function markInvoicePaid(
  workspaceId: string,
  invoiceId: string,
  at: Date = new Date(),
): Promise<Done> {
  const db = getWorkspaceClient(workspaceId);
  const invoice = await db.invoice.findUnique({
    where: { id: invoiceId },
    select: { paidAt: true, companyId: true },
  });
  if (!invoice) return { ok: false, error: "Invoice not found." };
  if (invoice.paidAt) return { ok: true };

  await db.invoice.update({
    where: { id: invoiceId },
    data: { status: "PAID", paidAt: at },
  });
  if (invoice.companyId) await promoteToClient(workspaceId, invoice.companyId, at);
  return { ok: true };
}

/**
 * Record that money went back out.
 *
 * The row keeps its paidAt: both legs really happened, and the commission
 * ledger has to see the payment AND the reversal to offset one against the
 * other. Deleting the invoice would make the original commission unexplainable.
 */
export async function markInvoiceRefunded(
  workspaceId: string,
  invoiceId: string,
  refundedNet: number,
  at: Date = new Date(),
): Promise<Done> {
  const db = getWorkspaceClient(workspaceId);
  const invoice = await db.invoice.findUnique({
    where: { id: invoiceId },
    select: { paidAt: true, netAmount: true },
  });
  if (!invoice) return { ok: false, error: "Invoice not found." };
  if (!invoice.paidAt) return { ok: false, error: "That invoice was never paid." };
  if (!Number.isInteger(refundedNet) || refundedNet <= 0) {
    return { ok: false, error: "A refund must be a positive whole number of forints." };
  }
  if (refundedNet > (invoice.netAmount ?? 0)) {
    return { ok: false, error: "A refund cannot exceed what was received." };
  }

  await db.invoice.update({
    where: { id: invoiceId },
    data: { status: "REFUNDED", refundedNet, refundedAt: at },
  });
  return { ok: true };
}
