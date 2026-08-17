import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { prismaUnsafe } from "../../src/lib/db";
import { createCaptureToken } from "../../src/modules/capture/tokens";

/**
 * "Do we already know this person?" — the query the on-profile panel fires.
 *
 * The valuable answer is not "capture this", it is DUPLICATE PROTECTION: someone
 * about to write to a person a colleague messaged last week needs to know before
 * they type. So the contacted history is the part these tests care most about.
 *
 * It also runs on every profile page view, which makes it the highest-frequency
 * endpoint in the product — so "it writes nothing" is a property worth asserting
 * rather than assuming.
 */
const { GET } = await import("../../src/app/api/capture/lookup/route");

const EMAIL = "capture-lookup-user@ventureco.test";
const WORKSPACE = "Capture Lookup Test WS";
const SLUG = "lookup-target-person";
const PROFILE = `https://www.linkedin.com/in/${SLUG}`;

let workspaceId = "";
let otherWorkspaceId = "";
let userId = "";
let token = "";

function lookup(url: string, bearer = token): Promise<Response> {
  return GET(
    new Request(`https://app.test/api/capture/lookup?url=${encodeURIComponent(url)}`, {
      headers: { authorization: `Bearer ${bearer}` },
    }),
  );
}

beforeAll(async () => {
  await prismaUnsafe.workspace.deleteMany({ where: { name: { startsWith: WORKSPACE } } });
  workspaceId = (await prismaUnsafe.workspace.create({ data: { name: WORKSPACE } })).id;
  otherWorkspaceId = (
    await prismaUnsafe.workspace.create({ data: { name: `${WORKSPACE} neighbour` } })
  ).id;
  const user = await prismaUnsafe.user.upsert({
    where: { email: EMAIL },
    update: {},
    create: { email: EMAIL, name: "Panel Tester", passwordHash: "x" },
  });
  userId = user.id;
  await prismaUnsafe.membership.upsert({
    where: { userId_workspaceId: { userId, workspaceId } },
    update: {},
    create: { userId, workspaceId, role: "OWNER" },
  });
  token = (await createCaptureToken(userId, workspaceId, "panel")).token;
});

beforeEach(async () => {
  for (const ws of [workspaceId, otherWorkspaceId]) {
    await prismaUnsafe.message.deleteMany({ where: { workspaceId: ws } });
    await prismaUnsafe.auditResult.deleteMany({ where: { workspaceId: ws } });
    await prismaUnsafe.lead.deleteMany({ where: { workspaceId: ws } });
    await prismaUnsafe.company.deleteMany({ where: { workspaceId: ws } });
  }
});

afterAll(async () => {
  for (const ws of [workspaceId, otherWorkspaceId]) {
    await prismaUnsafe.message.deleteMany({ where: { workspaceId: ws } });
    await prismaUnsafe.auditResult.deleteMany({ where: { workspaceId: ws } });
    await prismaUnsafe.lead.deleteMany({ where: { workspaceId: ws } });
    await prismaUnsafe.company.deleteMany({ where: { workspaceId: ws } });
  }
  await prismaUnsafe.captureToken.deleteMany({ where: { userId } });
  await prismaUnsafe.membership.deleteMany({ where: { userId } });
  await prismaUnsafe.user.deleteMany({ where: { email: EMAIL } });
  await prismaUnsafe.workspace.deleteMany({ where: { id: { in: [workspaceId, otherWorkspaceId] } } });
});

async function seedLead(over: Record<string, unknown> = {}) {
  const company = await prismaUnsafe.company.create({
    data: { workspaceId, name: "Target Kft.", city: "Budapest" },
  });
  return prismaUnsafe.lead.create({
    data: {
      workspaceId,
      companyId: company.id,
      contactName: "Target Person",
      title: "CEO",
      linkedinUrl: PROFILE,
      source: "LINKEDIN",
      stage: "CONTACTED",
      icpScore: 4,
      ownerId: userId,
      signals: [],
      ...over,
    },
  });
}

describe("an unknown profile", () => {
  it("answers known:false, which is what shows the Capture button", async () => {
    const res = await lookup(PROFILE);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ known: false });
  });

  it("says nothing about the person it does not know", async () => {
    // No name, no company, no leaked hint that a similar record exists.
    const body = await (await lookup(PROFILE)).json();
    expect(Object.keys(body)).toEqual(["known"]);
  });
});

