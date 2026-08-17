import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";
import { prismaUnsafe, getWorkspaceClient } from "../../src/lib/db";
import { ensurePipelines } from "../../src/modules/deals/store";
import { createDealIn, moveStageIn } from "../../src/modules/deals/mutations";
import { commitThresholdFrom, loadForecast } from "../../src/modules/deals/forecast-data";
import { processStageProbabilityCalibration } from "../../src/modules/deals/jobs";

/**
 * The forecast and the quarterly recalibration (playbook-v2 P4/c).
 *
 * The hand-checked fixture: two deals in September at 20% and 75% of 1M and 2M
 * respectively is 1,700,000 weighted, 1,500,000 of it commit at the default
 * threshold of 70.
 */
const NAMES = ["Forecast Alpha", "Forecast Bravo"];
let wsA = "";
let wsB = "";

async function clean() {
  const stale = await prismaUnsafe.workspace.findMany({
    where: { name: { in: NAMES } },
    select: { id: true },
  });
  const ids = stale.map((w) => w.id);
  if (!ids.length) return;
  await prismaUnsafe.notification.deleteMany({ where: { workspaceId: { in: ids } } });
  await prismaUnsafe.proposal.deleteMany({ where: { workspaceId: { in: ids } } });
  await prismaUnsafe.activity.deleteMany({ where: { workspaceId: { in: ids } } });
  await prismaUnsafe.target.deleteMany({ where: { workspaceId: { in: ids } } });
  await prismaUnsafe.deal.deleteMany({ where: { workspaceId: { in: ids } } });
  await prismaUnsafe.dealStage.deleteMany({ where: { workspaceId: { in: ids } } });
  await prismaUnsafe.pipeline.deleteMany({ where: { workspaceId: { in: ids } } });
  await prismaUnsafe.workspace.deleteMany({ where: { id: { in: ids } } });
}

beforeAll(async () => {
  await clean();
  wsA = (await prismaUnsafe.workspace.create({ data: { name: NAMES[0] } })).id;
  wsB = (await prismaUnsafe.workspace.create({ data: { name: NAMES[1] } })).id;
});

afterAll(clean);

beforeEach(async () => {
  const ids = [wsA, wsB];
  await prismaUnsafe.notification.deleteMany({ where: { workspaceId: { in: ids } } });
  await prismaUnsafe.proposal.deleteMany({ where: { workspaceId: { in: ids } } });
  await prismaUnsafe.target.deleteMany({ where: { workspaceId: { in: ids } } });
  await prismaUnsafe.deal.deleteMany({ where: { workspaceId: { in: ids } } });
  await prismaUnsafe.dealStage.deleteMany({ where: { workspaceId: { in: ids } } });
  await prismaUnsafe.pipeline.deleteMany({ where: { workspaceId: { in: ids } } });
  await prismaUnsafe.workspace.update({ where: { id: wsA }, data: { dealsConfig: Prisma.DbNull } });
});

const db = () => getWorkspaceClient(wsA);

async function web() {
  const pipelines = await ensurePipelines(wsA);
  return pipelines.find((p) => p.key === "web-projects")!;
}

describe("commit threshold", () => {
  it("defaults to 70 and clamps nonsense", () => {
    expect(commitThresholdFrom(null)).toBe(70);
    expect(commitThresholdFrom({})).toBe(70);
    expect(commitThresholdFrom({ commitThreshold: 55 })).toBe(55);
    expect(commitThresholdFrom({ commitThreshold: 500 })).toBe(100);
    expect(commitThresholdFrom({ commitThreshold: "nope" })).toBe(70);
  });
});

