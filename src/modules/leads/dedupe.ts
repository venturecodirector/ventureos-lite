/**
 * Lead dedupe (spec §4.2 — "same person/domain"). Person is keyed by email and
 * LinkedIn URL; company by domain. (Adószám becomes the stronger dedupe key once
 * registry enrichment lands in Phase 2, §4.19.)
 */

export function normalizeEmail(email?: string | null): string | null {
  if (!email) return null;
  const e = email.trim().toLowerCase();
  return e.length ? e : null;
}

export function normalizeDomain(input?: string | null): string | null {
  if (!input) return null;
  let s = input.trim().toLowerCase();
  if (!s) return null;
  // If it's an email, take the domain part.
  if (s.includes("@")) s = s.split("@").pop() ?? s;
  // Strip scheme and any path/query.
  s = s.replace(/^[a-z]+:\/\//, "");
  s = s.split("/")[0];
  s = s.replace(/^www\./, "");
  return s.length ? s : null;
}

export function normalizeLinkedin(url?: string | null): string | null {
  if (!url) return null;
  let s = url.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z]+:\/\//, "").replace(/^www\./, "");
  s = s.replace(/\/+$/, ""); // trailing slashes
  s = s.split("?")[0];
  return s.length ? s : null;
}

export interface DedupeKeys {
  email?: string | null;
  linkedinUrl?: string | null;
  companyDomain?: string | null;
}

export interface ExistingLead extends DedupeKeys {
  id: string;
}

export type DedupeReason = "email" | "linkedin" | "domain";

function matchReason(a: DedupeKeys, b: DedupeKeys): DedupeReason | null {
  const ae = normalizeEmail(a.email);
  const be = normalizeEmail(b.email);
  if (ae && be && ae === be) return "email";

  const al = normalizeLinkedin(a.linkedinUrl);
  const bl = normalizeLinkedin(b.linkedinUrl);
  if (al && bl && al === bl) return "linkedin";

  const ad = normalizeDomain(a.companyDomain);
  const bd = normalizeDomain(b.companyDomain);
  if (ad && bd && ad === bd) return "domain";

  return null;
}

export function findDuplicate<E extends ExistingLead>(
  candidate: DedupeKeys,
  existing: E[],
): E | null {
  for (const e of existing) {
    if (matchReason(candidate, e)) return e;
  }
  return null;
}

export interface DedupeResult<C> {
  index: number;
  candidate: C;
  status: "new" | "duplicate";
  reason?: DedupeReason;
  matchedId?: string; // existing lead id, or `batch:<index>` for in-batch dups
}

export function dedupePreview<C extends DedupeKeys>(
  candidates: C[],
  existing: ExistingLead[],
): Array<DedupeResult<C>> {
  const accepted: ExistingLead[] = [...existing];
  return candidates.map((candidate, index) => {
    // Check existing first (real ids), then rows already accepted this batch.
    const dupExisting = findDuplicate(candidate, existing);
    if (dupExisting) {
      return {
        index,
        candidate,
        status: "duplicate",
        reason: matchReason(candidate, dupExisting)!,
        matchedId: dupExisting.id,
      };
    }
    const batchDup = accepted.find(
      (a) => a.id.startsWith("batch:") && matchReason(candidate, a),
    );
    if (batchDup) {
      return {
        index,
        candidate,
        status: "duplicate",
        reason: matchReason(candidate, batchDup)!,
        matchedId: batchDup.id,
      };
    }
    accepted.push({ id: `batch:${index}`, ...candidate });
    return { index, candidate, status: "new" };
  });
}
