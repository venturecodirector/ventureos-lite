"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getWorkspaceClient } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import {
  changeSubscriptionAmount,
  changeSubscriptionStatus,
  createSubscription,
} from "./store";
import { CHURN_REASONS, SUBSCRIPTION_SOURCES } from "./subscriptions";

/**
 * Managing the recurring book from the Revenue tab (playbook-v3 P11/1a, 1e).
 *
 * Thin wrappers: `store.ts` holds the rules — including the one this sub-item
 * exists for, that churn cannot be recorded without a reason from the list.
 */

const createSchema = z.object({
  companyId: z.string().min(1),
  planName: z.string().min(1),
  monthlyNet: z.coerce.number().int().positive(),
  startDate: z.string().min(1),
  source: z.enum(SUBSCRIPTION_SOURCES),
  billingDay: z.coerce.number().int().min(1).max(28).optional(),
});

export async function addSubscription(
  raw: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = createSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the fields." };
  }
  const { workspaceId } = await getActiveContext();
  const res = await createSubscription(workspaceId, {
    ...parsed.data,
    startDate: new Date(`${parsed.data.startDate}T00:00:00Z`),
  });
  if (!res.ok) return res;
  revalidatePath("/analytics");
  return { ok: true };
}

export async function repriceSubscription(
  subscriptionId: string,
  monthlyNet: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { workspaceId } = await getActiveContext();
  const res = await changeSubscriptionAmount(workspaceId, subscriptionId, Math.round(monthlyNet));
  if (res.ok) revalidatePath("/analytics");
  return res;
}

const statusSchema = z.object({
  subscriptionId: z.string().min(1),
  status: z.enum(["ACTIVE", "PAUSED", "CHURNED"]),
  reason: z.enum(CHURN_REASONS).optional(),
});

/**
 * Pause, resume, or churn.
 *
 * Churning without a reason is refused by the store; the UI never offers the
 * button until one is picked, so the refusal is a backstop rather than the
 * normal path.
 */
export async function setSubscriptionStatus(
  raw: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = statusSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Pick a status, and a reason to churn." };
  const { workspaceId } = await getActiveContext();
  const res = await changeSubscriptionStatus(
    workspaceId,
    parsed.data.subscriptionId,
    parsed.data.status,
    parsed.data.reason,
  );
  if (res.ok) {
    revalidatePath("/analytics");
    revalidatePath("/");
  }
  return res;
}

export interface CompanyOption {
  id: string;
  name: string;
  isClient: boolean;
}

/** Companies a subscription can be attached to — clients first, then the rest. */
export async function listSubscribableCompanies(): Promise<CompanyOption[]> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const companies = await db.company.findMany({
    orderBy: { name: "asc" },
    take: 500,
    select: { id: true, name: true, clientStatus: true },
  });
  return companies
    .map((c) => ({ id: c.id, name: c.name, isClient: c.clientStatus === "CLIENT" }))
    .sort((a, b) => Number(b.isClient) - Number(a.isClient) || a.name.localeCompare(b.name, "hu"));
}
