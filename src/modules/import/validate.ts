/**
 * Row-level import validation (playbook-v2 P5/3). Pure.
 *
 * The v1 import had exactly one verdict per row — new or duplicate — and
 * everything else it could not use it silently dropped. That is the failure
 * this replaces: a hundred-row file that imports sixty rows and says nothing
 * about the other forty is worse than one that refuses outright, because
 * nobody notices.
 *
 * So every row gets a REASON, and the operator decides what to do with it.
 */

import type { CsvCandidate } from "@/modules/leads/csv";
import { validateValues, type FieldDef } from "@/modules/fields/types";

export type RowStatus = "new" | "update" | "skip";

export type ProblemCode =
  | "no_identity"
  | "bad_email"
  | "bad_url"
  | "duplicate_in_file"
  | "duplicate_in_workspace"
  | "custom_field";

export interface RowProblem {
  code: ProblemCode;
  message: string;
}

export interface ValidatedRow {
  /** Index in the parsed file, so the UI can point at the actual line. */
  index: number;
  status: RowStatus;
  /** The lead this row matches, when it matches one. */
  existingLeadId: string | null;
  problems: RowProblem[];
  candidate: CsvCandidate;
}

export interface ValidationSummary {
  rows: ValidatedRow[];
  newCount: number;
  updateCount: number;
  skipCount: number;
  /** Problems by code, for the one-line summary above the table. */
  byCode: Record<string, number>;
}

/** What an existing lead looks like to the matcher. */
export interface ExistingRow {
  id: string;
  email: string | null;
  linkedinUrl: string | null;
  companyDomain: string | null;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const URL = /^https?:\/\/\S+$/i;

function normalizeEmail(v: string | undefined): string {
  return (v ?? "").trim().toLowerCase();
}

function normalizeUrl(v: string | undefined): string {
  return (v ?? "").trim().toLowerCase().replace(/\/+$/, "");
}

function normalizeDomain(v: string | undefined): string {
  return (v ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");
}

/**
 * Validate every row against the file itself, the workspace, and the custom
 * field definitions.
 *
 * `mode` decides what a match with an existing lead MEANS: in `skip` the row is
 * a duplicate to leave alone (the v1 behaviour), in `update` it is an update to
 * apply. Both are legitimate — a re-export of the same directory is usually an
 * update; a bought list is usually not — so it is a choice rather than a rule.
 */
export function validateRows(
  candidates: CsvCandidate[],
  existing: ExistingRow[],
  opts?: { customFields?: FieldDef[]; mode?: "skip" | "update" },
): ValidationSummary {
  const mode = opts?.mode ?? "skip";
  const customFields = opts?.customFields ?? [];

  const byEmail = new Map<string, string>();
  const byLinkedin = new Map<string, string>();
  const byDomain = new Map<string, string>();
  for (const row of existing) {
    const email = normalizeEmail(row.email ?? undefined);
    if (email && !byEmail.has(email)) byEmail.set(email, row.id);
    const linkedin = normalizeUrl(row.linkedinUrl ?? undefined);
    if (linkedin && !byLinkedin.has(linkedin)) byLinkedin.set(linkedin, row.id);
    const domain = normalizeDomain(row.companyDomain ?? undefined);
    if (domain && !byDomain.has(domain)) byDomain.set(domain, row.id);
  }

  const seenEmail = new Set<string>();
  const seenLinkedin = new Set<string>();
  const rows: ValidatedRow[] = [];

  candidates.forEach((candidate, index) => {
    const problems: RowProblem[] = [];
    const email = normalizeEmail(candidate.email);
    const linkedin = normalizeUrl(candidate.linkedinUrl);
    const domain = normalizeDomain(candidate.companyDomain);

    const hasIdentity = Boolean(
      email || linkedin || candidate.contactName?.trim() || candidate.companyName?.trim(),
    );
    if (!hasIdentity) {
      problems.push({
        code: "no_identity",
        message: "no name, email, LinkedIn URL or company — nothing to create",
      });
    }

    if (candidate.email && !EMAIL.test(email)) {
      problems.push({ code: "bad_email", message: `“${candidate.email}” is not an email address` });
    }
    if (candidate.linkedinUrl && !URL.test(candidate.linkedinUrl.trim())) {
      problems.push({
        code: "bad_url",
        message: `“${candidate.linkedinUrl}” is not a URL — it needs http:// or https://`,
      });
    }

    // A file that lists the same person twice is a very common export bug, and
    // importing both halves creates the duplicate P5/2 then has to clean up.
    if (email && seenEmail.has(email)) {
      problems.push({ code: "duplicate_in_file", message: `${email} appears earlier in this file` });
    }
    if (linkedin && seenLinkedin.has(linkedin)) {
      problems.push({
        code: "duplicate_in_file",
        message: "this LinkedIn URL appears earlier in this file",
      });
    }
    if (email) seenEmail.add(email);
    if (linkedin) seenLinkedin.add(linkedin);

    if (candidate.customFields && customFields.length > 0) {
      const res = validateValues(customFields, candidate.customFields);
      for (const p of res.problems) {
        problems.push({ code: "custom_field", message: `${p.label} ${p.message}` });
      }
    }

    const existingId =
      (email ? byEmail.get(email) : undefined) ??
      (linkedin ? byLinkedin.get(linkedin) : undefined) ??
      (domain ? byDomain.get(domain) : undefined) ??
      null;

    let status: RowStatus;
    const blocking = problems.some((p) => p.code !== "duplicate_in_workspace");
    if (blocking) {
      status = "skip";
    } else if (existingId) {
      if (mode === "update") {
        status = "update";
      } else {
        status = "skip";
        problems.push({
          code: "duplicate_in_workspace",
          message: "already in this workspace",
        });
      }
    } else {
      status = "new";
    }

    rows.push({ index, status, existingLeadId: existingId, problems, candidate });
  });

  const byCode: Record<string, number> = {};
  for (const row of rows) {
    for (const p of row.problems) byCode[p.code] = (byCode[p.code] ?? 0) + 1;
  }

  return {
    rows,
    newCount: rows.filter((r) => r.status === "new").length,
    updateCount: rows.filter((r) => r.status === "update").length,
    skipCount: rows.filter((r) => r.status === "skip").length,
    byCode,
  };
}

export const PROBLEM_LABELS: Record<ProblemCode, string> = {
  no_identity: "nothing identifying",
  bad_email: "bad email",
  bad_url: "bad URL",
  duplicate_in_file: "duplicated in the file",
  duplicate_in_workspace: "already here",
  custom_field: "custom field",
};
