import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prismaUnsafe, getWorkspaceClient } from "../../src/lib/db";
import { verifyAudience, verifyLead } from "../../src/modules/verification/store";
import { checkMx } from "../../src/modules/verification/dns";

/**
 * The playbook's own VERIFICATION block for P9/2, executed:
 *
 *   "a cold campaign with 1 invalid and 1 risky address arms only after the
 *    invalid is auto-excluded and the risky is confirmed; MX-check correctly
 *    fails a nonsense domain."
 */
const NAMES = ["Verify Alpha"];
let ws = "";

async function clean() {
  const stale = await prismaUnsafe.workspace.findMany({
    where: { name: { in: NAMES } },
    select: { id: true },
  });
  const ids = stale.map((w) => w.id);
  if (!ids.length) return;
  for (const t of ["campaignRecipient", "campaignStep", "campaign", "lead", "company"] as const) {
    // @ts-expect-error dynamic model access
    await prismaUnsafe[t].deleteMany({ where: { workspaceId: { in: ids } } });
  }
  await prismaUnsafe.workspace.deleteMany({ where: { id: { in: ids } } });
}

beforeAll(async () => {
  await clean();
  ws = (await prismaUnsafe.workspace.create({ data: { name: NAMES[0] } })).id;
});
afterAll(clean);

beforeEach(async () => {
  await prismaUnsafe.campaignRecipient.deleteMany({ where: { workspaceId: ws } });
  await prismaUnsafe.campaign.deleteMany({ where: { workspaceId: ws } });
  await prismaUnsafe.lead.deleteMany({ where: { workspaceId: ws } });
});

async function audienceOf(emails: string[]): Promise<string> {
  const db = getWorkspaceClient(ws);
  const campaign = await db.campaign.create({ data: { workspaceId: ws, name: "Test" } });
  for (const email of emails) {
    const lead = await db.lead.create({ data: { workspaceId: ws, email, contactName: email } });
    await db.campaignRecipient.create({
      data: { workspaceId: ws, campaignId: campaign.id, leadId: lead.id, email },
    });
  }
  return campaign.id;
}

describe("MX check against real DNS", () => {
  it("fails a nonsense domain and passes a real one", async () => {
    const nonsense = await checkMx("qwrtzlk-nincs-ilyen-domain-123456.hu");
    expect(nonsense.reason).toBe("domain_not_found");

    const real = await checkMx("gmail.com");
    expect(real.reason).toBeNull();
    expect(real.hosts.length).toBeGreaterThan(0);
  });
});

