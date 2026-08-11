import type { WorkspaceClient } from "../../lib/db";
import { scoreBand } from "../analytics/taxonomy";

/**
 * Saved lead segment for a cold-email audience (spec §4.16), e.g. "no-website
 * plumbers, Budapest, audited ≥70". Pure query shape + a live recipient-count
 * preview. Recipients must have an email; audit-score filters join the company's
 * latest audit.
 */
export interface SegmentQuery {
  city?: string;
  source?: string;
  hasWebsite?: boolean;
  minAuditScore?: number;
}

export function describeSegment(q: SegmentQuery): string {
  const parts: string[] = [];
  if (q.hasWebsite === false) parts.push("no website");
  if (q.hasWebsite === true) parts.push("has website");
  if (q.source) parts.push(q.source.toLowerCase());
  if (q.city) parts.push(q.city);
  if (typeof q.minAuditScore === "number") parts.push(`audited ≥${q.minAuditScore}`);
  return parts.join(" · ") || "all leads with email";
}

export interface SegmentRecipient {
  leadId: string;
  email: string;
  companyId: string | null;
}

export async function previewSegment(
  db: WorkspaceClient,
  q: SegmentQuery,
): Promise<{ count: number; recipients: SegmentRecipient[] }> {
  const where: Record<string, unknown> = { email: { not: null } };
  if (q.source) where.source = q.source;
  const companyWhere: Record<string, unknown> = {};
  if (q.city) companyWhere.city = q.city;
  if (q.hasWebsite === true) companyWhere.website = { not: null };
  if (q.hasWebsite === false) companyWhere.website = null;
  if (Object.keys(companyWhere).length) where.company = companyWhere;

  const leads = await db.lead.findMany({
    where,
    select: { id: true, email: true, companyId: true },
  });

  let recipients: SegmentRecipient[] = leads
    .filter((l): l is { id: string; email: string; companyId: string | null } => !!l.email)
    .map((l) => ({ leadId: l.id, email: l.email, companyId: l.companyId }));

  if (typeof q.minAuditScore === "number") {
    const companyIds = [...new Set(recipients.map((r) => r.companyId).filter((v): v is string => !!v))];
    const audits = companyIds.length
      ? await db.auditResult.findMany({
          where: { companyId: { in: companyIds }, status: "done" },
          orderBy: { createdAt: "desc" },
          select: { companyId: true, score: true },
        })
      : [];
    const scoreByCompany = new Map<string, number>();
    for (const a of audits) if (a.companyId && !scoreByCompany.has(a.companyId)) scoreByCompany.set(a.companyId, a.score);
    const min = q.minAuditScore;
    recipients = recipients.filter((r) => r.companyId != null && (scoreByCompany.get(r.companyId) ?? -1) >= min);
  }

  return { count: recipients.length, recipients };
}

/** Personalization slots for a recipient, filled from audit + registry DATA. */
export async function slotsForLead(
  db: WorkspaceClient,
  leadId: string,
  appUrl: string,
): Promise<Record<string, string>> {
  const lead = await db.lead.findUnique({
    where: { id: leadId },
    include: { company: { include: { audits: { where: { status: "done" }, orderBy: { createdAt: "desc" }, take: 1, include: { shares: { take: 1 } } } } } },
  });
  const company = lead?.company ?? null;
  const audit = company?.audits[0] ?? null;
  const flags = Array.isArray(audit?.flags) ? (audit!.flags as string[]) : [];
  const shareSlug = audit?.shares[0]?.slug ?? null;
  return {
    company: company?.name ?? "",
    city: company?.city ?? "",
    audit_score: audit ? String(audit.score) : "",
    audit_finding: flags[0] ?? "",
    audit_link: shareSlug ? `${appUrl}/share/${shareSlug}` : "",
    booking_link: `${appUrl.replace(/^https?:\/\//, "https://meet.")}/tamas`,
    scoreBand: audit ? scoreBand(audit.score) : "",
  };
}
