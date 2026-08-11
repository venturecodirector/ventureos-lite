// Force the mock mail provider before anything imports the provider factory,
// so the send path is deterministic regardless of local .env.
process.env.MAIL_PROVIDER = "mock";

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { getWorkspaceClient, prismaUnsafe } from "../../src/lib/db";
import {
  runCampaignSend,
  suppressAddress,
  evaluateCircuitBreaker,
  ColdGateError,
} from "../../src/modules/campaigns/send";

/**
 * Cold Email behavioral guarantees (spec §4.16):
 *   - the compliance gate blocks every send path without a sign-off record;
 *   - unsubscribe suppresses an address across ALL campaigns instantly;
 *   - the bounce circuit breaker auto-pauses a campaign.
 */
const WS_NAME = "Cold Email Test";
let wsId = "";

const SIGNOFF_FLAGS = {
  coldEmail: {
    coldDomain: "cold.test",
    signoff: { approvedBy: "Dr. Kiss", date: "2026-08-01", scopeNote: "B2B legitimate interest" },
  },
};

async function clean() {
  const stale = await prismaUnsafe.workspace.findMany({ where: { name: WS_NAME }, select: { id: true } });
  const ids = stale.map((w) => w.id);
  if (!ids.length) return;
  for (const t of ["campaignRecipient", "campaignStep", "campaign", "emailLog", "suppression", "message", "lead", "company"] as const) {
    // @ts-expect-error dynamic model access
    await prismaUnsafe[t].deleteMany({ where: { workspaceId: { in: ids } } });
  }
  await prismaUnsafe.workspace.deleteMany({ where: { id: { in: ids } } });
}

async function makeCampaign(status: "ACTIVE" | "DRAFT" = "ACTIVE") {
  const c = await prismaUnsafe.campaign.create({
    data: { workspaceId: wsId, name: "C", status, dailyCap: 100, startedAt: new Date() },
  });
  await prismaUnsafe.campaignStep.create({
    data: { workspaceId: wsId, campaignId: c.id, stepNumber: 1, subject: "Szia {{company}}", body: "Audit: {{audit_link}}" },
  });
  return c.id;
}

beforeEach(async () => {
  await clean();
  wsId = (await prismaUnsafe.workspace.create({ data: { name: WS_NAME } })).id;
});

afterAll(async () => {
  await clean();
  await prismaUnsafe.$disconnect();
});

describe("compliance gate blocks sending without a sign-off record", () => {
  it("throws ColdGateError and sends nothing when there is no sign-off", async () => {
    const db = getWorkspaceClient(wsId);
    const campaignId = await makeCampaign("ACTIVE");
    const company = await prismaUnsafe.company.create({ data: { workspaceId: wsId, name: "Co" } });
    const lead = await prismaUnsafe.lead.create({ data: { workspaceId: wsId, companyId: company.id, email: "x@x.hu" } });
    await prismaUnsafe.campaignRecipient.create({ data: { workspaceId: wsId, campaignId, leadId: lead.id, email: "x@x.hu" } });

    await expect(
      runCampaignSend(db, campaignId, { workspaceId: wsId, featureFlags: {}, mailgunConfig: null, appUrl: "http://t", nowMs: Date.now() }),
    ).rejects.toBeInstanceOf(ColdGateError);

    expect(await prismaUnsafe.emailLog.count({ where: { workspaceId: wsId } })).toBe(0);
    expect(await prismaUnsafe.campaignRecipient.count({ where: { workspaceId: wsId, sentAt: { not: null } } })).toBe(0);
  });

  it("sends once sign-off is recorded", async () => {
    const db = getWorkspaceClient(wsId);
    const campaignId = await makeCampaign("ACTIVE");
    const company = await prismaUnsafe.company.create({ data: { workspaceId: wsId, name: "Co" } });
    const lead = await prismaUnsafe.lead.create({ data: { workspaceId: wsId, companyId: company.id, email: "x@x.hu" } });
    await prismaUnsafe.campaignRecipient.create({ data: { workspaceId: wsId, campaignId, leadId: lead.id, email: "x@x.hu" } });

    const res = await runCampaignSend(db, campaignId, { workspaceId: wsId, featureFlags: SIGNOFF_FLAGS, mailgunConfig: null, appUrl: "http://t", nowMs: Date.now() });
    expect(res.sent).toBe(1);
    expect(await prismaUnsafe.emailLog.count({ where: { workspaceId: wsId } })).toBe(1);
  });
});

describe("shared suppression — unsubscribe suppresses across all campaigns instantly", () => {
  it("flips the same address in every campaign + records the suppression", async () => {
    const db = getWorkspaceClient(wsId);
    const c1 = await makeCampaign("ACTIVE");
    const c2 = await makeCampaign("ACTIVE");
    await prismaUnsafe.campaignRecipient.create({ data: { workspaceId: wsId, campaignId: c1, email: "dup@x.hu" } });
    await prismaUnsafe.campaignRecipient.create({ data: { workspaceId: wsId, campaignId: c2, email: "dup@x.hu" } });
    await prismaUnsafe.campaignRecipient.create({ data: { workspaceId: wsId, campaignId: c1, email: "keep@x.hu" } });

    const count = await suppressAddress(db, wsId, "dup@x.hu", "unsubscribe");
    expect(count).toBe(2); // both campaigns' recipients flipped at once

    expect(await prismaUnsafe.campaignRecipient.count({ where: { email: "dup@x.hu", suppressed: true } })).toBe(2);
    expect(await prismaUnsafe.campaignRecipient.count({ where: { email: "keep@x.hu", suppressed: true } })).toBe(0);
    expect(await prismaUnsafe.suppression.count({ where: { workspaceId: wsId, address: "dup@x.hu" } })).toBe(1);
  });
});

describe("bounce circuit breaker auto-pauses a campaign", () => {
  it("pauses when the bounce rate crosses the threshold", async () => {
    const db = getWorkspaceClient(wsId);
    const campaignId = await makeCampaign("ACTIVE");
    // 100 sent, 6 bounced → 6% > 5% threshold, above the min sample.
    await prismaUnsafe.campaignRecipient.createMany({
      data: Array.from({ length: 100 }, (_, i) => ({
        workspaceId: wsId,
        campaignId,
        email: `r${i}@x.hu`,
        sentAt: new Date(),
        bounced: i < 6,
      })),
    });

    const res = await evaluateCircuitBreaker(db, campaignId);
    expect(res.tripped).toBe(true);
    expect((await prismaUnsafe.campaign.findUnique({ where: { id: campaignId } }))?.status).toBe("PAUSED");
  });

  it("does not pause below threshold", async () => {
    const db = getWorkspaceClient(wsId);
    const campaignId = await makeCampaign("ACTIVE");
    await prismaUnsafe.campaignRecipient.createMany({
      data: Array.from({ length: 100 }, (_, i) => ({ workspaceId: wsId, campaignId, email: `r${i}@x.hu`, sentAt: new Date(), bounced: i < 4 })),
    });
    const res = await evaluateCircuitBreaker(db, campaignId);
    expect(res.tripped).toBe(false);
    expect((await prismaUnsafe.campaign.findUnique({ where: { id: campaignId } }))?.status).toBe("ACTIVE");
  });
});
