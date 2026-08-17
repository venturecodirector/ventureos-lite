/**
 * Reading and writing Owner-defined fields (playbook-v2 P5/1).
 *
 * Workspace-id in rather than session-derived, following `leads/bulk-store.ts`:
 * the rules that matter — validation against the live definitions, the archive
 * rule, tenant scoping — are worth proving against a real database, and a
 * `"use server"` file resolves its tenant from a cookie a test cannot supply.
 */

import { getWorkspaceClient } from "@/lib/db";
import type { WorkspaceClient } from "@/lib/db";
import {
  FIELD_ENTITIES,
  RESERVED_KEYS,
  isValidKey,
  mergeValues,
  readValues,
  slugifyKey,
  validateValues,
  type FieldDef,
  type FieldEntity,
  type FieldOption,
  type FieldValues,
  type CustomFieldType,
  type ValueProblem,
} from "./types";

type Row = {
  id: string;
  entity: string;
  key: string;
  label: string;
  type: CustomFieldType;
  options: unknown;
  required: boolean;
  archived: boolean;
  position: number;
  help: string | null;
};

function toDef(row: Row): FieldDef {
  const options: FieldOption[] = Array.isArray(row.options)
    ? (row.options as unknown[])
        .map((o) =>
          o && typeof o === "object"
            ? {
                value: String((o as Record<string, unknown>).value ?? ""),
                label: String(
                  (o as Record<string, unknown>).label ??
                    (o as Record<string, unknown>).value ??
                    "",
                ),
              }
            : { value: String(o), label: String(o) },
        )
        .filter((o) => o.value.length > 0)
    : [];
  return {
    id: row.id,
    entity: (FIELD_ENTITIES as readonly string[]).includes(row.entity)
      ? (row.entity as FieldEntity)
      : "lead",
    key: row.key,
    label: row.label,
    type: row.type,
    options,
    required: row.required,
    archived: row.archived,
    position: row.position,
    help: row.help,
  };
}

/**
 * The definitions for one entity.
 *
 * Archived fields are INCLUDED by default: their values still have to render
 * and still have to be erasable, and a reader that cannot see the definition
 * cannot format the value it is looking at. Callers that are offering a field
 * to fill in filter them out.
 */
export async function listFieldDefs(
  workspaceId: string,
  entity?: FieldEntity,
  opts?: { activeOnly?: boolean },
): Promise<FieldDef[]> {
  const db = getWorkspaceClient(workspaceId);
  const rows = await db.customFieldDef.findMany({
    where: {
      ...(entity ? { entity } : {}),
      ...(opts?.activeOnly ? { archived: false } : {}),
    },
    orderBy: [{ entity: "asc" }, { position: "asc" }, { createdAt: "asc" }],
  });
  return rows.map(toDef);
}

/** Same, but through an already-scoped client — for callers inside a request. */
export async function listFieldDefsWith(
  db: WorkspaceClient,
  entity: FieldEntity,
  opts?: { activeOnly?: boolean },
): Promise<FieldDef[]> {
  const rows = await db.customFieldDef.findMany({
    where: { entity, ...(opts?.activeOnly ? { archived: false } : {}) },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
  });
  return rows.map(toDef);
}

export type DefResult = { ok: true; def: FieldDef } | { ok: false; error: string };

export interface CreateFieldInput {
  entity: FieldEntity;
  label: string;
  type: CustomFieldType;
  key?: string;
  options?: FieldOption[];
  required?: boolean;
  help?: string | null;
}

const MAX_FIELDS_PER_ENTITY = 40;

export async function createFieldDef(
  workspaceId: string,
  actorUserId: string | null,
  input: CreateFieldInput,
): Promise<DefResult> {
  const db = getWorkspaceClient(workspaceId);
  const label = input.label.trim();
  if (!label) return { ok: false, error: "A field needs a label." };

  const key = (input.key ?? slugifyKey(label)).trim();
  if (!isValidKey(key)) {
    return {
      ok: false,
      error:
        "That name cannot become a field key. Use letters, numbers and underscores, starting with a letter.",
    };
  }
  if (RESERVED_KEYS.has(key)) {
    return { ok: false, error: `“${key}” is the name of a built-in column. Pick another.` };
  }

  const existing = await db.customFieldDef.findFirst({
    where: { entity: input.entity, key },
    select: { id: true, archived: true },
  });
  if (existing) {
    return {
      ok: false,
      error: existing.archived
        ? "A field with that key is archived. Restore it instead of creating a second one."
        : "A field with that key already exists here.",
    };
  }

  const count = await db.customFieldDef.count({ where: { entity: input.entity } });
  if (count >= MAX_FIELDS_PER_ENTITY) {
    return { ok: false, error: `A ${input.entity} may have at most ${MAX_FIELDS_PER_ENTITY} custom fields.` };
  }

  const options = normaliseOptions(input.type, input.options ?? []);
  if (options === null) {
    return { ok: false, error: "A select field needs at least one option." };
  }

  const row = await db.customFieldDef.create({
    data: {
      workspaceId,
      entity: input.entity,
      key,
      label,
      type: input.type,
      options,
      required: input.required ?? false,
      help: input.help?.trim() || null,
      position: count,
      createdBy: actorUserId,
    },
  });
  return { ok: true, def: toDef(row) };
}

