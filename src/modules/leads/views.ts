/**
 * Saved views (playbook-v2 P3/2): a named filter set + column selection + sort,
 * personal or workspace-shared, rendered as the tabs above the leads table.
 *
 * Pure rules only — visibility, editability, naming, and the mapping between a
 * stored view and the query string the table already reads. The server actions
 * in `view-actions.ts` enforce these; keeping them here means they can be
 * tested without a database and reused by the UI to hide what it must not offer.
 */

import { serializeFilterSet, serializeSort, serializeColumns } from "./view-params";
import type { FilterCondition, FilterSet, SortSpec } from "./filters";

export interface LeadView {
  id: string;
  name: string;
  /** Who created it. A shared view still remembers whose it is. */
  ownerId: string;
  shared: boolean;
  filters: FilterSet;
  sort: SortSpec;
  columns: string[];
  position: number;
}

/** A tab a person may not see is a tab that must not reach their browser. */
export function canSeeView(view: LeadView, userId: string): boolean {
  return view.shared || view.ownerId === userId;
}

/**
 * Seeing a shared tab is not the same as being able to redefine it under the
 * person who made it. Only the creator edits their own; Owners and Admins may
 * curate the workspace's shared tabs, which is what makes them shared rather
 * than merely visible.
 */
export function canEditView(view: LeadView, userId: string, role: string): boolean {
  if (view.ownerId === userId) return true;
  return role === "OWNER" || role === "ADMIN";
}

export const MAX_VIEW_NAME = 60;

/** Null when there is no name left after trimming — the caller reports that. */
export function normalizeViewName(raw: string): string | null {
  const name = raw.trim().replace(/\s+/g, " ");
  if (name.length === 0) return null;
  return name.slice(0, MAX_VIEW_NAME);
}

/** Order-independent identity for one condition. */
function conditionKey(c: FilterCondition): string {
  return JSON.stringify([
    c.field,
    c.operator,
    c.value ?? null,
    [...(c.values ?? [])].sort(),
    c.min ?? null,
    c.max ?? null,
  ]);
}

function sameFilters(a: FilterSet, b: FilterSet): boolean {
  if (a.match !== b.match) return false;
  if (a.conditions.length !== b.conditions.length) return false;
  // Condition ORDER is not something the user chose — two conditions added the
  // other way round describe the same question, and the tab should stay lit.
  const left = a.conditions.map(conditionKey).sort();
  const right = b.conditions.map(conditionKey).sort();
  return left.every((k, i) => k === right[i]);
}

/** Is the table currently showing exactly this view? Drives tab highlighting. */
export function viewMatchesState(
  view: LeadView,
  filters: FilterSet,
  sort: SortSpec,
  columns: string[],
): boolean {
  if (!sameFilters(view.filters, filters)) return false;
  if (view.sort.field !== sort.field || view.sort.direction !== sort.direction) return false;
  if (view.columns.length !== columns.length) return false;
  // Column order IS a choice, so this one compares positionally.
  return view.columns.every((c, i) => c === columns[i]);
}

/**
 * The query string that opens a view. Deliberately produces no `page`: opening
 * a tab lands on its first page, never on whatever page the previous tab was on.
 */
export function viewToQuery(view: LeadView): URLSearchParams {
  const q = new URLSearchParams();
  q.set("view", view.id);
  const f = serializeFilterSet(view.filters);
  if (f) q.set("f", f);
  q.set("sort", serializeSort(view.sort));
  q.set("cols", serializeColumns(view.columns));
  return q;
}
