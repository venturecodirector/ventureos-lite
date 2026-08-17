/**
 * Loading the leads table (playbook-v2 P3/2).
 *
 * One read of the workspace's leads, then filter → sort → paginate in memory.
 * `filters.ts` explains why the predicates cannot live in the `where` clause;
 * the consequence here is that `total`, `pageCount` and "select all matching"
 * are all derived from the same array and therefore cannot disagree.
 */

import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import { companyUnderProceedings, riskLabel } from "@/modules/registry/risk";
import { gateThresholdFromConfig } from "./scoring";
import { listFieldDefsWith } from "@/modules/fields/store";
import { readValues, type FieldDef } from "@/modules/fields/types";
import {
  applyFilters,
  applySort,
  paginate,
  DEFAULT_PAGE_SIZE,
  type FilterSet,
  type FilterableLead,
  type SortSpec,
} from "./filters";

export interface LeadTableRow extends FilterableLead {
  companyId: string | null;
  avatarPath: string | null;
  sizeBand: string | null;
  /** Registry proceedings chip, when the company is under one. */
  riskLabel: string | null;
  ownerName: string | null;
}

export interface WorkspaceMember {
  id: string;
  name: string;
}

/** The dropdown contents for the filter builder — real values, not guesses. */
export interface LeadFacets {
  industries: string[];
  cities: string[];
  signals: string[];
  sources: string[];
  stages: string[];
  owners: WorkspaceMember[];
}

export interface LeadTableData {
  rows: LeadTableRow[];
  page: number;
  pageCount: number;
  pageSize: number;
  /** Rows matching the filter — not rows in the workspace. */
  total: number;
  /** Rows in the workspace, so the UI can say "12 of 93". */
  totalUnfiltered: number;
  threshold: number;
  facets: LeadFacets;
  /** Owner-defined lead fields (P5/1) — columns, filters and cell rendering. */
  customFields: FieldDef[];
}

type LoadedLead = Awaited<ReturnType<typeof fetchLeads>>[number];

async function fetchLeads(workspaceId: string) {
  const db = getWorkspaceClient(workspaceId);
  return db.lead.findMany({
    // Tombstones are not rows a person works — a merged-away lead lives on so
    // its id still resolves, not so it can clutter the table (P5/2).
    where: { mergedIntoId: null },
    select: {
      id: true,
      companyId: true,
      contactName: true,
      avatarPath: true,
      title: true,
      email: true,
      phone: true,
      icpScore: true,
      stage: true,
      signals: true,
      source: true,
      ownerId: true,
      lastActivityAt: true,
      createdAt: true,
      customFields: true,
      company: {
        select: {
          name: true,
          industry: true,
          city: true,
          sizeBand: true,
          registry: { select: { statusFlags: true } },
        },
      },
    },
  });
}

function toRow(l: LoadedLead, ownerNames: Map<string, string>): LeadTableRow {
  const statusFlags = Array.isArray(l.company?.registry?.statusFlags)
    ? (l.company.registry.statusFlags as string[])
    : null;
  return {
    id: l.id,
    companyId: l.companyId,
    contactName: l.contactName,
    avatarPath: l.avatarPath,
    title: l.title,
    email: l.email,
    phone: l.phone,
    company: l.company?.name ?? null,
    industry: l.company?.industry ?? null,
    city: l.company?.city ?? null,
    sizeBand: l.company?.sizeBand ?? null,
    icpScore: l.icpScore,
    stage: l.stage,
    signals: Array.isArray(l.signals) ? (l.signals as string[]) : [],
    source: l.source,
    ownerId: l.ownerId,
    ownerName: l.ownerId ? (ownerNames.get(l.ownerId) ?? null) : null,
    lastActivityAt: l.lastActivityAt,
    createdAt: l.createdAt,
    customFields: readValues(l.customFields),
    riskLabel: companyUnderProceedings(statusFlags) ? riskLabel(statusFlags) : null,
  };
}

/** Everyone who could own a lead here — the workspace's own members, only. */
export async function workspaceMembers(workspaceId: string): Promise<WorkspaceMember[]> {
  const memberships = await prismaUnsafe.membership.findMany({
    where: { workspaceId },
    select: { userId: true },
  });
  if (memberships.length === 0) return [];
  const users = await prismaUnsafe.user.findMany({
    where: { id: { in: memberships.map((m) => m.userId) } },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
  return users;
}

/** Distinct values actually present, so the filter never offers a dead end. */
function buildFacets(rows: LeadTableRow[], owners: WorkspaceMember[]): LeadFacets {
  const uniqueSorted = (values: Array<string | null>) =>
    [...new Set(values.filter((v): v is string => !!v && v.trim().length > 0))].sort((a, b) =>
      a.localeCompare(b, "hu"),
    );

  return {
    industries: uniqueSorted(rows.map((r) => r.industry)),
    cities: uniqueSorted(rows.map((r) => r.city)),
    signals: uniqueSorted(rows.flatMap((r) => r.signals)),
    sources: uniqueSorted(rows.map((r) => r.source)),
    stages: uniqueSorted(rows.map((r) => r.stage)),
    owners,
  };
}

export async function loadLeadsTable(
  workspaceId: string,
  opts: {
    filters: FilterSet;
    sort: SortSpec;
    page: number;
    pageSize?: number;
    now?: Date;
  },
): Promise<LeadTableData> {
  const [leads, owners, ws, customFields] = await Promise.all([
    fetchLeads(workspaceId),
    workspaceMembers(workspaceId),
    prismaUnsafe.workspace.findUnique({
      where: { id: workspaceId },
      select: { icpConfig: true },
    }),
    listFieldDefsWith(getWorkspaceClient(workspaceId), "lead"),
  ]);

  const ownerNames = new Map(owners.map((o) => [o.id, o.name]));
  const all = leads.map((l) => toRow(l, ownerNames));

  const matched = applyFilters(all, opts.filters, opts.now ?? new Date(), customFields);
  const sorted = applySort(matched, opts.sort);
  const page = paginate(sorted, opts.page, opts.pageSize ?? DEFAULT_PAGE_SIZE);

  return {
    rows: page.rows,
    page: page.page,
    pageCount: page.pageCount,
    pageSize: page.pageSize,
    total: page.total,
    totalUnfiltered: all.length,
    threshold: gateThresholdFromConfig(ws?.icpConfig),
    // Facets come from ALL leads, not the filtered set: a dropdown that loses
    // its other options the moment you pick one cannot be used to change your
    // mind, which is most of what filtering is.
    facets: buildFacets(all, owners),
    customFields,
  };
}

/**
 * Every lead id matching a filter set, for a bulk action that was launched with
 * "select all matching" rather than with ticked checkboxes. Recomputed
 * server-side from the filter rather than trusted from the client — the browser
 * may not decide which rows a mutation touches.
 */
export async function matchingLeadIds(
  workspaceId: string,
  filters: FilterSet,
  now: Date = new Date(),
): Promise<string[]> {
  const [leads, customFields] = await Promise.all([
    fetchLeads(workspaceId),
    listFieldDefsWith(getWorkspaceClient(workspaceId), "lead"),
  ]);
  const rows = leads.map((l) => toRow(l, new Map()));
  return applyFilters(rows, filters, now, customFields).map((r) => r.id);
}
