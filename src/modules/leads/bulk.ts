/**
 * What a bulk action DOES, decided in pure code (playbook-v2 P3/2).
 *
 * The server actions carry these decisions out; keeping the decisions here
 * means the score gate — which the playbook requires to hold per lead even when
 * two hundred are moved at once — is provable without a database.
 */

import { foldText } from "../search/fuzzy";
import { columnDef } from "./columns";

/**
 * How many leads one server round trip touches.
 *
 * Small enough that the progress bar moves and a failure loses little work,
 * large enough that moving 500 leads is ten calls rather than five hundred.
 */
export const BULK_BATCH_SIZE = 50;

export interface SkippedLead {
  id: string;
  reason: string;
}

export interface BulkResult {
  applied: number;
  skipped: SkippedLead[];
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function mergeBulkResults(results: BulkResult[]): BulkResult {
  return {
    applied: results.reduce((n, r) => n + r.applied, 0),
    skipped: results.flatMap((r) => r.skipped),
  };
}

// ---- stage changes --------------------------------------------------------

export interface StageCandidate {
  id: string;
  icpScore: number | null;
  stage: string;
}

export interface StagePlan {
  allowed: string[];
  skipped: SkippedLead[];
}

/**
 * Decide which of these leads may enter `toStage`.
 *
 * The score gate (CLAUDE.md hard rule #5) applies to each lead individually —
 * a bulk move is not a way around it. Leads that fail are SKIPPED and named,
 * never silently dropped and never allowed to fail the whole batch: refusing
 * 200 moves because one lead scores 2 would be useless.
 */
export function planStageChange(
  rows: StageCandidate[],
  toStage: string,
  threshold: number,
): StagePlan {
  const allowed: string[] = [];
  const skipped: SkippedLead[] = [];

  for (const row of rows) {
    if (row.stage === toStage) {
      // Counting these as moved would inflate the report with work not done.
      skipped.push({ id: row.id, reason: "already in that stage" });
      continue;
    }
    if (toStage === "CONTACTED" && (row.icpScore === null || row.icpScore < threshold)) {
      skipped.push({
        id: row.id,
        reason:
          row.icpScore === null
            ? `below the score gate (unscored, gate is ${threshold})`
            : `below the score gate (${row.icpScore} < ${threshold})`,
      });
      continue;
    }
    allowed.push(row.id);
  }

  return { allowed, skipped };
}

// ---- signal tags ----------------------------------------------------------

/**
 * Tags are compared folded — case- and accent-insensitively — because
 * "Régi weboldal" and "regi weboldal" are the same tag to everyone except a
 * string comparison, and letting both exist means every filter over signals
 * starts missing half its leads.
 */
function sameTag(a: string, b: string): boolean {
  return foldText(a) === foldText(b);
}

export function addSignals(existing: string[], toAdd: string[]): string[] {
  const out = [...existing];
  for (const raw of toAdd) {
    const tag = raw.trim();
    if (!tag) continue;
    // Keep the spelling the lead already had rather than overwriting it with
    // whatever was typed into the bulk box just now.
    if (out.some((e) => sameTag(e, tag))) continue;
    out.push(tag);
  }
  return out;
}

export function removeSignals(existing: string[], toRemove: string[]): string[] {
  const drop = toRemove.map((t) => t.trim()).filter(Boolean);
  if (drop.length === 0) return [...existing];
  return existing.filter((e) => !drop.some((d) => sameTag(e, d)));
}

// ---- CSV ------------------------------------------------------------------

export interface CsvLead {
  id: string;
  contactName?: string | null;
  title?: string | null;
  company?: string | null;
  email?: string | null;
  phone?: string | null;
  industry?: string | null;
  city?: string | null;
  icpScore?: number | null;
  stage?: string | null;
  signals?: string[];
  source?: string | null;
  ownerName?: string | null;
  lastActivityAt?: Date | string | null;
  createdAt?: Date | string | null;
}

function cellValue(lead: CsvLead, column: string): string {
  const date = (v: Date | string | null | undefined) =>
    v ? new Date(v).toISOString().slice(0, 10) : "";
  switch (column) {
    case "contact":
      return lead.contactName ?? "";
    case "company":
      return lead.company ?? "";
    case "title":
      return lead.title ?? "";
    case "email":
      return lead.email ?? "";
    case "phone":
      return lead.phone ?? "";
    case "industry":
      return lead.industry ?? "";
    case "city":
      return lead.city ?? "";
    case "icpScore":
      return lead.icpScore == null ? "" : String(lead.icpScore);
    case "stage":
      return lead.stage ?? "";
    // Semicolons, not JSON: a spreadsheet is the destination, and `["a","b"]`
    // in a cell helps nobody.
    case "signals":
      return (lead.signals ?? []).join("; ");
    case "source":
      return lead.source ?? "";
    case "owner":
      return lead.ownerName ?? "";
    case "lastActivity":
      return date(lead.lastActivityAt);
    case "created":
      return date(lead.createdAt);
    default:
      return "";
  }
}

/** RFC 4180: quote when the value contains a comma, a quote or a newline. */
function escapeCsv(value: string): string {
  if (!/[",\n\r]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Export exactly the columns on screen, in the order they are on screen — the
 * point of exporting a filtered, arranged table is to get that table.
 */
export function buildLeadsCsv(leads: CsvLead[], columns: string[]): string {
  const header = columns.map((key) => escapeCsv(columnDef(key)?.label ?? key)).join(",");
  const lines = leads.map((lead) =>
    columns.map((key) => escapeCsv(cellValue(lead, key))).join(","),
  );
  return [header, ...lines].join("\n");
}
