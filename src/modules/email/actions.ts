"use server";

import { revalidatePath } from "next/cache";
import { prismaUnsafe } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { BACKFILL_DAYS } from "./gmail-query";

/**
 * Settings → Email (playbook-v2 P2b).
 *
 * Per USER, not per workspace: a mailbox belongs to a person, and one person's
 * correspondence is not something a colleague gets to connect on their behalf.
 * Every function here scopes by the acting user's id for that reason.
 */
export interface MailAccountView {
  id: string;
  accountEmail: string;
  provider: string;
  enabled: boolean;
  health: "ok" | "reconnect_needed" | "rate_limited" | "error" | string;
  lastError: string | null;
  lastSyncAt: string | null;
  /** 0–100. Backfill walks 90 days backwards, so this is honest progress. */
  backfillPercent: number;
  backfillDone: boolean;
  threadCount: number;
  messageCount: number;
  unmatchedCount: number;
}

function backfillPercent(cursor: Date | null, done: boolean, now: Date): number {
  if (done) return 100;
  if (!cursor) return 0;
  const walked = now.getTime() - cursor.getTime();
  return Math.max(0, Math.min(99, Math.round((walked / (BACKFILL_DAYS * 86_400_000)) * 100)));
}

export async function listMailAccounts(): Promise<MailAccountView[]> {
  const { userId } = await getActiveContext();
  const accounts = await prismaUnsafe.mailAccount.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
  });
  const now = new Date();

  return Promise.all(
    accounts.map(async (a) => {
      const [threadCount, messageCount, unmatchedCount] = await Promise.all([
        prismaUnsafe.emailThread.count({ where: { accountId: a.id } }),
        prismaUnsafe.emailMessage.count({ where: { thread: { accountId: a.id } } }),
        prismaUnsafe.emailThread.count({ where: { accountId: a.id, leadId: null } }),
      ]);
      return {
        id: a.id,
        accountEmail: a.accountEmail,
        provider: a.provider,
        enabled: a.enabled,
        health: a.health,
        lastError: a.lastError,
        lastSyncAt: a.lastSyncAt?.toISOString() ?? null,
        backfillPercent: backfillPercent(a.backfillCursor, a.backfillDone, now),
        backfillDone: a.backfillDone,
        threadCount,
        messageCount,
        unmatchedCount,
      };
    }),
  );
}

/** Pause syncing without dropping what is already stored. */
export async function setMailAccountEnabled(
  accountId: string,
  enabled: boolean,
): Promise<{ ok: true }> {
  const { userId } = await getActiveContext();
  await prismaUnsafe.mailAccount.updateMany({
    where: { id: accountId, userId },
    data: { enabled },
  });
  revalidatePath("/settings");
  return { ok: true };
}

/**
 * Disconnect a mailbox and delete everything synced from it.
 *
 * Deliberately destructive: leaving a person's correspondence behind after they
 * disconnected their mailbox would be keeping data whose basis for being here
 * has just been withdrawn. The cascade on EmailThread removes the messages.
 */
export async function disconnectMailAccount(
  accountId: string,
): Promise<{ ok: true; threadsRemoved: number }> {
  const { userId } = await getActiveContext();
  const account = await prismaUnsafe.mailAccount.findFirst({
    where: { id: accountId, userId },
    select: { id: true },
  });
  if (!account) return { ok: true, threadsRemoved: 0 };

  const threadsRemoved = await prismaUnsafe.emailThread.count({
    where: { accountId: account.id },
  });
  await prismaUnsafe.mailAccount.delete({ where: { id: account.id } });
  revalidatePath("/settings");
  return { ok: true, threadsRemoved };
}
