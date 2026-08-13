/**
 * Building the match index from the live database (playbook-v2 P2b).
 *
 * This is the other half of the privacy boundary: `gmail-query.ts` decides the
 * SHAPE of a query, and this decides its CONTENTS. Everything here comes from
 * the CRM — lead addresses, company domains, hand-made links — so the set of
 * mail a sync can see is always derived from what the workspace already knows
 * about, and never wider.
 *
 * The mailbox owner's own addresses go in `self`, which excludes them from both
 * matching and the query scope. Without that, every thread matches "us" and the
 * query asks for the entire mailbox.
 */
import type { WorkspaceClient } from "@/lib/db";
import { domainOf, emptyIndex, isGenericDomain, normalizeAddress, type MatchIndex } from "./matching";

export async function buildMatchIndex(
  db: WorkspaceClient,
  selfAddresses: string[],
): Promise<MatchIndex> {
  const index = emptyIndex();
  for (const address of selfAddresses) index.self.add(normalizeAddress(address));

  const [leads, companies, links] = await Promise.all([
    db.lead.findMany({
      where: { email: { not: null } },
      select: { id: true, email: true, companyId: true },
    }),
    db.company.findMany({
      select: { id: true, domain: true, website: true, leads: { select: { id: true }, take: 1 } },
    }),
    db.addressLink.findMany({ select: { email: true, leadId: true, companyId: true } }),
  ]);

  for (const lead of leads) {
    const email = normalizeAddress(lead.email ?? "");
    if (!email.includes("@") || index.self.has(email)) continue;
    index.byAddress.set(email, { leadId: lead.id, companyId: lead.companyId });
  }

  for (const company of companies) {
    const domain = (company.domain ?? domainOf(`x@${company.website ?? ""}`)) ?? null;
    const normalized = domain ? domain.replace(/^www\./, "").toLowerCase() : null;
    // A free-mail domain would match every private conversation in the
    // mailbox, so it never enters the index.
    if (!normalized || !normalized.includes(".") || isGenericDomain(normalized)) continue;
    index.byDomain.set(normalized, {
      leadId: company.leads[0]?.id ?? null,
      companyId: company.id,
    });
  }

  // Last, so a hand-made link overwrites anything inferred for that address.
  for (const link of links) {
    const email = normalizeAddress(link.email);
    if (!email.includes("@") || index.self.has(email)) continue;
    index.learned.set(email, { leadId: link.leadId, companyId: link.companyId });
  }

  return index;
}
