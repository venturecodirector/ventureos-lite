"use server";

import { z } from "zod";
import { getWorkspaceClient } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { verifyLead } from "./store";
import { REASON_TEXT, type VerifyReason, type VerifyStatus } from "./types";

/**
 * "Verify" beside the Email field (playbook-v3 P9/2, ad hoc).
 *
 * The same layered check the campaign gate runs, on one address, on demand —
 * so the answer an operator gets here is the answer the gate will give later
 * rather than a different opinion from a different code path.
 */
export type VerifyEmailResult =
  | { ok: true; status: VerifyStatus; message: string; fromCache: boolean }
  | { ok: false; error: string };

export async function verifyLeadEmail(raw: unknown): Promise<VerifyEmailResult> {
  const parsed = z.object({ leadId: z.string().min(1), force: z.boolean().optional() }).safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Incomplete request." };

  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  const result = await verifyLead(db, workspaceId, parsed.data.leadId, {
    force: parsed.data.force,
  });
  if (!result) return { ok: false, error: "This lead was not found." };
  if (!result.address) {
    return { ok: false, error: "There is no email address on this lead to check." };
  }

  return {
    ok: true,
    status: result.status,
    message: REASON_TEXT[result.reason as VerifyReason] ?? result.reason,
    fromCache: result.fromCache,
  };
}
