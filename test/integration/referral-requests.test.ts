import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prismaUnsafe, getWorkspaceClient } from "../../src/lib/db";
import { processReferralSweep } from "../../src/modules/referrals/jobs";

/**
 * The playbook's VERIFICATION line for P13/3, executed:
 *
 *   "a certificate acknowledged 14 days ago (fixture) produces the referral
 *    draft task, and the cooldown blocks a second one"
 */
const NAMES = ["Referral Alpha"];
let ws = "";

async function clean() {
  const stale = await prismaUnsafe.workspace.findMany({
    where: { name: { in: NAMES } },
    select: { id: true },
  });
  const ids = stale.map((w) => w.id);
  if (!ids.length) return;
  for (const t of ["referralRequest", "message", "task", "document", "lead", "company"] as const) {
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
  for (const t of ["referralRequest", "message", "task", "document", "lead", "company"] as const) {
    // @ts-expect-error dynamic model access
    await prismaUnsafe[t].deleteMany({ where: { workspaceId: ws } });
  }
});

const day = 86_400_000;

async function acknowledgedCertificate(daysAgo: number, companyName = "Példa Kft.") {
  const db = getWorkspaceClient(ws);
  const company = await db.company.create({
    data: { workspaceId: ws, name: companyName, industry: "Fogászat" },
  });
  const lead = await db.lead.create({
    data: { workspaceId: ws, companyId: company.id, contactName: "Kovács Anna" },
  });
  const doc = await db.document.create({
    data: {
      workspaceId: ws,
      leadId: lead.id,
      type: "CERTIFICATE",
      status: "ACKNOWLEDGED",
      acknowledgedAt: new Date(Date.now() - daysAgo * day),
      payload: { scope: "Weboldal újraépítése" },
    },
  });
  return { company, lead, doc };
}

describe("the referral sweep", () => {
  it("drafts an ask fourteen days after the client confirmed the work", async () => {
    const { lead } = await acknowledgedCertificate(15);
    expect(await processReferralSweep()).toBe(1);

    const db = getWorkspaceClient(ws);
    const request = await db.referralRequest.findFirst();
    expect(request!.status).toBe("drafted");

    // A DRAFT, never a sent message.
    const message = await db.message.findUnique({ where: { id: request!.messageId! } });
    expect(message!.status).toBe("DRAFT");
    expect(message!.sentAt).toBeNull();
    expect(message!.body).toContain("Weboldal újraépítése");
    // Template text, not Claude — so the human-edit guardrail does not apply.
    expect(message!.aiDrafted).toBe(false);

    const task = await db.task.findUnique({ where: { id: request!.taskId! } });
    expect(task!.entityId).toBe(lead.id);
    expect(task!.doneAt).toBeNull();
  });

  it("stays quiet before the fourteen days are up", async () => {
    await acknowledgedCertificate(10);
    expect(await processReferralSweep()).toBe(0);
    expect(await prismaUnsafe.referralRequest.count({ where: { workspaceId: ws } })).toBe(0);
  });

  it("does not ask twice for the same certificate, however often it runs", async () => {
    await acknowledgedCertificate(20);
    expect(await processReferralSweep()).toBe(1);
    expect(await processReferralSweep()).toBe(0);
    expect(await processReferralSweep()).toBe(0);
    expect(await prismaUnsafe.referralRequest.count({ where: { workspaceId: ws } })).toBe(1);
  });

  /**
   * The cooldown. A client who buys twice in a quarter is one relationship, and
   * asking them for introductions every time is how a good relationship starts
   * feeling transactional.
   */
  it("blocks a second ask to the same client inside six months", async () => {
    const first = await acknowledgedCertificate(30);
    expect(await processReferralSweep()).toBe(1);

    // A second delivered job for the SAME company, also ripe.
    const db = getWorkspaceClient(ws);
    await db.document.create({
      data: {
        workspaceId: ws,
        leadId: first.lead.id,
        type: "CERTIFICATE",
        status: "ACKNOWLEDGED",
        acknowledgedAt: new Date(Date.now() - 15 * day),
        payload: { scope: "Második projekt" },
      },
    });

    expect(await processReferralSweep()).toBe(0);
    expect(await prismaUnsafe.referralRequest.count({ where: { workspaceId: ws } })).toBe(1);
  });

  it("asks a DIFFERENT client in the same period", async () => {
    await acknowledgedCertificate(20, "Első Kft.");
    await acknowledgedCertificate(20, "Második Kft.");
    expect(await processReferralSweep()).toBe(2);
  });

  it("ignores a certificate that was never acknowledged", async () => {
    const db = getWorkspaceClient(ws);
    const lead = await db.lead.create({ data: { workspaceId: ws, contactName: "Senki" } });
    await db.document.create({
      data: { workspaceId: ws, leadId: lead.id, type: "CERTIFICATE", status: "SENT", payload: {} },
    });
    expect(await processReferralSweep()).toBe(0);
  });

  it("stays off in a workspace that switched it off", async () => {
    await acknowledgedCertificate(20);
    await prismaUnsafe.workspace.update({
      where: { id: ws },
      data: { featureFlags: { referralRequests: { enabled: false } } },
    });
    expect(await processReferralSweep()).toBe(0);
    await prismaUnsafe.workspace.update({ where: { id: ws }, data: { featureFlags: {} } });
  });
});
