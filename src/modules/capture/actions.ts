"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { prismaUnsafe, getWorkspaceClient } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { createCaptureToken } from "./tokens";

/**
 * Capture-token management (P1/1e). Tokens are personal: a user manages their
 * own, and every query is scoped by the signed-in userId — not by an id passed
 * in from the client.
 */
export interface CaptureTokenRow {
  id: string;
  label: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export async function listCaptureTokens(): Promise<CaptureTokenRow[]> {
  const { userId } = await getActiveContext();
  const rows = await prismaUnsafe.captureToken.findMany({
    where: { userId, revokedAt: null },
    orderBy: { createdAt: "desc" },
    select: { id: true, label: true, lastUsedAt: true, createdAt: true },
  });
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  }));
}

/** Returns the plaintext token ONCE. It is stored only as a hash. */
export async function issueCaptureToken(raw: unknown): Promise<{ token: string }> {
  const { label } = z
    .object({ label: z.string().trim().max(60).optional() })
    .parse(raw ?? {});
  const { userId, workspaceId } = await getActiveContext();
  const { token, id } = await createCaptureToken(userId, workspaceId, label);

  await getWorkspaceClient(workspaceId).auditLog.create({
    data: {
      workspaceId,
      actorUserId: userId,
      action: "capture.token_issued",
      entityType: "CaptureToken",
      entityId: id,
      meta: { label: label ?? null },
    },
  });
  revalidatePath("/settings");
  return { token };
}

export async function revokeCaptureToken(raw: unknown): Promise<{ ok: true }> {
  const { id } = z.object({ id: z.string().min(1) }).parse(raw);
  const { userId, workspaceId } = await getActiveContext();
  // Scoped by userId: an id belonging to someone else must not be revocable.
  await prismaUnsafe.captureToken.updateMany({
    where: { id, userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  await getWorkspaceClient(workspaceId).auditLog.create({
    data: {
      workspaceId,
      actorUserId: userId,
      action: "capture.token_revoked",
      entityType: "CaptureToken",
      entityId: id,
      meta: {},
    },
  });
  revalidatePath("/settings");
  return { ok: true };
}
