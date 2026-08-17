import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { prismaUnsafe } from "../../src/lib/db";
import { createCaptureToken } from "../../src/modules/capture/tokens";
import { hasAnalyzableText } from "../../src/modules/leads/preparse";

/**
 * What a capture actually LEAVES BEHIND (the LinkedIn/Lead-Engine fix).
 *
 * The extension was reading a profile and posting it correctly, and the lead
 * still could not be researched: `runResearch` looks for prose to analyse and
 * this endpoint never wrote any. Everything it read went into `bio`, `title`
 * and the company row, `notes` stayed empty, and the button answered "there is
 * no profile text to analyse yet" for ever. Nothing was broken in isolation —
 * the two halves simply never met, which is exactly the kind of gap only an
 * end-to-end test over the real handler catches.
 *
 * Also covered: the two silent data defects found alongside it. A company NAME
 * was being run through a DOMAIN normaliser to look up an existing company, so
 * the lookup could only ever miss and every capture made a fresh duplicate; and
 * a `data:` lazy-load placeholder was accepted as a photo URL, which is why
 * captured leads showed initials instead of a face.
 */

// No model call in a test: the endpoint asks Haiku for a one-line brief, which
// is not what is under test and is not free.
vi.mock("../../src/lib/ai/call-claude", () => ({
  callClaude: vi.fn(async () => {
    throw new Error("no model calls in tests");
  }),
}));

// The avatar store fetches the photo over the network. Under test we only care
// WHICH url reaches it.
const avatarCalls: string[] = [];
vi.mock("../../src/modules/capture/avatar", () => ({
  storeAvatar: vi.fn(async (leadId: string, url: string) => {
    avatarCalls.push(url);
    return { path: `avatars/${leadId}.jpg`, reason: null };
  }),
}));

const { POST } = await import("../../src/app/api/capture/route");

const EMAIL = "capture-route-user@ventureco.test";
const PROFILE = "https://www.linkedin.com/in/capture-route-tester";
const REAL_PHOTO =
  "https://media.licdn.com/dms/image/v2/D4D/profile-displayphoto-shrink_400_400/0/1699?e=1";
const PLACEHOLDER = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";

let workspaceId = "";
let userId = "";
let token = "";

const FULL_CAPTURE = {
  url: PROFILE,
  name: "Nagy Anna",
  headline: "Ügyvezető @ Danubia Fogászat | mosolytervezés",
  companyName: "Danubia Fogászat Kft.",
  location: "Budapest, Hungary",
  jobTitle: "Ügyvezető",
  email: "anna@danubia.hu",
  phone: "+36 30 123 4567",
  websiteUrl: "https://www.danubia-fogaszat.hu",
  bio: "Fogászati rendelőt vezetek Budán 1998 óta. Négy székkel és hat kollégával dolgozunk, minden implantációt saját CBCT-vel tervezünk.",
  photoUrl: REAL_PHOTO,
  posts: ["Új CBCT-t állítottunk be a héten."],
};

function post(body: unknown, bearer = token): Promise<Response> {
  return POST(
    new Request("https://app.test/api/capture", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
      body: JSON.stringify(body),
    }),
  );
}

// Its OWN workspace, not the seeded one. Test files run in parallel and several
// of them clear every company in the workspaces they touch; borrowing the shared
// one meant a company could vanish between this endpoint finding it and using
// it, which surfaces as a foreign-key error that looks like a product bug.
const WORKSPACE = "Capture Route Test WS";

async function cleanup() {
  if (!workspaceId) return;
  await prismaUnsafe.activity.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.lead.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.company.deleteMany({ where: { workspaceId } });
}

beforeAll(async () => {
  await prismaUnsafe.workspace.deleteMany({ where: { name: WORKSPACE } }).catch(() => {});
  workspaceId = (await prismaUnsafe.workspace.create({ data: { name: WORKSPACE } })).id;
  const user = await prismaUnsafe.user.upsert({
    where: { email: EMAIL },
    update: {},
    create: { email: EMAIL, name: "Capture Route Tester", passwordHash: "x" },
  });
  userId = user.id;
  await prismaUnsafe.membership.upsert({
    where: { userId_workspaceId: { userId, workspaceId } },
    update: {},
    create: { userId, workspaceId, role: "OWNER" },
  });
  token = (await createCaptureToken(userId, workspaceId, "test")).token;
});

