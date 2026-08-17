/**
 * Running and undoing an import (playbook-v2 P5/3).
 *
 * Workspace-id in rather than session-derived, so the rollback's conflict
 * detection — the part actually worth getting right — is provable against a
 * real database.
 *
 * WHY A BATCH RECORDS BEFORE **AND** AFTER. A rollback has to answer one
 * question: is this row still what the import left, or has a person fixed it
 * since? Comparing the live row against the recorded AFTER answers it exactly.
 * Comparing against timestamps does not — `updatedAt` moves for reasons that
 * have nothing to do with the fields the import wrote.
 */

import { getWorkspaceClient } from "@/lib/db";
import { normalizeTaxId } from "@/modules/registry/dedupe";
import { normalizeDomain } from "@/modules/leads/dedupe";
import { listFieldDefsWith } from "@/modules/fields/store";
import { validateValues, readValues, mergeValues } from "@/modules/fields/types";
import { validateRows, type ValidatedRow, type ValidationSummary } from "./validate";
import type { CsvCandidate } from "@/modules/leads/csv";

export const ROLLBACK_WINDOW_DAYS = 7;

/** The lead fields an import may write, and therefore may revert. */
const LEAD_FIELDS = ["contactName", "title", "email", "phone", "linkedinUrl"] as const;

export interface BatchRecord {
  entity: "lead" | "company";
  id: string;
  action: "created" | "updated";
  /** The values before the import touched them. Absent on a create. */
  before?: Record<string, unknown>;
  /** The values the import left. What a conflict check compares against. */
  after?: Record<string, unknown>;
}

export interface ImportResult {
  batchId: string;
  created: number;
  updated: number;
  skipped: number;
}

export async function loadExistingRows(workspaceId: string) {
  const db = getWorkspaceClient(workspaceId);
  const rows = await db.lead.findMany({
    where: { mergedIntoId: null },
    select: {
      id: true,
      email: true,
      linkedinUrl: true,
      company: { select: { domain: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    linkedinUrl: r.linkedinUrl,
    companyDomain: r.company?.domain ?? null,
  }));
}

/** Validate a parsed file without writing anything. */
export async function validateImport(
  workspaceId: string,
  candidates: CsvCandidate[],
  opts?: { mode?: "skip" | "update" },
): Promise<ValidationSummary> {
  const db = getWorkspaceClient(workspaceId);
  const [existing, customFields] = await Promise.all([
    loadExistingRows(workspaceId),
    listFieldDefsWith(db, "lead", { activeOnly: true }),
  ]);
  return validateRows(candidates, existing, { customFields, mode: opts?.mode });
}

function pick(row: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) out[f] = row[f] ?? null;
  return out;
}

/**
 * Run an import as a tracked batch.
 *
 * Only rows the caller explicitly kept are applied: `skipIndexes` carries the
 * operator's decisions from the preview, so "skip this one" means what it says
 * rather than being re-derived here from rules that may have changed.
 */
export async function runImport(
  workspaceId: string,
  actorUserId: string | null,
  input: {
    candidates: CsvCandidate[];
    filename?: string;
    templateId?: string | null;
    mode?: "skip" | "update";
    /** File-row indexes the operator chose to leave out. */
    skipIndexes?: number[];
  },
): Promise<ImportResult> {
  const db = getWorkspaceClient(workspaceId);
  const summary = await validateImport(workspaceId, input.candidates, { mode: input.mode });
  const customFields = await listFieldDefsWith(db, "lead", { activeOnly: true });
  const skip = new Set(input.skipIndexes ?? []);

  const now = new Date();
  const batch = await db.importBatch.create({
    data: {
      workspaceId,
      filename: input.filename ?? null,
      templateId: input.templateId ?? null,
      records: [],
      rollbackUntil: new Date(now.getTime() + ROLLBACK_WINDOW_DAYS * 86_400_000),
      createdBy: actorUserId,
    },
  });

  const records: BatchRecord[] = [];
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const row of summary.rows) {
    if (skip.has(row.index) || row.status === "skip") {
      skipped += 1;
      continue;
    }
    if (row.status === "new") {
      const lead = await createFromRow(db, workspaceId, row, batch.id, customFields, records);
      if (lead) created += 1;
      else skipped += 1;
    } else if (row.status === "update" && row.existingLeadId) {
      const ok = await updateFromRow(db, row, batch.id, customFields, records);
      if (ok) updated += 1;
      else skipped += 1;
    }
  }

  await db.importBatch.update({
    where: { id: batch.id },
    data: {
      records: records as unknown as object[],
      createdCount: created,
      updatedCount: updated,
      skippedCount: skipped,
    },
  });

  return { batchId: batch.id, created, updated, skipped };
}

