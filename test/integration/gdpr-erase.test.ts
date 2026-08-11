import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getWorkspaceClient, prismaUnsafe } from "../../src/lib/db";
import { eraseLeadData } from "../../src/modules/gdpr/erase";
import { anonymizeLead } from "../../src/modules/gdpr/sweep";

/**
 * GDPR erasure + anonymization proofs (spec §10):
 *   - cascade completeness: after erasure, NO row anywhere references the lead.
 *   - anonymization idempotency: re-running scrubs person data without drift.
 */
const WS_NAME = "GDPR Erase Test";
let wsId = "";
let companyId = "";
let leadId = "";

async function clean() {
  const stale = await prismaUnsafe.workspace.findMany({ where: { name: WS_NAME }, select: { id: true } });
  const ids = stale.map((w) => w.id);
  if (!ids.length) return;
  for (const table of [
    "activity", "message", "call", "dealOutcome", "meeting", "emailLog",
    "auditShare", "campaignRecipient", "document", "auditResult", "campaign", "lead", "company",
  ] as const) {
    // @ts-expect-error dynamic model access
    await prismaUnsafe[table].deleteMany({ where: { workspaceId: { in: ids } } });
  }
  await prismaUnsafe.workspace.deleteMany({ where: { id: { in: ids } } });
}

async function seedLeadWithEverything() {
  const ws = await prismaUnsafe.workspace.create({ data: { name: WS_NAME } });
  wsId = ws.id;
  const company = await prismaUnsafe.company.create({ data: { workspaceId: wsId, name: "Erase Co Kft." } });
  companyId = company.id;
  const lead = await prismaUnsafe.lead.create({
    data: { workspaceId: wsId, companyId, contactName: "Márta", email: "m@x.hu", phone: "+3630", notes: "secret" },
  });
  leadId = lead.id;

  await prismaUnsafe.activity.create({ data: { workspaceId: wsId, leadId, type: "stage_change" } });
  await prismaUnsafe.message.create({ data: { workspaceId: wsId, leadId, direction: "OUTBOUND", body: "hello Márta" } });
  await prismaUnsafe.call.create({ data: { workspaceId: wsId, leadId, outcome: "INTERESTED", note: "keen" } });
  await prismaUnsafe.dealOutcome.create({ data: { workspaceId: wsId, leadId, result: "WON", value: 100 } });
  await prismaUnsafe.meeting.create({ data: { workspaceId: wsId, leadId, scheduledAt: new Date(), briefPdfPath: "briefs/none.pdf" } });
  await prismaUnsafe.emailLog.create({ data: { workspaceId: wsId, leadId, to: "m@x.hu", subject: "hi" } });
  const audit = await prismaUnsafe.auditResult.create({
    data: { workspaceId: wsId, companyId, url: "http://x", status: "done", expiresAt: new Date(Date.now() + 9e10) },
  });
  await prismaUnsafe.auditShare.create({
    data: { workspaceId: wsId, auditId: audit.id, leadId, slug: `s-${Date.now()}`, expiresAt: new Date(Date.now() + 9e10) },
  });
  const campaign = await prismaUnsafe.campaign.create({ data: { workspaceId: wsId, name: "C" } });
  await prismaUnsafe.campaignRecipient.create({ data: { workspaceId: wsId, campaignId: campaign.id, leadId, email: "m@x.hu" } });
  await prismaUnsafe.document.create({ data: { workspaceId: wsId, leadId, type: "QUOTE" } });
}

beforeEach(async () => {
  await clean();
});

afterAll(async () => {
  await clean();
  await prismaUnsafe.$disconnect();
});

describe("lead erasure — cascade completeness (no orphans)", () => {
  it("leaves zero rows referencing the erased lead", async () => {
    await seedLeadWithEverything();
    const db = getWorkspaceClient(wsId);

    const res = await eraseLeadData(db, leadId, { eraseDocuments: true });
    expect(res.deleted.lead).toBe(1);

    // No row in ANY lead_id-bearing table still references the erased lead.
    const orphanCounts = await Promise.all([
      prismaUnsafe.activity.count({ where: { leadId } }),
      prismaUnsafe.message.count({ where: { leadId } }),
      prismaUnsafe.call.count({ where: { leadId } }),
      prismaUnsafe.dealOutcome.count({ where: { leadId } }),
      prismaUnsafe.meeting.count({ where: { leadId } }),
      prismaUnsafe.emailLog.count({ where: { leadId } }),
      prismaUnsafe.auditShare.count({ where: { leadId } }),
      prismaUnsafe.campaignRecipient.count({ where: { leadId } }),
      prismaUnsafe.document.count({ where: { leadId } }),
    ]);
    expect(orphanCounts).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0]);

    // The lead itself is gone, and the company's audits went with its last lead.
    expect(await prismaUnsafe.lead.count({ where: { id: leadId } })).toBe(0);
    expect(await prismaUnsafe.auditResult.count({ where: { companyId } })).toBe(0);
  });

  it("retains legal documents (detached) when the policy keeps them", async () => {
    await seedLeadWithEverything();
    const db = getWorkspaceClient(wsId);
    await eraseLeadData(db, leadId, { eraseDocuments: false });
    // Document survives but no longer references the lead (no orphan).
    expect(await prismaUnsafe.document.count({ where: { workspaceId: wsId } })).toBe(1);
    expect(await prismaUnsafe.document.count({ where: { leadId } })).toBe(0);
  });
});

describe("anonymization idempotency", () => {
  it("scrubs person fields and re-running does not drift", async () => {
    await seedLeadWithEverything();
    const db = getWorkspaceClient(wsId);
    const NOW = Date.now();

    await anonymizeLead(db, leadId, NOW);
    const first = await prismaUnsafe.lead.findUnique({ where: { id: leadId } });
    expect(first?.email).toBeNull();
    expect(first?.phone).toBeNull();
    expect(first?.notes).toBeNull();
    expect(first?.contactName).toBe(`Anonymized-${leadId.slice(-6)}`);
    expect(first?.anonymizedAt).not.toBeNull();
    expect((await prismaUnsafe.message.findFirst({ where: { leadId } }))?.body).toBe("[anonymized]");

    // Re-run much later — must be a stable no-op.
    await anonymizeLead(db, leadId, NOW + 30 * 24 * 3600_000);
    const second = await prismaUnsafe.lead.findUnique({ where: { id: leadId } });
    expect(second?.contactName).toBe(first?.contactName);
    expect(second?.anonymizedAt?.getTime()).toBe(first?.anonymizedAt?.getTime());
  });
});
