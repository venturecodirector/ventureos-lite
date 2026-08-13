import type { WorkspaceClient } from "../../lib/db";
import { auditShareLink, bookingLink } from "../../lib/public-links";
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

/**
 * Drop leads whose only reason for being here is a self-serve audit they never
 * gave marketing consent for.
 *
 * A lead is excluded when it has a consent record and NONE of its records carry
 * marketing consent. A lead we sourced ourselves has no consent record at all
 * and is untouched — this filter narrows inbound, it does not gate the pipeline.
 */
async function excludeUnconsentedInbound(
  db: WorkspaceClient,
  recipients: SegmentRecipient[],
): Promise<SegmentRecipient[]> {
  if (recipients.length === 0) return recipients;

  const consents = await db.publicAuditConsent.findMany({
    where: { leadId: { in: recipients.map((r) => r.leadId) } },
    select: { leadId: true, marketingConsent: true },
  });
  if (consents.length === 0) return recipients;

  const consented = new Set<string>();
  const known = new Set<string>();
  for (const c of consents) {
    if (!c.leadId) continue;
    known.add(c.leadId);
    if (c.marketingConsent) consented.add(c.leadId);
  }

  return recipients.filter((r) => !known.has(r.leadId) || consented.has(r.leadId));
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

  // ---- Self-serve inbound without marketing consent (P12/1c) -------------
  //
  // Someone who ran their own audit gave us an address so we could SEND THEM A
  // REPORT. Unless they also ticked the marketing box, that address is not a
  // campaign audience, and putting it in one would be precisely the unsolicited
  // mail the Grtv. is about.
  //
  // Enforced HERE because previewSegment is the single function every audience
  // flows through — the preview count, campaign creation and the send path all
  // read it, so one filter covers all three and one test proves it.
  recipients = await excludeUnconsentedInbound(db, recipients);

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
): Promise<Record<string, string>> {
  const lead = await db.lead.findUnique({
    where: { id: leadId },
    include: { company: { include: { audits: { where: { status: "done" }, orderBy: { createdAt: "desc" }, take: 1, include: { shares: { take: 1 } } } } } },
  });
  const company = lead?.company ?? null;
  const audit = company?.audits[0] ?? null;
  const flags = Array.isArray(audit?.flags) ? (audit!.flags as string[]) : [];
  const shareSlug = audit?.shares[0]?.slug ?? null;
  // The booking host is per workspace, never a hardcoded slug.
  const bookingPage = await db.bookingPage.findFirst({
    where: { active: true },
    select: { slug: true },
    orderBy: { createdAt: "asc" },
  });
  return {
    company: company?.name ?? "",
    city: company?.city ?? "",
    audit_score: audit ? String(audit.score) : "",
    audit_finding: flags[0] ?? "",
    audit_link: shareSlug ? auditShareLink(shareSlug) : "",
    booking_link: bookingPage ? bookingLink(bookingPage.slug) : "",
    scoreBand: audit ? scoreBand(audit.score) : "",
  };
}
