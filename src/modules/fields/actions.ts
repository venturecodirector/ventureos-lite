"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getWorkspaceClient } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { requireGrant, GrantError } from "@/lib/authz";
import {
  createFieldDef,
  listFieldDefs,
  setFieldValues,
  updateFieldDef,
} from "./store";
import {
  CUSTOM_FIELD_TYPES,
  FIELD_ENTITIES,
  type FieldDef,
  type FieldEntity,
  type ValueProblem,
} from "./types";

/**
 * Owner-defined fields, session-facing (playbook-v2 P5/1).
 *
 * DEFINITIONS are grant-gated on `fields.manage` (Owner-only by default,
 * CLAUDE.md hard rule #7): adding a required field changes what every form in
 * the workspace demands, and archiving one changes what every table shows.
 *
 * VALUES are not separately gated. Filling in a field on a lead is editing the
 * lead, and anyone who may edit the lead may edit its fields — a second gate
 * there would mean a BDR could rename a company but not record its VAT number.
 */

const optionSchema = z.object({
  value: z.string().trim().min(1).max(80),
  label: z.string().trim().max(120).optional(),
});

const createSchema = z.object({
  entity: z.enum(FIELD_ENTITIES),
  label: z.string().trim().min(1).max(120),
  type: z.enum(CUSTOM_FIELD_TYPES),
  key: z.string().trim().max(40).optional(),
  options: z.array(optionSchema).max(80).optional(),
  required: z.boolean().optional(),
  help: z.string().trim().max(300).nullable().optional(),
});

const updateSchema = z.object({
  id: z.string().min(1),
  label: z.string().trim().min(1).max(120).optional(),
  options: z.array(optionSchema).max(80).optional(),
  required: z.boolean().optional(),
  archived: z.boolean().optional(),
  position: z.number().int().min(0).max(999).optional(),
  help: z.string().trim().max(300).nullable().optional(),
});

export type FieldActionResult = { ok: true } | { ok: false; error: string };

async function requireFieldsGrant(): Promise<string | null> {
  try {
    await requireGrant("fields.manage");
    return null;
  } catch (e) {
    return e instanceof GrantError
      ? "Only an Owner (or a user granted fields.manage) can change the field set."
      : "Could not check your permissions.";
  }
}

export async function listCustomFields(entity?: FieldEntity): Promise<FieldDef[]> {
  const { workspaceId } = await getActiveContext();
  return listFieldDefs(workspaceId, entity);
}

export async function createCustomField(raw: unknown): Promise<FieldActionResult> {
  const parsed = createSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "That field definition is not valid." };
  const denied = await requireFieldsGrant();
  if (denied) return { ok: false, error: denied };

  const { workspaceId, userId } = await getActiveContext();
  const res = await createFieldDef(workspaceId, userId, {
    ...parsed.data,
    options: parsed.data.options?.map((o) => ({ value: o.value, label: o.label ?? o.value })),
  });
  if (!res.ok) return res;

  await getWorkspaceClient(workspaceId).auditLog.create({
    data: {
      workspaceId,
      actorUserId: userId,
      action: "fields.create",
      entityType: "CustomFieldDef",
      entityId: res.def.id,
      meta: { entity: res.def.entity, key: res.def.key, type: res.def.type },
    },
  });

  revalidatePath("/settings");
  revalidatePath("/leads");
  return { ok: true };
}

export async function updateCustomField(raw: unknown): Promise<FieldActionResult> {
  const parsed = updateSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "That change is not valid." };
  const denied = await requireFieldsGrant();
  if (denied) return { ok: false, error: denied };

  const { workspaceId, userId } = await getActiveContext();
  const res = await updateFieldDef(workspaceId, {
    ...parsed.data,
    options: parsed.data.options?.map((o) => ({ value: o.value, label: o.label ?? o.value })),
  });
  if (!res.ok) return res;

  await getWorkspaceClient(workspaceId).auditLog.create({
    data: {
      workspaceId,
      actorUserId: userId,
      action: parsed.data.archived === true ? "fields.archive" : "fields.update",
      entityType: "CustomFieldDef",
      entityId: res.def.id,
      meta: { key: res.def.key, archived: res.def.archived, required: res.def.required },
    },
  });

  revalidatePath("/settings");
  revalidatePath("/leads");
  return { ok: true };
}

export type SaveValuesResult =
  | { ok: true }
  | { ok: false; error: string; problems?: ValueProblem[] };

export async function saveCustomFieldValues(raw: unknown): Promise<SaveValuesResult> {
  const parsed = z
    .object({
      entity: z.enum(FIELD_ENTITIES),
      entityId: z.string().min(1),
      values: z.record(z.unknown()),
    })
    .safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Nothing to save." };

  const { workspaceId } = await getActiveContext();
  const res = await setFieldValues(
    workspaceId,
    parsed.data.entity,
    parsed.data.entityId,
    parsed.data.values,
  );
  if (!res.ok) {
    return {
      ok: false,
      error: res.problems.map((p) => `${p.label} ${p.message}`).join("; ") || "Could not save.",
      problems: res.problems,
    };
  }

  revalidatePath("/leads");
  revalidatePath("/deals");
  return { ok: true };
}
