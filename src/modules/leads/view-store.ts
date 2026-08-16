/**
 * Reading and writing saved views (playbook-v2 P3/2).
 *
 * Takes workspace, user and role explicitly rather than resolving the session
 * itself, so the rules are testable against a real database without faking a
 * login. `view-actions.ts` is the thin "use server" layer that supplies them.
 *
 * Every write goes through the same parsers the URL uses, so a filter set
 * reaching the JSON column has already been stripped of unknown fields and
 * incoherent operators — a stored view cannot become a way to smuggle a shape
 * past the evaluator.
 */

import { Prisma } from "@prisma/client";
import { getWorkspaceClient } from "@/lib/db";
import { parseColumns, parseFilterSet, parseSort } from "./view-params";
import { serializeSort } from "./view-params";
import { canEditView, canSeeView, normalizeViewName, type LeadView } from "./views";
import type { FilterSet, SortSpec } from "./filters";

export interface ViewInput {
  name: string;
  shared: boolean;
  filters: FilterSet;
  sort: SortSpec;
  columns: string[];
}

export type ViewResult =
  | { ok: true; view: LeadView }
  | { ok: false; error: string };

const ENTITY = "lead";

type Row = {
  id: string;
  name: string;
  ownerId: string;
  shared: boolean;
  filters: Prisma.JsonValue;
  sort: Prisma.JsonValue;
  columns: Prisma.JsonValue;
  position: number;
};

/** Parse on the way OUT too: a row written before a field was renamed still opens. */
function toView(row: Row): LeadView {
  return {
    id: row.id,
    name: row.name,
    ownerId: row.ownerId,
    shared: row.shared,
    filters: parseFilterSet(row.filters as Record<string, unknown>),
    sort: parseSort(typeof row.sort === "string" ? row.sort : serializeSortValue(row.sort)),
    columns: parseColumns(Array.isArray(row.columns) ? (row.columns as string[]) : undefined),
    position: row.position,
  };
}

/** The sort column stores `{field,direction}`; the parser speaks "field:dir". */
function serializeSortValue(value: Prisma.JsonValue): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as { field?: unknown; direction?: unknown };
  if (typeof v.field !== "string") return undefined;
  return `${v.field}:${v.direction === "asc" ? "asc" : "desc"}`;
}

const SELECT = {
  id: true,
  name: true,
  ownerId: true,
  shared: true,
  filters: true,
  sort: true,
  columns: true,
  position: true,
} as const;

/**
 * Every view this user may see in this workspace: their own, plus the shared
 * ones. The visibility rule is applied in the QUERY, not after — a personal
 * view of a colleague's must not reach the browser at all.
 */
export async function listViews(workspaceId: string, userId: string): Promise<LeadView[]> {
  const db = getWorkspaceClient(workspaceId);
  const rows = await db.savedView.findMany({
    where: { entity: ENTITY, OR: [{ ownerId: userId }, { shared: true }] },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    select: SELECT,
  });
  return rows.map(toView);
}

function sanitize(input: ViewInput) {
  return {
    filters: parseFilterSet(input.filters as unknown as Record<string, unknown>),
    sort: parseSort(serializeSort(input.sort)),
    columns: parseColumns(input.columns),
  };
}

export async function createView(
  workspaceId: string,
  userId: string,
  input: ViewInput,
): Promise<ViewResult> {
  const name = normalizeViewName(input.name);
  if (!name) return { ok: false, error: "A view needs a name." };

  const db = getWorkspaceClient(workspaceId);
  const clean = sanitize(input);
  const last = await db.savedView.findFirst({
    where: { entity: ENTITY },
    orderBy: { position: "desc" },
    select: { position: true },
  });

  try {
    const row = await db.savedView.create({
      data: {
        workspaceId,
        entity: ENTITY,
        name,
        ownerId: userId,
        shared: input.shared,
        filters: clean.filters as unknown as Prisma.InputJsonValue,
        sort: clean.sort as unknown as Prisma.InputJsonValue,
        columns: clean.columns,
        position: (last?.position ?? -1) + 1,
      },
      select: SELECT,
    });
    return { ok: true, view: toView(row) };
  } catch (e) {
    // The unique key is (workspace, entity, owner, name) — one person cannot
    // have two tabs with the same label, but two people can.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { ok: false, error: `You already have a view called "${name}".` };
    }
    throw e;
  }
}

/** Fetch + authorize in one place, so no mutation can skip the check. */
async function loadEditable(
  workspaceId: string,
  userId: string,
  role: string,
  id: string,
): Promise<{ ok: true; view: LeadView } | { ok: false; error: string }> {
  const db = getWorkspaceClient(workspaceId);
  // Guarded client: a view from another workspace simply is not found, even
  // when its id is known.
  const row = await db.savedView.findUnique({ where: { id }, select: SELECT });
  if (!row) return { ok: false, error: "View not found." };
  const view = toView(row);
  if (!canSeeView(view, userId)) return { ok: false, error: "View not found." };
  if (!canEditView(view, userId, role)) {
    return { ok: false, error: "That view belongs to someone else." };
  }
  return { ok: true, view };
}

export async function updateView(
  workspaceId: string,
  userId: string,
  role: string,
  id: string,
  changes: Partial<ViewInput>,
): Promise<ViewResult> {
  const found = await loadEditable(workspaceId, userId, role, id);
  if (!found.ok) return found;

  const data: Prisma.SavedViewUpdateInput = {};
  if (changes.name !== undefined) {
    const name = normalizeViewName(changes.name);
    if (!name) return { ok: false, error: "A view needs a name." };
    data.name = name;
  }
  if (changes.shared !== undefined) data.shared = changes.shared;
  if (changes.filters !== undefined) {
    data.filters = parseFilterSet(
      changes.filters as unknown as Record<string, unknown>,
    ) as unknown as Prisma.InputJsonValue;
  }
  if (changes.sort !== undefined) {
    data.sort = parseSort(serializeSort(changes.sort)) as unknown as Prisma.InputJsonValue;
  }
  if (changes.columns !== undefined) data.columns = parseColumns(changes.columns);

  const db = getWorkspaceClient(workspaceId);
  try {
    const row = await db.savedView.update({ where: { id }, data, select: SELECT });
    return { ok: true, view: toView(row) };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { ok: false, error: "You already have a view with that name." };
    }
    throw e;
  }
}

export async function deleteView(
  workspaceId: string,
  userId: string,
  role: string,
  id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const found = await loadEditable(workspaceId, userId, role, id);
  if (!found.ok) return found;
  const db = getWorkspaceClient(workspaceId);
  await db.savedView.delete({ where: { id } });
  return { ok: true };
}
