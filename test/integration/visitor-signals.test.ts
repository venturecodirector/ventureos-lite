import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prismaUnsafe, getWorkspaceClient } from "../../src/lib/db";
import { recordVisit } from "../../src/modules/tracking/record";
import { processRawIpPurge, processVisitRetention } from "../../src/modules/tracking/jobs";
import { pageStats, quoteActivity, pageStatsBatch } from "../../src/modules/tracking/data";
import { eraseLeadData } from "../../src/modules/gdpr/erase";

/**
 * The signal layer against the real database (playbook-v3 P8).
 *
 * The promises worth proving here are the ones we make to a visitor: the raw
 * address does not outlive 24 hours, a Do-Not-Track reader leaves nothing but a
 * count, and an erased lead takes their visits with them.
 */
const NAMES = ["Visit Alpha", "Visit Bravo"];
let ws = "";
let wsOther = "";

async function clean() {
  const stale = await prismaUnsafe.workspace.findMany({
    where: { name: { in: NAMES } },
    select: { id: true },
  });
  const ids = stale.map((w) => w.id);
  if (!ids.length) return;
  for (const t of ["visitorSignal", "pageVisit", "activity", "task", "lead", "company"] as const) {
    // @ts-expect-error dynamic model access
    await prismaUnsafe[t].deleteMany({ where: { workspaceId: { in: ids } } });
  }
  await prismaUnsafe.workspace.deleteMany({ where: { id: { in: ids } } });
}

beforeAll(async () => {
  await clean();
  ws = (await prismaUnsafe.workspace.create({ data: { name: NAMES[0] } })).id;
  wsOther = (await prismaUnsafe.workspace.create({ data: { name: NAMES[1] } })).id;
});
afterAll(clean);

beforeEach(async () => {
  for (const id of [ws, wsOther]) {
    await prismaUnsafe.visitorSignal.deleteMany({ where: { workspaceId: id } });
    await prismaUnsafe.pageVisit.deleteMany({ where: { workspaceId: id } });
  }
});

const target = (over: Partial<Record<string, string | null>> = {}) => ({
  workspaceId: ws,
  leadId: null,
  companyId: null,
  documentId: null,
  auditId: null,
  ...over,
});