type Db = ReturnType<typeof getWorkspaceClient>;

async function findOrCreateCompany(
  db: Db,
  workspaceId: string,
  candidate: CsvCandidate,
  batchId: string,
  records: BatchRecord[],
): Promise<string | null> {
  const name = candidate.companyName?.trim();
  const domain = normalizeDomain(candidate.companyDomain);
  if (!name && !domain) return null;

  if (domain) {
    const existing = await db.company.findFirst({ where: { domain, mergedIntoId: null } });
    if (existing) return existing.id;
  }
  const company = await db.company.create({
    data: {
      workspaceId,
      name: name || domain || "Unknown company",
      domain: domain || undefined,
      importBatchId: batchId,
    },
  });
  records.push({ entity: "company", id: company.id, action: "created" });
  return company.id;
}

async function createFromRow(
  db: Db,
  workspaceId: string,
  row: ValidatedRow,
  batchId: string,
  customFields: Awaited<ReturnType<typeof listFieldDefsWith>>,
  records: BatchRecord[],
): Promise<string | null> {
  const c = row.candidate;
  const companyId = await findOrCreateCompany(db, workspaceId, c, batchId, records);
  const custom = c.customFields
    ? validateValues(customFields, c.customFields).values
    : {};

  const lead = await db.lead.create({
    data: {
      workspaceId,
      companyId,
      contactName: c.contactName ?? null,
      title: c.title ?? null,
      email: c.email ?? null,
      linkedinUrl: c.linkedinUrl ?? null,
      source: "MANUAL",
      stage: "RESEARCHED",
      importBatchId: batchId,
      ...(Object.keys(custom).length > 0 ? { customFields: custom as object } : {}),
    },
  });
  records.push({
    entity: "lead",
    id: lead.id,
    action: "created",
    after: pick(lead as unknown as Record<string, unknown>, LEAD_FIELDS),
  });
  return lead.id;
}

async function updateFromRow(
  db: Db,
  row: ValidatedRow,
  batchId: string,
  customFields: Awaited<ReturnType<typeof listFieldDefsWith>>,
  records: BatchRecord[],
): Promise<boolean> {
  const id = row.existingLeadId!;
  const current = await db.lead.findUnique({ where: { id } });
  if (!current) return false;

  const c = row.candidate;
  const patch: Record<string, unknown> = {};
  // An import FILLS GAPS and corrects, but never blanks a field: a column left
  // empty in an export is almost always "not exported", not "delete this".
  for (const [field, value] of [
    ["contactName", c.contactName],
    ["title", c.title],
    ["email", c.email],
    ["linkedinUrl", c.linkedinUrl],
  ] as const) {
    if (value && value.trim()) patch[field] = value.trim();
  }
  if (c.customFields) {
    const validated = validateValues(customFields, c.customFields);
    if (Object.keys(validated.values).length > 0) {
      patch.customFields = mergeValues(
        readValues(current.customFields),
        validated.values,
      ) as object;
    }
  }
  if (Object.keys(patch).length === 0) return false;

  const before = pick(current as unknown as Record<string, unknown>, LEAD_FIELDS);
  const after = await db.lead.update({
    where: { id },
    data: { ...patch, importBatchId: batchId },
  });
  records.push({
    entity: "lead",
    id,
    action: "updated",
    before,
    after: pick(after as unknown as Record<string, unknown>, LEAD_FIELDS),
  });
  return true;
}

