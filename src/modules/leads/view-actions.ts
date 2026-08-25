"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prismaUnsafe } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { filterSetSchema, sortSchema } from "./view-params";
import { createView, deleteView, updateView } from "./view-store";
import type { LeadView } from "./views";
import type { FilterSet, SortSpec } from "./filters";

/**
 * Saved-view server actions (playbook-v2 P3/2). Thin: they resolve the session
 * and the caller's role, then hand off to `view-store.ts`, which holds the
 * rules and is tested against a real database.
 */

const viewInputSchema = z.object({
  name: z.string(),
  shared: z.boolean().default(false),
  filters: filterSetSchema,
  sort: sortSchema,
  columns: z.array(z.string()),
});

/** The acting user's role in the active workspace — never taken from the client. */
async function roleOf(userId: string, workspaceId: string): Promise<string> {
  const membership = await prismaUnsafe.membership.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
    select: { role: true },
  });
  return membership?.role ?? "BDR";
}


export async function saveLeadView(
  raw: unknown,
): Promise<{ ok: true; view: LeadView } | { ok: false; error: string }> {
  const parsed = viewInputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "That view could not be saved." };

  const { workspaceId, userId } = await getActiveContext();
  const result = await createView(workspaceId, userId, {
    name: parsed.data.name,
    shared: parsed.data.shared,
    filters: parsed.data.filters as FilterSet,
    sort: parsed.data.sort as SortSpec,
    columns: parsed.data.columns,
  });
  if (result.ok) revalidatePath("/leads");
  return result;
}

export async function updateLeadView(
  id: string,
  raw: unknown,
): Promise<{ ok: true; view: LeadView } | { ok: false; error: string }> {
  const parsed = viewInputSchema.partial().safeParse(raw);
  if (!parsed.success) return { ok: false, error: "That change could not be saved." };

  const { workspaceId, userId } = await getActiveContext();
  const result = await updateView(workspaceId, userId, await roleOf(userId, workspaceId), id, {
    ...parsed.data,
    filters: parsed.data.filters as FilterSet | undefined,
    sort: parsed.data.sort as SortSpec | undefined,
  });
  if (result.ok) revalidatePath("/leads");
  return result;
}

export async function deleteLeadView(
  id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { workspaceId, userId } = await getActiveContext();
  const result = await deleteView(workspaceId, userId, await roleOf(userId, workspaceId), id);
  if (result.ok) revalidatePath("/leads");
  return result;
}
