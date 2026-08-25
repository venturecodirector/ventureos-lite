import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prismaUnsafe, getWorkspaceClient } from "../../src/lib/db";
import {
  applyPlans,
  backfillState,
  isBackfillOperator,
  loadCandidates,
  previewLocal,
} from "../../src/modules/prospector/backfill-store";

/**
 * The backfill against the real database (P4/1e).
 *
 * The matching and the diff arithmetic are unit-tested. What has to be proved
 * here is what a write can REACH: that the candidate set is the prospected one
 * and nothing else, that a company id from another workspace does nothing at
 * all, that only the whitelisted columns move, and that the run leaves an audit
 * entry — because this is a bulk rewrite of a CRM, and "it looked right in the
 * preview" is not evidence.
 */
const NAMES = ["Backfill Alpha", "Backfill Bravo"];
let wsA = "";
let wsB = "";
let ownerId = "";
let bdrId = "";

async function clean() {
  const stale = await prismaUnsafe.workspace.findMany({
    where: { name: { in: NAMES } },
    select: { id: true },
  });
  const ids = stale.map((w) => w.id);
  if (ids.length) {
    for (const t of ["activity", "auditLog", "lead", "company", "membership"] as const) {
      // @ts-expect-error dynamic model access
      await prismaUnsafe[t].deleteMany({ where: { workspaceId: { in: ids } } });
    }
    await prismaUnsafe.workspace.deleteMany({ where: { id: { in: ids } } });
  }
  await prismaUnsafe.user.deleteMany({
    where: { email: { in: ["backfill-owner@test.local", "backfill-bdr@test.local"] } },
  });
}

beforeAll(async () => {
  await clean();
  wsA = (await prismaUnsafe.workspace.create({ data: { name: NAMES[0]! } })).id;
  wsB = (await prismaUnsafe.workspace.create({ data: { name: NAMES[1]! } })).id;
  ownerId = (
    await prismaUnsafe.user.create({
      data: { email: "backfill-owner@test.local", name: "Owner", passwordHash: "x" },
    })
  ).id;
  bdrId = (
    await prismaUnsafe.user.create({
      data: { email: "backfill-bdr@test.local", name: "Bdr", passwordHash: "x" },
    })
  ).id;
  await prismaUnsafe.membership.create({
    data: { userId: ownerId, workspaceId: wsA, role: "OWNER", grants: [] },
  });
  await prismaUnsafe.membership.create({
    data: { userId: bdrId, workspaceId: wsA, role: "BDR", grants: [] },
  });
});

afterAll(clean);

beforeEach(async () => {
  for (const t of ["activity", "auditLog", "lead", "company"] as const) {
    // @ts-expect-error dynamic model access
    await prismaUnsafe[t].deleteMany({ where: { workspaceId: { in: [wsA, wsB] } } });
  }
});

/** A company exactly as the Prospector left it before the fixes. */
async function prospected(
  workspaceId: string,
  over: Partial<{ name: string; address: string; industry: string; phone: string }> = {},
) {
  const company = await prismaUnsafe.company.create({
    data: {
      workspaceId,
      name: over.name ?? "Nosztalgia ékszerbolt",
      address: over.address ?? "Budapest, Erzsébet krt. 15, 1073 Hungary",
      industry: over.industry ?? "Jewelry Store",
      phone: over.phone ?? "06 1 322 1234",
    },
  });
  const lead = await prismaUnsafe.lead.create({
    data: { workspaceId, companyId: company.id, source: "PROSPECTOR", stage: "RESEARCHED" },
  });
  return { company, lead };
}

describe("which companies the backfill is about", () => {
  it("takes the prospected ones and leaves the hand-made ones alone", async () => {
    const { company } = await prospected(wsA);
    const byHand = await prismaUnsafe.company.create({
      data: { workspaceId: wsA, name: "Kézzel felvitt Kft", address: "Szeged, Kárász u. 9" },
    });
    const manualLead = await prismaUnsafe.company.create({
      data: { workspaceId: wsA, name: "LinkedIn-ről", address: "Győr, Baross u. 1" },
    });
    await prismaUnsafe.lead.create({
      data: { workspaceId: wsA, companyId: manualLead.id, source: "LINKEDIN", stage: "RESEARCHED" },
    });

    const ids = (await loadCandidates(wsA)).map((c) => c.id);
    expect(ids).toEqual([company.id]);
    expect(ids).not.toContain(byHand.id);
    expect(ids).not.toContain(manualLead.id);
  });

  it("counts what is missing, so the panel does not have to guess", async () => {
    await prospected(wsA);
    await prospected(wsA, { name: "Pék Bt", industry: "Bakery", address: "Debrecen, Piac u. 20" });
    const state = await backfillState(wsA);
    expect(state.total).toBe(2);
    expect(state.missingCity).toBe(2);
    expect(state.missingEmail).toBe(2);
    expect(state.missingPlaceId).toBe(2);
    expect(state.englishIndustry).toBe(2);
  });

  it("does not see another workspace's prospects", async () => {
    await prospected(wsA);
    await prospected(wsB, { name: "Idegen Kft" });
    const rows = await loadCandidates(wsA);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("Nosztalgia ékszerbolt");
  });
});

