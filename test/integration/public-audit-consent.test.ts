import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prismaUnsafe, getWorkspaceClient } from "@/lib/db";
import { previewSegment } from "@/modules/campaigns/segment";

/**
 * P12/1b, 1c — what a missing marketing consent actually prevents.
 *
 * The promise on the public page is that someone who asks for their report and
 * does NOT tick the marketing box gets the report and nothing else. That
 * promise is only worth anything if the campaign audience enforces it, which
 * is what this test exists to prove — against the real query, not a mock.
 */
const RUN = Math.random().toString(36).slice(2, 8);
let workspaceId = "";
const created: { companies: string[]; leads: string[]; consents: string[] } = {
  companies: [],
  leads: [],
  consents: [],
};

async function seedLead(opts: {
  domain: string;
  email: string;
  consent: null | { marketing: boolean };
}): Promise<string> {
  const db = getWorkspaceClient(workspaceId);
  const company = await db.company.create({
    data: { workspaceId, name: opts.domain, domain: opts.domain, website: `https://${opts.domain}` },
    select: { id: true },
  });
  created.companies.push(company.id);

  const lead = await db.lead.create({
    data: {
      workspaceId,
      companyId: company.id,
      source: opts.consent ? "SELF_SERVE_AUDIT" : "PROSPECTOR",
      stage: "RESEARCHED",
      email: opts.email,
      icpScore: 5,
    },
    select: { id: true },
  });
  created.leads.push(lead.id);

  if (opts.consent) {
    const publicAudit = await prismaUnsafe.publicAudit.create({
      data: {
        workspaceId,
        url: `https://${opts.domain}`,
        domain: opts.domain,
        status: "done",
      },
      select: { id: true },
    });
    const consent = await prismaUnsafe.publicAuditConsent.create({
      data: {
        workspaceId,
        publicAuditId: publicAudit.id,
        name: "Teszt Elek",
        email: opts.email,
        serviceConsent: true,
        marketingConsent: opts.consent.marketing,
        consentTextVersion: "hu-test",
        leadId: lead.id,
      },
      select: { id: true },
    });
    created.consents.push(consent.id);
  }
  return lead.id;
}

beforeAll(async () => {
  const ws = await prismaUnsafe.workspace.findFirst({
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  workspaceId = ws!.id;
});

afterAll(async () => {
  await prismaUnsafe.publicAuditConsent.deleteMany({ where: { id: { in: created.consents } } });
  await prismaUnsafe.publicAudit.deleteMany({ where: { domain: { contains: RUN } } });
  await prismaUnsafe.lead.deleteMany({ where: { id: { in: created.leads } } });
  await prismaUnsafe.company.deleteMany({ where: { id: { in: created.companies } } });
  await prismaUnsafe.$disconnect();
});

describe("campaign audiences and self-serve consent", () => {
  it("excludes an inbound lead that never gave marketing consent", async () => {
    const leadId = await seedLead({
      domain: `no-consent-${RUN}.hu`,
      email: `no-consent-${RUN}@example.hu`,
      consent: { marketing: false },
    });

    const db = getWorkspaceClient(workspaceId);
    const { recipients } = await previewSegment(db, {});
    expect(recipients.map((r) => r.leadId)).not.toContain(leadId);
  });

  it("includes an inbound lead that did give marketing consent", async () => {
    const leadId = await seedLead({
      domain: `consented-${RUN}.hu`,
      email: `consented-${RUN}@example.hu`,
      consent: { marketing: true },
    });

    const db = getWorkspaceClient(workspaceId);
    const { recipients } = await previewSegment(db, {});
    expect(recipients.map((r) => r.leadId)).toContain(leadId);
  });

  it("leaves a lead we sourced ourselves alone", async () => {
    // This filter narrows INBOUND. A prospect we found has no consent record
    // at all, and must not be swept up by a rule about people who came to us.
    const leadId = await seedLead({
      domain: `outbound-${RUN}.hu`,
      email: `outbound-${RUN}@example.hu`,
      consent: null,
    });

    const db = getWorkspaceClient(workspaceId);
    const { recipients } = await previewSegment(db, {});
    expect(recipients.map((r) => r.leadId)).toContain(leadId);
  });

  it("keeps the count and the recipient list in agreement", async () => {
    // The count is what the operator sees before arming a campaign; if the
    // filter applied to one and not the other, the preview would lie.
    const db = getWorkspaceClient(workspaceId);
    const { count, recipients } = await previewSegment(db, {});
    expect(count).toBe(recipients.length);
  });
});

describe("the consent record itself", () => {
  it("stores the wording version, not just a boolean", async () => {
    const email = `evidence-${RUN}@example.hu`;
    await seedLead({ domain: `evidence-${RUN}.hu`, email, consent: { marketing: true } });

    const row = await prismaUnsafe.publicAuditConsent.findFirst({ where: { email } });
    expect(row).not.toBeNull();
    // "Did they consent" is the easy question. "To what, exactly" is the one
    // that gets asked, and a boolean cannot answer it.
    expect(row!.consentTextVersion).toBeTruthy();
    expect(row!.serviceConsent).toBe(true);
  });

  it("defaults marketing consent to false", async () => {
    const publicAudit = await prismaUnsafe.publicAudit.create({
      data: {
        workspaceId,
        url: `https://default-${RUN}.hu`,
        domain: `default-${RUN}.hu`,
        status: "done",
      },
      select: { id: true },
    });
    const row = await prismaUnsafe.publicAuditConsent.create({
      data: {
        workspaceId,
        publicAuditId: publicAudit.id,
        name: "Teszt",
        email: `default-${RUN}@example.hu`,
        consentTextVersion: "hu-test",
      },
    });
    created.consents.push(row.id);
    // A pre-ticked box is not consent, and neither is a column that defaults
    // to true.
    expect(row.marketingConsent).toBe(false);
  });
});