describe("recordVisit", () => {
  it("keeps one row per session per page, moving the numbers forward", async () => {
    const base = { pageType: "quote" as const, slug: "q-1", target: target(), ipSalt: "s" };
    await recordVisit({ ...base, beacon: { t: "sess-a", p: "quote", s: "q-1" }, ip: "81.2.3.4" });
    await recordVisit({
      ...base,
      beacon: { t: "sess-a", p: "quote", s: "q-1", d: 40_000, sd: 55, sec: { pricing: 30_000 } },
      ip: "81.2.3.4",
    });
    // A heartbeat that arrives out of order must not shorten the reading.
    await recordVisit({
      ...base,
      beacon: { t: "sess-a", p: "quote", s: "q-1", d: 10, sd: 2 },
      ip: "81.2.3.4",
    });

    const rows = await prismaUnsafe.pageVisit.findMany({ where: { workspaceId: ws } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.durationMs).toBe(40_000);
    expect(rows[0]!.scrollPct).toBe(55);
    expect(rows[0]!.sections).toEqual({ pricing: 30_000 });
  });

  it("queues enrichment only for a NEW session, not for every heartbeat", async () => {
    const base = { pageType: "quote" as const, slug: "q-2", target: target(), ipSalt: "s" };
    const first = await recordVisit({
      ...base,
      beacon: { t: "sess-b", p: "quote", s: "q-2" },
      ip: "81.2.3.4",
    });
    const second = await recordVisit({
      ...base,
      beacon: { t: "sess-b", p: "quote", s: "q-2", d: 5000 },
      ip: "81.2.3.4",
    });
    expect(first).toBeTruthy();
    expect(second).toBeNull();
  });

  /**
   * The Do-Not-Track promise, in the only place it can be checked: what is on
   * disk afterwards.
   */
  it("stores a bare view for a Do-Not-Track visitor and nothing else", async () => {
    await recordVisit({
      pageType: "quote",
      slug: "q-3",
      target: target(),
      beacon: { t: "sess-c", p: "quote", s: "q-3", dnt: 1, d: 90_000, sd: 100, r: "https://x" },
      ip: "81.2.3.4",
      ipSalt: "s",
    });
    const row = await prismaUnsafe.pageVisit.findFirst({ where: { pageSlug: "q-3" } });
    expect(row!.doNotTrack).toBe(true);
    expect(row!.durationMs).toBe(0);
    expect(row!.scrollPct).toBe(0);
    expect(row!.sections).toEqual({});
    expect(row!.referrer).toBeNull();
    expect(row!.ipRaw).toBeNull();
    // Not even a hash: the address was never worth keeping in any form.
    expect(row!.ipHash).toBeNull();
  });

  it("holds the raw address only alongside a hash of it", async () => {
    await recordVisit({
      pageType: "quote",
      slug: "q-4",
      target: target(),
      beacon: { t: "sess-d", p: "quote", s: "q-4" },
      ip: "81.2.3.4",
      ipSalt: "pepper",
    });
    const row = await prismaUnsafe.pageVisit.findFirst({ where: { pageSlug: "q-4" } });
    expect(row!.ipRaw).toBe("81.2.3.4");
    expect(row!.ipHash).toBeTruthy();
    expect(row!.ipHash).not.toContain("81.2.3.4");
  });
});

describe("retention", () => {
  it("purges the raw address once it is 24 hours old, and not before", async () => {
    const mk = async (slug: string, ageHours: number) => {
      await recordVisit({
        pageType: "quote",
        slug,
        target: target(),
        beacon: { t: `t-${slug}`, p: "quote", s: slug },
        ip: "81.2.3.4",
        ipSalt: "s",
      });
      await prismaUnsafe.pageVisit.updateMany({
        where: { pageSlug: slug },
        data: { startedAt: new Date(Date.now() - ageHours * 3600_000) },
      });
    };
    await mk("old", 25);
    await mk("fresh", 23);

    const purged = await processRawIpPurge();
    expect(purged).toBeGreaterThanOrEqual(1);

    const old = await prismaUnsafe.pageVisit.findFirst({ where: { pageSlug: "old" } });
    const fresh = await prismaUnsafe.pageVisit.findFirst({ where: { pageSlug: "fresh" } });
    expect(old!.ipRaw).toBeNull();
    // The hash survives: it is what abuse-spotting needs and it names nobody.
    expect(old!.ipHash).toBeTruthy();
    expect(fresh!.ipRaw).toBe("81.2.3.4");
  });

  it("strips a 90-day-old session down to a count", async () => {
    await recordVisit({
      pageType: "quote",
      slug: "ancient",
      target: target(),
      beacon: { t: "t-anc", p: "quote", s: "ancient", d: 5000, sec: { pricing: 5000 }, r: "https://x" },
      ip: "81.2.3.4",
      ipSalt: "s",
    });
    await prismaUnsafe.pageVisit.updateMany({
      where: { pageSlug: "ancient" },
      data: { startedAt: new Date(Date.now() - 91 * 24 * 3600_000) },
    });

    await processVisitRetention();
    const row = await prismaUnsafe.pageVisit.findFirst({ where: { pageSlug: "ancient" } });
    // The row survives — "this page was read once" is the aggregate we keep.
    expect(row).toBeTruthy();
    expect(row!.ipHash).toBeNull();
    expect(row!.referrer).toBeNull();
    expect(row!.sections).toEqual({});
    expect(row!.sessionToken).toBe("expired");
  });
});

describe("what the owner of a page gets to see", () => {
  it("counts sessions, averages only what was measured, and separates the unidentified", async () => {
    const company = await prismaUnsafe.company.create({
      data: { workspaceId: ws, name: "Danubia Kft.", domain: "danubia.hu" },
    });
    const mk = async (token: string, over: Record<string, unknown> = {}) => {
      await recordVisit({
        pageType: "audit_share",
        slug: "share-1",
        target: target(),
        beacon: { t: token, p: "audit_share", s: "share-1", d: 60_000, ...over },
        ip: "81.2.3.4",
        ipSalt: "s",
      });
    };
    await mk("v1");
    await mk("v2");
    await mk("v3", { dnt: 1 });
    await prismaUnsafe.pageVisit.updateMany({
      where: { sessionToken: "v1" },
      data: { guessCompanyId: company.id, confidence: "high", orgName: "danubia.hu" },
    });

    const stats = await pageStats(ws, "audit_share", "share-1", company.id);
    expect(stats.views).toBe(3);
    // The DNT row has no duration to average: two measured sessions, not three.
    expect(stats.avgDurationMs).toBe(60_000);
    expect(stats.viewers).toHaveLength(1);
    expect(stats.viewers[0]!.name).toBe("Danubia Kft.");
    expect(stats.unidentified).toBe(2);
    expect(stats.recipientViewed).toEqual({ viewed: true, times: 1, confidence: "high" });
  });

  it("says plainly when the recipient has NOT been seen", async () => {
    const company = await prismaUnsafe.company.create({
      data: { workspaceId: ws, name: "Nem Nézte Kft.", domain: "nemnezte.hu" },
    });
    await recordVisit({
      pageType: "quote",
      slug: "q-unseen",
      target: target(),
      beacon: { t: "stranger", p: "quote", s: "q-unseen" },
      ip: "81.2.3.4",
      ipSalt: "s",
    });
    const stats = await pageStats(ws, "quote", "q-unseen", company.id);
    expect(stats.recipientViewed).toEqual({ viewed: false, times: 0, confidence: "none" });
  });

  it("reports where the reader's attention went on a quote", async () => {
    await recordVisit({
      pageType: "quote",
      slug: "q-attn",
      target: target(),
      beacon: {
        t: "reader",
        p: "quote",
        s: "q-attn",
        d: 200_000,
        sd: 95,
        sec: { pricing: 150_000, scope: 20_000 },
      },
      ip: "81.2.3.4",
      ipSalt: "s",
    });
    const a = await quoteActivity(ws, "q-attn");
    expect(a.sessions).toBe(1);
    expect(a.pricingMs).toBe(150_000);
    expect(a.scopeMs).toBe(20_000);
    expect(a.scrollToBottomPct).toBe(100);
  });

  it("batches many pages without mixing their readers up", async () => {
    for (const slug of ["b-1", "b-2"]) {
      await recordVisit({
        pageType: "quote",
        slug,
        target: target(),
        beacon: { t: `tok-${slug}`, p: "quote", s: slug, d: 1000 },
        ip: "81.2.3.4",
        ipSalt: "s",
      });
    }
    await recordVisit({
      pageType: "quote",
      slug: "b-2",
      target: target(),
      beacon: { t: "tok-extra", p: "quote", s: "b-2", d: 1000 },
      ip: "81.2.3.4",
      ipSalt: "s",
    });
    const map = await pageStatsBatch(ws, ["b-1", "b-2"]);
    expect(map.get("b-1")!.views).toBe(1);
    expect(map.get("b-2")!.views).toBe(2);
  });

  it("cannot see another workspace's visits", async () => {
    await recordVisit({
      pageType: "quote",
      slug: "shared-slug",
      target: { ...target(), workspaceId: wsOther },
      beacon: { t: "other", p: "quote", s: "shared-slug" },
      ip: "81.2.3.4",
      ipSalt: "s",
    });
    const stats = await pageStats(ws, "quote", "shared-slug");
    expect(stats.views).toBe(0);
  });
});

describe("erasure", () => {
  it("takes a lead's visits and signals with them", async () => {
    const company = await prismaUnsafe.company.create({
      data: { workspaceId: ws, name: "Erase Co", domain: "erase.hu" },
    });
    const lead = await prismaUnsafe.lead.create({
      data: { workspaceId: ws, companyId: company.id, contactName: "Erase Me" },
    });
    await recordVisit({
      pageType: "quote",
      slug: "q-erase",
      target: target({ leadId: lead.id, companyId: company.id }),
      beacon: { t: "erase-sess", p: "quote", s: "q-erase" },
      ip: "81.2.3.4",
      ipSalt: "s",
    });
    await prismaUnsafe.visitorSignal.create({
      data: {
        workspaceId: ws,
        companyId: company.id,
        leadId: lead.id,
        visitId: "x",
        pageType: "quote",
        pageSlug: "q-erase",
        confidence: "high",
        warmUntil: new Date(),
      },
    });

    await eraseLeadData(getWorkspaceClient(ws), lead.id, { eraseDocuments: false });

    expect(await prismaUnsafe.pageVisit.count({ where: { leadId: lead.id } })).toBe(0);
    expect(await prismaUnsafe.visitorSignal.count({ where: { leadId: lead.id } })).toBe(0);
  });
});