// ---- rollback ---------------------------------------------------------------

export interface RollbackConflict {
  entity: string;
  id: string;
  label: string;
  reason: string;
}

export type RollbackResult =
  | { ok: true; deleted: number; reverted: number }
  | { ok: false; error: string; conflicts?: RollbackConflict[] };

/**
 * Undo a batch, within the window.
 *
 * Refuses rather than overwrites when a person has touched a row since. That is
 * the whole point: a rollback that silently discards someone's correction is a
 * second import, not an undo. Every conflict is named so the operator can
 * decide what to do with them by hand.
 */
export async function rollbackImport(
  workspaceId: string,
  actorUserId: string | null,
  batchId: string,
  now: Date = new Date(),
): Promise<RollbackResult> {
  const db = getWorkspaceClient(workspaceId);
  const batch = await db.importBatch.findUnique({ where: { id: batchId } });
  if (!batch) return { ok: false, error: "That import is not on record." };
  if (batch.rolledBackAt) return { ok: false, error: "That import has already been rolled back." };
  if (batch.rollbackUntil < now) {
    return {
      ok: false,
      error: `The ${ROLLBACK_WINDOW_DAYS}-day window for rolling back this import has closed.`,
    };
  }

  const records = (
    Array.isArray(batch.records) ? batch.records : []
  ) as unknown as BatchRecord[];
  const conflicts: RollbackConflict[] = [];

  // Pass one: look for anything a rollback would destroy. Nothing is written
  // until every record has been checked.
  for (const record of records) {
    if (record.entity !== "lead") continue;
    const lead = await db.lead.findUnique({
      where: { id: record.id },
      select: {
        id: true,
        contactName: true,
        email: true,
        title: true,
        phone: true,
        linkedinUrl: true,
        stage: true,
        icpScore: true,
        _count: {
          select: { activities: true, messages: true, calls: true, documents: true, deals: true },
        },
      },
    });
    if (!lead) continue; // already gone; nothing to lose

    const live = pick(lead as unknown as Record<string, unknown>, LEAD_FIELDS);
    const edited = record.after
      ? LEAD_FIELDS.some((f) => (live[f] ?? null) !== (record.after![f] ?? null))
      : false;

    if (record.action === "updated" && edited) {
      conflicts.push({
        entity: "lead",
        id: lead.id,
        label: lead.contactName ?? lead.email ?? lead.id,
        reason: "edited by hand since the import",
      });
      continue;
    }

    if (record.action === "created") {
      const counts = lead._count;
      const worked =
        counts.activities > 0 ||
        counts.messages > 0 ||
        counts.calls > 0 ||
        counts.documents > 0 ||
        counts.deals > 0;
      if (worked) {
        conflicts.push({
          entity: "lead",
          id: lead.id,
          label: lead.contactName ?? lead.email ?? lead.id,
          reason: "has been worked since the import (activity, messages, calls, documents or a deal)",
        });
      } else if (edited) {
        conflicts.push({
          entity: "lead",
          id: lead.id,
          label: lead.contactName ?? lead.email ?? lead.id,
          reason: "edited by hand since the import",
        });
      } else if (lead.stage !== "RESEARCHED" || lead.icpScore !== null) {
        conflicts.push({
          entity: "lead",
          id: lead.id,
          label: lead.contactName ?? lead.email ?? lead.id,
          reason: "has been researched or moved to another stage",
        });
      }
    }
  }

  if (conflicts.length > 0) {
    return {
      ok: false,
      error:
        `Rolling this import back would lose later work on ${conflicts.length} record(s). ` +
        "Fix or delete them by hand first.",
      conflicts,
    };
  }

  // Pass two: apply.
  let deleted = 0;
  let reverted = 0;
  for (const record of records) {
    if (record.entity === "lead") {
      if (record.action === "created") {
        const res = await db.lead.deleteMany({ where: { id: record.id } });
        deleted += res.count;
      } else if (record.before) {
        await db.lead.updateMany({
          where: { id: record.id },
          data: { ...record.before, importBatchId: null },
        });
        reverted += 1;
      }
    }
  }
  // Companies last: a company created by the import can only go once the leads
  // that pointed at it are gone.
  for (const record of records) {
    if (record.entity !== "company" || record.action !== "created") continue;
    const inUse = await db.lead.count({ where: { companyId: record.id } });
    if (inUse > 0) continue;
    const res = await db.company.deleteMany({ where: { id: record.id } });
    deleted += res.count;
  }

  await db.importBatch.update({
    where: { id: batchId },
    data: { status: "rolled_back", rolledBackAt: now, rolledBackBy: actorUserId },
  });

  return { ok: true, deleted, reverted };
}

