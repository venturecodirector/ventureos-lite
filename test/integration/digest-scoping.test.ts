import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getWorkspaceClient, prismaUnsafe } from "../../src/lib/db";
import { collectDigestData } from "../../src/modules/analytics/digest-data";

/**
 * Monday digest MUST reflect only its own workspace's data (spec §4.22 / AC 19).
 * Two workspaces are seeded with identical shapes; a digest collected through
 * workspace A's guarded client must never count workspace B's rows.
 */
const NAMES = ["Digest Alpha", "Digest Bravo"];
let wsA = "";
let wsB = "";

async function clean() {
  const stale = await prismaUnsafe.workspace.findMany({ where: { name: { in: NAMES } }, select: { id: true } });
  const ids = stale.map((w) => w.id);
  if (ids.length) {
    await prismaUnsafe.call.deleteMany({ where: { workspaceId: { in: ids } } });
    await prismaUnsafe.proposal.deleteMany({ where: { workspaceId: { in: ids } } });
    await prismaUnsafe.lead.deleteMany({ where: { workspaceId: { in: ids } } });
    await prismaUnsafe.company.deleteMany({ where: { workspaceId: { in: ids } } });
    await prismaUnsafe.workspace.deleteMany({ where: { id: { in: ids } } });
  }
}

async function seed(wsId: string, calls: number, proposals: number, researched: number) {
  const company = await prismaUnsafe.company.create({ data: { workspaceId: wsId, name: `Co ${wsId}` } });
  for (let i = 0; i < researched; i++) {
    const lead = await prismaUnsafe.lead.create({
      data: { workspaceId: wsId, companyId: company.id, stage: "RESEARCHED", contactName: `L${i}` },
    });
    if (i < calls) {
      await prismaUnsafe.call.create({
        data: {
          workspaceId: wsId,
          leadId: lead.id,
          outcome: "CALLBACK_REQUESTED",
          callbackAt: new Date(Date.now() - 3_600_000), // overdue
        },
      });
    }
  }
  for (let i = 0; i < proposals; i++) {
    await prismaUnsafe.proposal.create({
      data: { workspaceId: wsId, kind: "SCORE_WEIGHT", title: `P${wsId}-${i}`, evidence: "x", n: 30, data: {} },
    });
  }
}

beforeAll(async () => {
  await clean();
  wsA = (await prismaUnsafe.workspace.create({ data: { name: NAMES[0] } })).id;
  wsB = (await prismaUnsafe.workspace.create({ data: { name: NAMES[1] } })).id;
  // A: 2 due callbacks, 1 pending proposal, 3 researched leads
  await seed(wsA, 2, 1, 3);
  // B: 5 due callbacks, 4 pending proposals, 6 researched leads
  await seed(wsB, 5, 4, 6);
});

afterAll(async () => {
  await clean();
  await prismaUnsafe.$disconnect();
});

describe("Monday digest respects workspace scoping", () => {
  it("counts only workspace A's data for an A digest", async () => {
    const digest = await collectDigestData(getWorkspaceClient(wsA), { isOwner: true, nowMs: Date.now() });
    expect(digest.dueCallbacks).toBe(2);
    expect(digest.pendingApprovals).toBe(1);
    // todayQueue = dueCallbacks(2) + overdueFollowups(0) + researched(3)
    expect(digest.todayQueueCount).toBe(5);
  });

  it("counts only workspace B's data for a B digest — no bleed from A", async () => {
    const digest = await collectDigestData(getWorkspaceClient(wsB), { isOwner: true, nowMs: Date.now() });
    expect(digest.dueCallbacks).toBe(5);
    expect(digest.pendingApprovals).toBe(4);
    expect(digest.todayQueueCount).toBe(11);
  });

  it("hides pending approvals from non-owners", async () => {
    const digest = await collectDigestData(getWorkspaceClient(wsA), { isOwner: false, nowMs: Date.now() });
    expect(digest.pendingApprovals).toBe(0);
  });
});