describe("applying", () => {
  it("writes the ticked fields onto the company and the lead", async () => {
    const { company, lead } = await prospected(wsA);
    const preview = await previewLocal(wsA);
    const plan = preview.plans.find((p) => p.companyId === company.id)!;

    const result = await applyPlans(wsA, ownerId, [
      { companyId: company.id, changes: plan.changes.map((c) => ({ field: c.field, to: c.to })) },
    ]);
    expect(result.companies).toBe(1);

    const after = await prismaUnsafe.company.findUnique({ where: { id: company.id } });
    const leadAfter = await prismaUnsafe.lead.findUnique({ where: { id: lead.id } });
    expect(after!.city).toBe("Budapest");
    expect(after!.industry).toBe("Ékszerbolt");
    // Google's spelling in, canonical out — on both rows.
    expect(after!.phone).toBe("+3613221234");
    expect(leadAfter!.phone).toBe("+3613221234");
  });

  it("writes ONLY what was ticked", async () => {
    const { company } = await prospected(wsA);
    await applyPlans(wsA, ownerId, [
      { companyId: company.id, changes: [{ field: "city", to: "Budapest" }] },
    ]);
    const after = await prismaUnsafe.company.findUnique({ where: { id: company.id } });
    expect(after!.city).toBe("Budapest");
    // Untouched: the industry was proposed in the same plan and left unticked.
    expect(after!.industry).toBe("Jewelry Store");
    expect(after!.phone).toBe("06 1 322 1234");
  });

  /**
   * THE ISOLATION RULE. The row list travels through the client, so a company id
   * from another workspace is a thing that can be posted. It must do nothing —
   * not throw, not write.
   */
  it("ignores a company id belonging to another workspace", async () => {
    const mine = await prospected(wsA);
    const theirs = await prospected(wsB, { name: "Idegen Kft", industry: "Bakery" });

    const result = await applyPlans(wsA, ownerId, [
      { companyId: theirs.company.id, changes: [{ field: "name", to: "Eltérített Kft" }] },
      { companyId: mine.company.id, changes: [{ field: "city", to: "Budapest" }] },
    ]);

    expect(result.companies).toBe(1);
    const untouched = await prismaUnsafe.company.findUnique({ where: { id: theirs.company.id } });
    expect(untouched!.name).toBe("Idegen Kft");
  });

  it("records the run in the audit log, per hard rule 8", async () => {
    const { company } = await prospected(wsA);
    await applyPlans(wsA, ownerId, [
      { companyId: company.id, changes: [{ field: "city", to: "Budapest" }] },
    ]);
    const entries = await getWorkspaceClient(wsA).auditLog.findMany({
      where: { action: "prospector.backfill" },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.actorUserId).toBe(ownerId);
    expect((entries[0]!.meta as { companies: number }).companies).toBe(1);
  });

  it("writes nothing, and logs nothing, when every row is unknown", async () => {
    const theirs = await prospected(wsB, { name: "Idegen Kft" });
    const result = await applyPlans(wsA, ownerId, [
      { companyId: theirs.company.id, changes: [{ field: "city", to: "Budapest" }] },
    ]);
    expect(result.companies).toBe(0);
    const entries = await getWorkspaceClient(wsA).auditLog.findMany();
    expect(entries).toHaveLength(0);
  });
});

describe("who may run it", () => {
  /** Ordinary prospecting work — the BDR's job before it is anybody else's. */
  it("admits every seated member", async () => {
    expect(await isBackfillOperator(wsA, ownerId)).toBe(true);
    expect(await isBackfillOperator(wsA, bdrId)).toBe(true);
  });

  it("refuses somebody with no membership at all", async () => {
    expect(await isBackfillOperator(wsB, ownerId)).toBe(false);
    expect(await isBackfillOperator(wsB, bdrId)).toBe(false);
  });
});
