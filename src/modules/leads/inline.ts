/**
 * Editing one field of one lead (playbook-v2 P7/1).
 *
 * Workspace-id in rather than session-derived, like every other `*-store` in
 * this codebase: the rules worth proving — the score gate on an inline stage
 * change, the refusal of a field nobody may edit this way, the tenant scope —
 * are worth proving against a real database.
 *
 * WHAT IS EDITABLE INLINE, and what deliberately is not:
 *   - text and contact fields, the stage, the owner and any custom field: yes.
 *   - the ICP SCORE: no. It has an audited override with a mandatory reason
 *     (spec §4.5), and a table cell that quietly rewrites it would route around
 *     the audit trail that exists precisely so a score change is explicable.
 *   - the company: no. It is a shared record — editing it from a lead row would
 *     silently rename it for every other lead at that company.
 */

import { z } from "zod";
import type { Stage } from "@prisma/client";
import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import { listFieldDefsWith } from "@/modules/fields/store";
import {
  customFieldKey,
  isCustomFieldRef,
  mergeValues,
  readValues,
  validateValues,
} from "@/modules/fields/types";
import { gateThresholdFromConfig } from "./scoring";
import { assertCanEnterStage, ScoreGateError } from "./gate";
import { canQualify, type Qualification } from "../inbox/qualification";
import { requiresReason } from "../pipeline/transitions";

/** Built-in fields a table cell may write. */
export const INLINE_FIELDS = [
  "contactName",
  "title",
  "email",
  "phone",
  "linkedinUrl",
  "stage",
  "ownerId",
] as const;
export type InlineField = (typeof INLINE_FIELDS)[number];

export function isInlineField(field: string): field is InlineField {
  return (INLINE_FIELDS as readonly string[]).includes(field);
}

const textFields = new Set(["contactName", "title", "email", "phone", "linkedinUrl"]);

export type InlineResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

const valueSchema = z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.string())]);

/**
 * Apply one inline edit.
 *
 * Returns the value the SERVER now holds, not the value that was sent: a
 * trimmed string, a cleared field, a coerced custom value. The cell renders
 * what comes back, so an optimistic update that guessed differently is
 * corrected rather than left disagreeing with the database.
 */
export async function applyInlineEdit(
  workspaceId: string,
  actorUserId: string | null,
  input: { leadId: string; field: string; value: unknown },
): Promise<InlineResult> {
  const parsedValue = valueSchema.safeParse(input.value ?? null);
  if (!parsedValue.success) return { ok: false, error: "That value is not allowed." };
  const value = parsedValue.data;
  const db = getWorkspaceClient(workspaceId);

  const lead = await db.lead.findUnique({
    where: { id: input.leadId },
    select: {
      id: true,
      stage: true,
      icpScore: true,
      qualification: true,
      companyId: true,
      customFields: true,
    },
  });
  if (!lead) return { ok: false, error: "Lead not found." };

  // ---- custom fields -------------------------------------------------------
  if (isCustomFieldRef(input.field)) {
    const key = customFieldKey(input.field);
    const defs = await listFieldDefsWith(db, "lead");
    const result = validateValues(defs, { [key]: value });
    if (!result.ok) {
      const problem = result.problems[0];
      return { ok: false, error: `${problem.label} ${problem.message}.` };
    }
    const next = mergeValues(readValues(lead.customFields), result.values);
    await db.lead.update({ where: { id: lead.id }, data: { customFields: next as object } });
    return { ok: true, value: next[key] ?? null };
  }

  if (!isInlineField(input.field)) {
    return { ok: false, error: "That field cannot be edited from the table." };
  }

  // ---- text --------------------------------------------------------------
  if (textFields.has(input.field)) {
    const text = typeof value === "string" ? value.trim() : "";
    if (text.length > 500) return { ok: false, error: "That is too long." };
    if (input.field === "email" && text && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(text)) {
      return { ok: false, error: "That is not an email address." };
    }
    if (input.field === "linkedinUrl" && text && !/^https?:\/\/\S+$/i.test(text)) {
      return { ok: false, error: "A URL needs http:// or https://." };
    }
    await db.lead.update({
      where: { id: lead.id },
      data: { [input.field]: text || null },
    });
    return { ok: true, value: text || null };
  }

  // ---- owner ---------------------------------------------------------------
  if (input.field === "ownerId") {
    const ownerId = typeof value === "string" && value ? value : null;
    if (ownerId) {
      // Only a member of THIS workspace may own its leads — otherwise an id
      // typed into a form assigns work to a stranger.
      const member = await prismaUnsafe.membership.findUnique({
        where: { userId_workspaceId: { userId: ownerId, workspaceId } },
        select: { userId: true },
      });
      if (!member) return { ok: false, error: "That person is not in this workspace." };
    }
    await db.lead.update({ where: { id: lead.id }, data: { ownerId } });
    return { ok: true, value: ownerId };
  }

  // ---- stage ---------------------------------------------------------------
  const toStage = String(value) as Stage;
  if (toStage === lead.stage) return { ok: true, value: lead.stage };

  // Disqualifying needs a reason, which a table cell has nowhere to ask for.
  if (requiresReason(toStage)) {
    return {
      ok: false,
      error: "Disqualifying needs a reason — open the lead to do it.",
    };
  }

  const ws = await prismaUnsafe.workspace.findUnique({
    where: { id: workspaceId },
    select: { icpConfig: true },
  });
  try {
    assertCanEnterStage({
      toStage,
      score: lead.icpScore,
      threshold: gateThresholdFromConfig(ws?.icpConfig),
      leadId: lead.id,
    });
  } catch (e) {
    if (e instanceof ScoreGateError) return { ok: false, error: e.message };
    throw e;
  }

  if (toStage === "QUALIFIED" && !canQualify(lead.qualification as Partial<Qualification> | null)) {
    return {
      ok: false,
      error: "Answer at least 3 of 4 qualification questions before qualifying.",
    };
  }

  await db.lead.update({
    where: { id: lead.id },
    data: { stage: toStage, stageEnteredAt: new Date(), stageReason: null },
  });
  await db.activity.create({
    data: {
      workspaceId,
      leadId: lead.id,
      type: "stage_change",
      byUserId: actorUserId,
      payload: { from: lead.stage, to: toStage, inline: true },
    },
  });
  return { ok: true, value: toStage };
}