// ---- templates and history --------------------------------------------------

export interface TemplateRow {
  id: string;
  name: string;
  source: string | null;
  mapping: Record<string, number>;
  coercions: Record<string, string>;
}

export async function listImportTemplates(workspaceId: string): Promise<TemplateRow[]> {
  const db = getWorkspaceClient(workspaceId);
  const rows = await db.importTemplate.findMany({ orderBy: { name: "asc" } });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    source: r.source,
    mapping: (r.mapping ?? {}) as Record<string, number>,
    coercions: (r.coercions ?? {}) as Record<string, string>,
  }));
}

export async function saveImportTemplate(
  workspaceId: string,
  actorUserId: string | null,
  input: { name: string; source?: string | null; mapping: Record<string, number> },
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const name = input.name.trim();
  if (!name) return { ok: false, error: "A template needs a name." };
  const db = getWorkspaceClient(workspaceId);

  const existing = await db.importTemplate.findFirst({ where: { name } });
  if (existing) {
    // Re-saving under the same name UPDATES it. A second "Bisnode export (2)"
    // is not what anyone means by saving a mapping again.
    await db.importTemplate.update({
      where: { id: existing.id },
      data: { mapping: input.mapping, source: input.source ?? existing.source },
    });
    return { ok: true, id: existing.id };
  }

  const row = await db.importTemplate.create({
    data: {
      workspaceId,
      name,
      source: input.source ?? null,
      mapping: input.mapping,
      createdBy: actorUserId,
    },
  });
  return { ok: true, id: row.id };
}

export async function deleteImportTemplate(
  workspaceId: string,
  id: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const db = getWorkspaceClient(workspaceId);
  const res = await db.importTemplate.deleteMany({ where: { id } });
  return res.count > 0 ? { ok: true } : { ok: false, error: "That template no longer exists." };
}

export interface BatchRow {
  id: string;
  filename: string | null;
  status: string;
  created: number;
  updated: number;
  skipped: number;
  at: string;
  rollbackUntil: string;
  rolledBackAt: string | null;
  canRollback: boolean;
}

export async function listImportBatches(
  workspaceId: string,
  now: Date = new Date(),
): Promise<BatchRow[]> {
  const db = getWorkspaceClient(workspaceId);
  const rows = await db.importBatch.findMany({ orderBy: { createdAt: "desc" }, take: 50 });
  return rows.map((b) => ({
    id: b.id,
    filename: b.filename,
    status: b.status,
    created: b.createdCount,
    updated: b.updatedCount,
    skipped: b.skippedCount,
    at: b.createdAt.toISOString(),
    rollbackUntil: b.rollbackUntil.toISOString(),
    rolledBackAt: b.rolledBackAt?.toISOString() ?? null,
    canRollback: !b.rolledBackAt && b.rollbackUntil >= now,
  }));
}

/** Kept for the company path — the tax id normaliser is shared with dedupe. */
export { normalizeTaxId };