beforeEach(async () => {
  avatarCalls.length = 0;
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await prismaUnsafe.captureToken.deleteMany({ where: { userId } });
  await prismaUnsafe.membership.deleteMany({ where: { userId } });
  await prismaUnsafe.user.deleteMany({ where: { email: EMAIL } });
  await prismaUnsafe.workspace.deleteMany({ where: { id: workspaceId } });
});

describe("a captured lead can be researched", () => {
  it("writes the profile into notes, which is where research looks for it", async () => {
    const res = await post(FULL_CAPTURE);
    expect(res.status).toBe(201);

    const lead = await prismaUnsafe.lead.findFirst({ where: { linkedinUrl: PROFILE } });
    // THE BUG: this was null on every extension-captured lead.
    expect(lead!.notes).toBeTruthy();
    expect(hasAnalyzableText(lead!.notes!)).toBe(true);
  });

  it("keeps every field it read, not only the name", async () => {
    await post(FULL_CAPTURE);
    const lead = await prismaUnsafe.lead.findFirst({
      where: { linkedinUrl: PROFILE },
      include: { company: true },
    });
    expect(lead!.contactName).toBe("Nagy Anna");
    expect(lead!.title).toBe("Ügyvezető");
    expect(lead!.email).toBe("anna@danubia.hu");
    // Normalized to E.164 on the way in, so two spellings of one number are
    // one number and a dialler can use it without cleanup.
    expect(lead!.phone).toBe("+36301234567");
    expect(lead!.bio).toContain("Fogászati rendelőt vezetek");
    expect(lead!.company!.name).toBe("Danubia Fogászat Kft.");
    expect(lead!.notes).toContain("Budapest, Hungary");
    expect(lead!.notes).toContain("+36301234567");
    expect(lead!.notes).toContain("Új CBCT-t");
  });

  it("writes NO notes for a capture that read nothing but a name", async () => {
    // Hard rule #3's other side. The block's own header and footer are enough
    // words to fool `hasAnalyzableText`, so writing one here would disarm the
    // gate for exactly the empty leads it exists to stop.
    await post({ url: PROFILE, name: "Nagy Anna", posts: [] });
    const lead = await prismaUnsafe.lead.findFirst({ where: { linkedinUrl: PROFILE } });
    expect(lead!.contactName).toBe("Nagy Anna");
    expect(hasAnalyzableText(lead!.notes ?? "")).toBe(false);
  });

  it("still writes notes worth analysing when only the About text came through", async () => {
    // The realistic degraded capture: a layout change costs the structured
    // fields but the About section still reads.
    await post({ url: PROFILE, name: "Nagy Anna", bio: FULL_CAPTURE.bio, posts: [] });
    const lead = await prismaUnsafe.lead.findFirst({ where: { linkedinUrl: PROFILE } });
    expect(hasAnalyzableText(lead!.notes!)).toBe(true);
  });
});

describe("re-capturing the same profile", () => {
  it("updates the one lead instead of making a second", async () => {
    await post(FULL_CAPTURE);
    const second = await post(FULL_CAPTURE);
    expect(second.status).toBe(200);
    expect(await prismaUnsafe.lead.count({ where: { linkedinUrl: PROFILE } })).toBe(1);
  });

  it("does not eat notes a person typed", async () => {
    await post(FULL_CAPTURE);
    const lead = await prismaUnsafe.lead.findFirst({ where: { linkedinUrl: PROFILE } });
    await prismaUnsafe.lead.update({
      where: { id: lead!.id },
      data: { notes: `Spoke to her at the trade fair, call back in March.\n\n${lead!.notes}` },
    });

    await post({ ...FULL_CAPTURE, bio: "Új szöveg a névjegyben." });
    const after = await prismaUnsafe.lead.findFirst({ where: { linkedinUrl: PROFILE } });
    // The human's line survives; the captured block is the part replaced.
    expect(after!.notes).toContain("call back in March");
    expect(after!.notes).toContain("Új szöveg a névjegyben.");
    expect(after!.notes).not.toContain("Négy székkel");
    // And exactly one captured block, not a growing pile of them.
    expect(after!.notes!.split("--- captured from LinkedIn ---")).toHaveLength(2);
  });

  it("matches the company that is already on file rather than duplicating it", async () => {
    // `normalizeDomain("Danubia Fogászat Kft.")` was being used as a domain
    // lookup, so this match never happened.
    await prismaUnsafe.company.create({
      data: { workspaceId, name: "danubia fogászat kft.", city: "Budapest" },
    });
    await post(FULL_CAPTURE);
    const companies = await prismaUnsafe.company.findMany({
      where: { workspaceId, name: { contains: "Danubia Fogászat", mode: "insensitive" } },
    });
    expect(companies).toHaveLength(1);
    // And the site the profile linked to fills the blank domain.
    expect(companies[0]!.domain).toBe("danubia-fogaszat.hu");
  });
});