describe("loadForecast", () => {
  it("matches the hand-checked fixture and always opens on the current month", async () => {
    const p = await web();
    const qualified = p.stages.find((s) => s.key === "qualified")!;
    const negotiation = p.stages.find((s) => s.key === "negotiation")!;
    await createDealIn(wsA, null, {
      title: "A",
      pipelineId: p.id,
      stageId: qualified.id,
      value: 1_000_000,
      expectedCloseAt: "2026-09-10",
    });
    await createDealIn(wsA, null, {
      title: "B",
      pipelineId: p.id,
      stageId: negotiation.id,
      value: 2_000_000,
      expectedCloseAt: "2026-09-25",
    });

    const view = await loadForecast(wsA, { now: new Date(2026, 8, 1) });
    expect(view.months[0]).toBe("2026-09");
    expect(view.months).toHaveLength(6);
    const sep = view.overall.rows.find((r) => r.month === "2026-09")!;
    expect(sep.weighted).toBe(1_700_000);
    expect(sep.commit).toBe(1_500_000);
    expect(sep.upside).toBe(200_000);
    // The five months after it exist as explicit zeroes, not as absent rows.
    expect(view.overall.rows.filter((r) => r.weighted === 0).length).toBeGreaterThanOrEqual(5);
  });

  it("honours a workspace's own threshold", async () => {
    const p = await web();
    const negotiation = p.stages.find((s) => s.key === "negotiation")!; // 75%
    await createDealIn(wsA, null, {
      title: "B",
      pipelineId: p.id,
      stageId: negotiation.id,
      value: 1_000_000,
      expectedCloseAt: "2026-09-25",
    });

    await prismaUnsafe.workspace.update({
      where: { id: wsA },
      data: { dealsConfig: { commitThreshold: 80 } },
    });
    const view = await loadForecast(wsA, { now: new Date(2026, 8, 1) });
    expect(view.commitThreshold).toBe(80);
    expect(view.overall.totals.commit).toBe(0);
    expect(view.overall.totals.upside).toBe(750_000);
  });

  it("drops closed deals out of the forecast", async () => {
    const p = await web();
    const won = p.stages.find((s) => s.kind === "won")!;
    const created = await createDealIn(wsA, null, {
      title: "Closed",
      pipelineId: p.id,
      value: 5_000_000,
      expectedCloseAt: "2026-09-10",
    });
    if (!created.ok) throw new Error("setup failed");
    await moveStageIn(wsA, null, created.dealId, won.id);

    const view = await loadForecast(wsA, { now: new Date(2026, 8, 1) });
    expect(view.overall.totals.weighted).toBe(0);
  });

  it("reads the monthly revenue target when one is set", async () => {
    await db().target.create({
      data: { workspaceId: wsA, metric: "revenue", period: "monthly", value: 3_000_000 },
    });
    const view = await loadForecast(wsA, { now: new Date(2026, 8, 1) });
    expect(view.monthlyTarget).toBe(3_000_000);
  });

  it("splits per pipeline, so one board cannot hide behind the other", async () => {
    const pipelines = await ensurePipelines(wsA);
    const grants = pipelines.find((p) => p.key === "grants")!;
    await createDealIn(wsA, null, {
      title: "Grant",
      pipelineId: grants.id,
      stageId: grants.stages.find((s) => s.key === "submitted")!.id, // 70%
      value: 1_000_000,
      expectedCloseAt: "2026-09-10",
    });

    const view = await loadForecast(wsA, { now: new Date(2026, 8, 1) });
    const g = view.perPipeline.find((p) => p.pipelineName === "Grants")!;
    const w = view.perPipeline.find((p) => p.pipelineName === "Web projects")!;
    expect(g.forecast.totals.weighted).toBe(700_000);
    expect(w.forecast.totals.weighted).toBe(0);
  });
});

describe("quarterly stage-probability calibration", () => {
  async function closeDeals(wonCount: number, lostCount: number) {
    const p = await web();
    const won = p.stages.find((s) => s.kind === "won")!;
    const lost = p.stages.find((s) => s.kind === "lost")!;
    for (let i = 0; i < wonCount; i += 1) {
      const d = await createDealIn(wsA, null, { title: `W${i}`, pipelineId: p.id });
      if (d.ok) await moveStageIn(wsA, null, d.dealId, won.id);
    }
    for (let i = 0; i < lostCount; i += 1) {
      const d = await createDealIn(wsA, null, { title: `L${i}`, pipelineId: p.id });
      if (d.ok) await moveStageIn(wsA, null, d.dealId, lost.id, { lostReason: "price" });
    }
  }

  it("stays silent below the minimum sample", async () => {
    await closeDeals(5, 5);
    await processStageProbabilityCalibration();
    expect(await db().proposal.count()).toBe(0);
  });

  it("raises a proposal — and does not apply it", async () => {
    // 24 won / 6 lost against a Qualified stage configured at 20%: an observed
    // 80% is far enough from 20% to be worth someone's attention.
    await closeDeals(24, 6);
    const raised = await processStageProbabilityCalibration();
    expect(raised).toBeGreaterThan(0);

    const proposals = await db().proposal.findMany({ where: { kind: "STAGE_PROBABILITY" } });
    expect(proposals.length).toBeGreaterThan(0);
    expect(proposals[0].status).toBe("PENDING");

    // Nothing self-modifies: the stage still carries its configured number.
    const qualified = await db().dealStage.findFirstOrThrow({ where: { key: "qualified" } });
    expect(qualified.probability).toBe(20);
  });

  it("does not stack a second copy of a pending proposal", async () => {
    await closeDeals(24, 6);
    await processStageProbabilityCalibration();
    const first = await db().proposal.count();
    await processStageProbabilityCalibration();
    expect(await db().proposal.count()).toBe(first);
  });

  it("costs no Claude budget", async () => {
    await closeDeals(24, 6);
    /**
     * Scoped to THIS workspace, not counted globally.
     *
     * A global count races every other test file: vitest runs files in parallel
     * against one database, so a Claude call made elsewhere between the two counts
     * failed this assertion with an off-by-one that had nothing to do with the
     * calibration job. What the test means is "the calibration spends no budget",
     * and that is a per-workspace claim.
     */
    const where = { workspaceId: { in: [wsA, wsB] } };
    const before = await prismaUnsafe.claudeUsage.count({ where });
    await processStageProbabilityCalibration();
    expect(await prismaUnsafe.claudeUsage.count({ where })).toBe(before);
  });
});
