"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getActiveContext } from "@/lib/session";
import { applyInlineEdit, type InlineResult } from "./inline";

/**
 * The session-facing wrapper for an inline table edit (playbook-v2 P7/1).
 *
 * Thin, like every other action layer here: the rules live in `inline.ts`,
 * where a test can reach them without a cookie.
 *
 * NO `revalidatePath` on success, deliberately. The cell has already updated
 * optimistically and the server has answered with the value it stored; a
 * revalidation would re-render the whole table underneath a person who is
 * tabbing along a row, which is the exact jarring behaviour inline editing
 * exists to avoid. The next real navigation picks up the fresh render.
 */
export async function editLeadField(raw: unknown): Promise<InlineResult> {
  const parsed = z
    .object({
      leadId: z.string().min(1),
      field: z.string().min(1).max(60),
      value: z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.string())]),
    })
    .safeParse(raw);
  if (!parsed.success) return { ok: false, error: "That edit is not valid." };

  const { workspaceId, userId } = await getActiveContext();
  const res = await applyInlineEdit(workspaceId, userId, parsed.data);

  // A stage change DOES move the lead between boards, so the boards have to
  // know. The table itself is left alone for the reason above.
  if (res.ok && parsed.data.field === "stage") {
    revalidatePath("/pipeline");
  }
  return res;
}