describe("the profile photo", () => {
  it("passes a real https address to the avatar store", async () => {
    await post(FULL_CAPTURE);
    expect(avatarCalls).toEqual([REAL_PHOTO]);
  });

  it("drops a lazy-load placeholder instead of reporting a photo it does not have", async () => {
    // A data: URL parses as a URL, which is how it used to reach the avatar
    // store and be refused there — the capture claimed a photo and the app
    // showed initials.
    const res = await post({ ...FULL_CAPTURE, photoUrl: PLACEHOLDER });
    expect(res.status).toBe(201);
    expect(avatarCalls).toEqual([]);
    const lead = await prismaUnsafe.lead.findFirst({ where: { linkedinUrl: PROFILE } });
    expect(lead!.avatarPath).toBeNull();
  });
});

describe("the endpoint still refuses what it should", () => {
  it("rejects a capture with no credential", async () => {
    expect((await post(FULL_CAPTURE, "vos_cap_" + "a".repeat(32))).status).toBe(401);
  });

  it("rejects a body with no URL, naming the field", async () => {
    const res = await post({ name: "Nobody" });
    expect(res.status).toBe(400);
    expect((await res.json()).fields).toContain("url");
  });
});

describe("the capture explains itself later (diagnostics v3)", () => {
  it("stores the reader's account on the capture activity", async () => {
    // Two rounds of the extraction bug each began with "can you reproduce it and
    // tell me what the popup said" — and the popup had closed. The evidence is
    // now a property of the lead.
    await post({
      ...FULL_CAPTURE,
      diagnostics: {
        diagnoseVersion: 3,
        fields: { headline: { present: true, strategy: "topcard", attempted: ["topcard:accepted"] } },
        boundary: { ok: true, identitiesInCard: 1, excludedNegativeSpaceNodes: 1 },
      },
    });
    const lead = await prismaUnsafe.lead.findFirst({ where: { linkedinUrl: PROFILE } });
    const act = await prismaUnsafe.activity.findFirst({
      where: { leadId: lead!.id, type: "capture_created" },
    });
    const payload = act!.payload as Record<string, unknown>;
    expect(payload.diagnostics).toMatchObject({ diagnoseVersion: 3 });
    expect(payload.city).toBe("Budapest");
    expect(payload.contactReasons).toBeTruthy();
  });

  it("drops an oversized diagnostic rather than refusing the capture", async () => {
    // A diagnostic is not worth losing a lead over.
    const res = await post({ ...FULL_CAPTURE, diagnostics: { blob: "x".repeat(40_000) } });
    expect(res.status).toBe(201);
    const lead = await prismaUnsafe.lead.findFirst({ where: { linkedinUrl: PROFILE } });
    const act = await prismaUnsafe.activity.findFirst({
      where: { leadId: lead!.id, type: "capture_created" },
    });
    expect((act!.payload as Record<string, unknown>).diagnostics).toBeNull();
  });

  it("records the resolved city and the reason when a location does not resolve", async () => {
    await post({ ...FULL_CAPTURE, location: "Keletso Thophego, CFP" });
    const lead = await prismaUnsafe.lead.findFirst({
      where: { linkedinUrl: PROFILE },
      include: { company: true },
    });
    // Empty beats wrong: the city is blank and the reason says why.
    expect(lead!.company!.city).toBeNull();
    const act = await prismaUnsafe.activity.findFirst({
      where: { leadId: lead!.id, type: "capture_created" },
    });
    expect((act!.payload as Record<string, unknown>).locationReason).toBe(
      "reads_as_a_person_name",
    );
  });
});
