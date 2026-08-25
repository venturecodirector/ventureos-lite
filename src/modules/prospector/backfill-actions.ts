"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getActiveContext } from "@/lib/session";
import { BACKFILL_FIELDS } from "./backfill";
import {
  applyPlans,
  backfillState,
  isBackfillOperator,
  previewGoogle,
  previewLocal,
  type BackfillPreview,
  type BackfillResult,
  type BackfillState,
} from "./backfill-store";

/**
 * Session, role, revalidate — the backfill's thin outer layer. Everything that
 * touches data is in `backfill-store.ts`, where a test can reach it.
 */

export type { BackfillPreview, BackfillResult, BackfillState };

/**
 * Checked on the server, in both mutating actions.
 *
 * Hiding the panel from a BDR is a UI courtesy; this is the rule. One of these
 * spends the workspace's Places budget and the other rewrites company names
 * across the CRM, and neither should be reachable by posting to the action
 * directly.
 */
async function assertOperator(workspaceId: string, userId: string): Promise<void> {
  if (!(await isBackfillOperator(workspaceId, userId))) {
    throw new Error("Only an Owner or an Admin can run the prospect backfill.");
  }
}

export async function canRunBackfill(): Promise<boolean> {
  const { workspaceId, userId } = await getActiveContext();
  return isBackfillOperator(workspaceId, userId);
}

export async function getBackfillState(): Promise<BackfillState> {
  const { workspaceId } = await getActiveContext();
  return backfillState(workspaceId);
}

const previewSchema = z.object({
  offset: z.number().int().min(0).default(0),
  /** False = the free pass only: the address, the category map, nothing bought. */
  google: z.boolean().default(false),
});

export async function previewBackfill(raw: unknown): Promise<BackfillPreview> {
  const input = previewSchema.parse(raw);
  const { workspaceId, userId } = await getActiveContext();
  await assertOperator(workspaceId, userId);
  return input.google ? previewGoogle(workspaceId, input.offset) : previewLocal(workspaceId);
}

const applySchema = z.object({
  rows: z
    .array(
      z.object({
        companyId: z.string().min(1).max(60),
        changes: z
          .array(
            z.object({
              // The whitelist. Nothing outside these ten columns is writable by
              // this path, whatever the client posts.
              field: z.enum(BACKFILL_FIELDS),
              to: z.string().trim().min(1).max(500),
            }),
          )
          .min(1)
          .max(BACKFILL_FIELDS.length),
      }),
    )
    .min(1)
    .max(500),
});

export async function applyBackfill(raw: unknown): Promise<BackfillResult> {
  const input = applySchema.parse(raw);
  const { workspaceId, userId } = await getActiveContext();
  await assertOperator(workspaceId, userId);
  const result = await applyPlans(workspaceId, userId, input.rows);
  revalidatePath("/leads");
  revalidatePath("/prospector");
  return result;
}