describe("a known profile", () => {
  it("reports the fields the panel shows", async () => {
    await seedLead();
    const body = await (await lookup(PROFILE)).json();
    expect(body).toMatchObject({
      known: true,
      contactName: "Target Person",
      title: "CEO",
      company: "Target Kft.",
      stage: "CONTACTED",
      owner: "Panel Tester",
      icpScore: 4,
      daysSinceTouch: 0,
    });
    expect(body.stageLabel).toBeTruthy();
  });

  it("matches the profile URL however it was written", async () => {
    await seedLead();
    for (const variant of [
      PROFILE,
      `${PROFILE}/`,
      `${PROFILE}?trk=abc`,
      `https://www.linkedin.com/in/${SLUG.toUpperCase()}`,
      `https://linkedin.com/in/${SLUG}/`,
    ]) {
      const body = await (await lookup(variant)).json();
      expect(body.known, variant).toBe(true);
    }
  });

  it("reports the latest completed audit score, ignoring unfinished ones", async () => {
    const lead = await seedLead();
    const companyId = lead.companyId!;
    await prismaUnsafe.auditResult.create({
      data: { workspaceId, companyId, url: "https://target.hu", status: "done", score: 41,
        expiresAt: new Date(Date.now() + 86_400_000) },
    });
    await prismaUnsafe.auditResult.create({
      data: { workspaceId, companyId, url: "https://target.hu", status: "queued", score: 0,
        expiresAt: new Date(Date.now() + 86_400_000) },
    });
    const body = await (await lookup(PROFILE)).json();
    expect(body.auditScore).toBe(41);
  });

  it("reports no audit rather than zero when none has run", async () => {
    // 0/100 and "never audited" mean opposite things to a salesperson.
    await seedLead();
    const body = await (await lookup(PROFILE)).json();
    expect(body.auditScore).toBeNull();
  });
});

describe("the duplicate-protection warning", () => {
  it("is absent when nobody has written to them", async () => {
    await seedLead();
    expect((await (await lookup(PROFILE)).json()).contacted).toBeNull();
  });

  it("counts only messages that were actually SENT, never drafts", async () => {
    // A draft is the opposite of a warning: it means nobody has been contacted.
    const lead = await seedLead();
    await prismaUnsafe.message.create({
      data: { workspaceId, leadId: lead.id, direction: "OUTBOUND", channel: "LINKEDIN",
        body: "draft", status: "DRAFT", sentAt: null },
    });
    expect((await (await lookup(PROFILE)).json()).contacted).toBeNull();
  });

  it("reports the count, how long ago and the channel", async () => {
    const lead = await seedLead();
    const sixDaysAgo = new Date(Date.now() - 6 * 86_400_000);
    await prismaUnsafe.message.create({
      data: { workspaceId, leadId: lead.id, direction: "OUTBOUND", channel: "LINKEDIN",
        body: "hello", status: "SENT", sentAt: sixDaysAgo },
    });
    await prismaUnsafe.message.create({
      data: { workspaceId, leadId: lead.id, direction: "OUTBOUND", channel: "EMAIL",
        body: "follow up", status: "SENT", sentAt: new Date(Date.now() - 86_400_000) },
    });
    const body = await (await lookup(PROFILE)).json();
    expect(body.contacted).toMatchObject({ count: 2, daysAgo: 1, channel: "EMAIL" });
    expect(body.contacted.ownedBy).toBe("Panel Tester");
  });
});

describe("what it refuses", () => {
  it("refuses an unauthenticated lookup", async () => {
    expect((await lookup(PROFILE, `vos_cap_${"a".repeat(32)}`)).status).toBe(401);
  });

  it("refuses anything that is not a LinkedIn profile URL", async () => {
    for (const bad of [
      "https://example.com/in/someone",
      "https://www.linkedin.com/company/target",
      "https://www.linkedin.com/feed/",
      "not a url",
      "",
    ]) {
      expect((await lookup(bad)).status, bad).toBe(400);
    }
  });

  /** TENANCY (hard rule #1): another workspace's lead does not exist here. */
  it("cannot see a lead belonging to another workspace", async () => {
    const company = await prismaUnsafe.company.create({
      data: { workspaceId: otherWorkspaceId, name: "Neighbour Kft." },
    });
    await prismaUnsafe.lead.create({
      data: {
        workspaceId: otherWorkspaceId,
        companyId: company.id,
        contactName: "Their Lead",
        linkedinUrl: PROFILE,
        source: "LINKEDIN",
        stage: "CONTACTED",
        signals: [],
      },
    });
    expect(await (await lookup(PROFILE)).json()).toEqual({ known: false });
  });
});

describe("it is read-only, which matters because it fires on every page view", () => {
  it("writes nothing — no lead, no activity, no api-usage row", async () => {
    await seedLead();
    const before = await Promise.all([
      prismaUnsafe.lead.count({ where: { workspaceId } }),
      prismaUnsafe.activity.count({ where: { workspaceId } }),
      prismaUnsafe.apiUsage.count({ where: { workspaceId } }),
      prismaUnsafe.message.count({ where: { workspaceId } }),
    ]);
    for (let i = 0; i < 3; i += 1) await lookup(PROFILE);
    const after = await Promise.all([
      prismaUnsafe.lead.count({ where: { workspaceId } }),
      prismaUnsafe.activity.count({ where: { workspaceId } }),
      prismaUnsafe.apiUsage.count({ where: { workspaceId } }),
      prismaUnsafe.message.count({ where: { workspaceId } }),
    ]);
    expect(after).toEqual(before);
  });

  it("never caches, so a stale 'not contacted' cannot be shown", async () => {
    const res = await lookup(PROFILE);
    expect(res.headers.get("cache-control")).toContain("no-store");
  });
});