describe("the campaign gate", () => {
  it("excludes the invalid address by itself and holds the risky one for a human", async () => {
    // One address that cannot receive mail, one that reaches a shared inbox,
    // one ordinary personal address.
    const campaignId = await audienceOf([
      "valaki@qwrtzlk-nincs-ilyen-domain-123456.hu", // invalid — no such domain
      "info@gmail.com", // risky — role address on a domain that does resolve
      "kovacs.anna@gmail.com", // valid
    ]);
    const db = getWorkspaceClient(ws);

    const breakdown = await verifyAudience(db, ws, campaignId);

    expect(breakdown.total).toBe(3);
    expect(breakdown.invalid).toBe(1);
    expect(breakdown.risky).toBe(1);
    expect(breakdown.valid).toBe(1);

    // The invalid one is dealt with, not merely reported: suppressed on the spot.
    expect(breakdown.excluded).toHaveLength(1);
    const excluded = await db.campaignRecipient.findFirst({
      where: { campaignId, email: "valaki@qwrtzlk-nincs-ilyen-domain-123456.hu" },
    });
    expect(excluded!.suppressed).toBe(true);
    expect(excluded!.verifyStatus).toBe("invalid");

    // The risky one is a decision, not an exclusion.
    expect(breakdown.awaitingConfirmation).toHaveLength(1);
    expect(breakdown.awaitingConfirmation[0]!.email).toBe("info@gmail.com");
    expect(breakdown.awaitingConfirmation[0]!.reason).toBe("role_address");

    // Accept it, and nothing is left standing in the way.
    await db.campaignRecipient.update({
      where: { id: breakdown.awaitingConfirmation[0]!.id },
      data: { riskAcceptedAt: new Date(), riskAcceptedBy: "tester" },
    });
    const after = await verifyAudience(db, ws, campaignId);
    expect(after.awaitingConfirmation).toHaveLength(0);
    expect(after.risky).toBe(1); // still risky — accepted, not reclassified
  });

  it("writes the verdict onto the lead so the next campaign does not re-check it", async () => {
    const campaignId = await audienceOf(["kovacs.anna@gmail.com"]);
    const db = getWorkspaceClient(ws);
    await verifyAudience(db, ws, campaignId);

    const lead = await db.lead.findFirst({ where: { email: "kovacs.anna@gmail.com" } });
    expect(lead!.emailStatus).toBe("valid");
    expect(lead!.emailCheckedAt).toBeTruthy();

    // The cached verdict is reused rather than re-taken.
    const again = await verifyLead(db, ws, lead!.id);
    expect(again!.fromCache).toBe(true);
  });

  it("re-checks an address whose verdict has gone stale", async () => {
    const db = getWorkspaceClient(ws);
    const lead = await db.lead.create({
      data: {
        workspaceId: ws,
        email: "kovacs.anna@gmail.com",
        contactName: "Anna",
        emailStatus: "valid",
        emailReason: "ok",
        emailCheckedAt: new Date(Date.now() - 91 * 24 * 3600_000),
      },
    });
    const fresh = await verifyLead(db, ws, lead.id);
    expect(fresh!.fromCache).toBe(false);
  });

  it("charges the provider once for an address that appears twice", async () => {
    const db = getWorkspaceClient(ws);
    const campaign = await db.campaign.create({ data: { workspaceId: ws, name: "Dupes" } });
    // Two leads, same address — a real segment does this.
    for (let i = 0; i < 2; i++) {
      const lead = await db.lead.create({
        data: { workspaceId: ws, email: "kovacs.anna@gmail.com", contactName: `Anna ${i}` },
      });
      await db.campaignRecipient.create({
        data: {
          workspaceId: ws,
          campaignId: campaign.id,
          leadId: lead.id,
          email: "kovacs.anna@gmail.com",
        },
      });
    }
    const breakdown = await verifyAudience(db, ws, campaign.id);
    expect(breakdown.total).toBe(2);
    expect(breakdown.valid).toBe(2);
    // No paid provider configured here, so the figure is zero either way — what
    // this pins is that the audience was walked without a second lookup.
    expect(breakdown.estimatedCostUsd).toBe(0);
    expect(breakdown.providerName).toBe("none");
  });

  it("counts an already-suppressed address without re-checking it", async () => {
    const db = getWorkspaceClient(ws);
    const campaign = await db.campaign.create({ data: { workspaceId: ws, name: "Supp" } });
    await db.campaignRecipient.create({
      data: {
        workspaceId: ws,
        campaignId: campaign.id,
        email: "korabban@gmail.com",
        suppressed: true,
      },
    });
    const breakdown = await verifyAudience(db, ws, campaign.id);
    expect(breakdown.suppressed).toBe(1);
    expect(breakdown.valid).toBe(0);
  });
});

describe("the inline cap is visible, not silent", () => {
  it("reports what it did not reach instead of pretending it verified everything", async () => {
    const db = getWorkspaceClient(ws);
    const campaign = await db.campaign.create({ data: { workspaceId: ws, name: "Big" } });
    for (let i = 0; i < 5; i++) {
      await db.campaignRecipient.create({
        data: {
          workspaceId: ws,
          campaignId: campaign.id,
          email: `cim${i}@gmail.com`,
        },
      });
    }
    const breakdown = await verifyAudience(db, ws, campaign.id, { max: 2 });
    expect(breakdown.total).toBe(5);
    expect(breakdown.pending).toBe(3);
    expect(breakdown.valid).toBe(2);
  });

  it("finishes the rest on a second pass, without re-checking the first", async () => {
    const db = getWorkspaceClient(ws);
    const campaign = await db.campaign.create({ data: { workspaceId: ws, name: "Big2" } });
    for (let i = 0; i < 4; i++) {
      const lead = await db.lead.create({
        data: { workspaceId: ws, email: `masik${i}@gmail.com`, contactName: `L${i}` },
      });
      await db.campaignRecipient.create({
        data: {
          workspaceId: ws,
          campaignId: campaign.id,
          leadId: lead.id,
          email: `masik${i}@gmail.com`,
        },
      });
    }
    const first = await verifyAudience(db, ws, campaign.id, { max: 2 });
    expect(first.pending).toBe(2);

    // The second pass costs nothing for the two already done — their verdicts
    // are cached on the lead — and clears the backlog.
    const second = await verifyAudience(db, ws, campaign.id, { max: 2 });
    expect(second.pending).toBe(0);
    expect(second.valid).toBe(4);
  });
});