export interface UpdateFieldInput {
  id: string;
  label?: string;
  options?: FieldOption[];
  required?: boolean;
  archived?: boolean;
  position?: number;
  help?: string | null;
}

/**
 * Edit a definition.
 *
 * The KEY and the TYPE are immutable. Changing either would reinterpret every
 * value already stored under it — a number field turned into a select would
 * leave every existing value invalid, and nothing in the product could tell you
 * which rows had quietly stopped meaning anything. Archive and add a new field.
 */
export async function updateFieldDef(
  workspaceId: string,
  input: UpdateFieldInput,
): Promise<DefResult> {
  const db = getWorkspaceClient(workspaceId);
  const current = await db.customFieldDef.findUnique({ where: { id: input.id } });
  if (!current) return { ok: false, error: "That field no longer exists." };

  let options: unknown[] | null = null;
  if (input.options) {
    options = normaliseOptions(current.type, input.options);
    if (options === null) return { ok: false, error: "A select field needs at least one option." };
  }

  const row = await db.customFieldDef.update({
    where: { id: input.id },
    data: {
      ...(input.label !== undefined ? { label: input.label.trim() || current.label } : {}),
      ...(options ? { options: options as object[] } : {}),
      ...(input.required !== undefined ? { required: input.required } : {}),
      ...(input.archived !== undefined ? { archived: input.archived } : {}),
      ...(input.position !== undefined ? { position: input.position } : {}),
      ...(input.help !== undefined ? { help: input.help?.trim() || null } : {}),
    },
  });
  return { ok: true, def: toDef(row) };
}

function normaliseOptions(type: CustomFieldType, options: FieldOption[]): unknown[] | null {
  if (type !== "SELECT" && type !== "MULTISELECT") return [];
  const cleaned = options
    .map((o) => ({
      value: String(o.value ?? "").trim(),
      label: String(o.label ?? o.value ?? "").trim(),
    }))
    .filter((o) => o.value.length > 0)
    .map((o) => ({ value: o.value, label: o.label || o.value }));
  // Duplicate values would make a stored value ambiguous.
  const seen = new Set<string>();
  const unique = cleaned.filter((o) => (seen.has(o.value) ? false : (seen.add(o.value), true)));
  return unique.length > 0 ? unique : null;
}

// ---- values ---------------------------------------------------------------

export type ValuesResult =
  | { ok: true; values: FieldValues }
  | { ok: false; problems: ValueProblem[] };

const MODEL_FOR: Record<FieldEntity, "lead" | "company" | "deal"> = {
  lead: "lead",
  company: "company",
  deal: "deal",
};

/**
 * Write a partial patch of custom-field values onto one entity.
 *
 * Validated against the live definitions before anything is stored, so the
 * table never holds a value the workspace's own schema would reject. Scoped by
 * the guarded client, so an id from another tenant simply does not resolve.
 */
export async function setFieldValues(
  workspaceId: string,
  entity: FieldEntity,
  entityId: string,
  patch: Record<string, unknown>,
): Promise<ValuesResult> {
  const db = getWorkspaceClient(workspaceId);
  const defs = await listFieldDefsWith(db, entity);
  const result = validateValues(defs, patch);
  if (!result.ok) return { ok: false, problems: result.problems };

  const model = MODEL_FOR[entity];
  const row =
    model === "lead"
      ? await db.lead.findUnique({ where: { id: entityId }, select: { customFields: true } })
      : model === "company"
        ? await db.company.findUnique({ where: { id: entityId }, select: { customFields: true } })
        : await db.deal.findUnique({ where: { id: entityId }, select: { customFields: true } });
  if (!row) return { ok: false, problems: [{ key: "", label: "", message: "not found" }] };

  const next = mergeValues(readValues(row.customFields), result.values);
  const data = { customFields: next as object };
  if (model === "lead") await db.lead.update({ where: { id: entityId }, data });
  else if (model === "company") await db.company.update({ where: { id: entityId }, data });
  else await db.deal.update({ where: { id: entityId }, data });

  return { ok: true, values: next };
}

export async function getFieldValues(
  workspaceId: string,
  entity: FieldEntity,
  entityId: string,
): Promise<FieldValues> {
  const db = getWorkspaceClient(workspaceId);
  const model = MODEL_FOR[entity];
  const row =
    model === "lead"
      ? await db.lead.findUnique({ where: { id: entityId }, select: { customFields: true } })
      : model === "company"
        ? await db.company.findUnique({ where: { id: entityId }, select: { customFields: true } })
        : await db.deal.findUnique({ where: { id: entityId }, select: { customFields: true } });
  return readValues(row?.customFields);
}
