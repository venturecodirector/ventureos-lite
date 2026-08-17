import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { prismaUnsafe } from "../../src/lib/db";
import { createCaptureToken } from "../../src/modules/capture/tokens";

/**
 * Every captured field lands in its OWN column (capture item 2b).
 *
 * ── THE BUG THIS IS ABOUT ───────────────────────────────────────────────────
 *
 * The capture wrote `title: input.jobTitle ?? input.headline`. The Experience
 * section is lazy-rendered, so `jobTitle` is absent on most captures and the
 * headline silently took its place — and the lead form renders `title` in its
 * job-title input. On /in/mgoldberger the headline was itself the person's NAME
 * (a separate bug, item 1/2a), so the operator saw an empty Name field with
 * "Mark Goldberger" sitting in the job-title slot beside it.
 *
 * Two facts, two columns, and NEITHER substitutes for the other. A job title is
 * "VP Sales". A headline is "VP Sales @ Metaview | Startup Advisor and Investor |
 * Ramp and Navan Alum". A field with nothing captured stays empty.
 */
const { POST } = await import("../../src/app/api/capture/route");

const EMAIL = "capture-mapping-user@ventureco.test";
const WORKSPACE = "Capture Mapping Test WS";

let workspaceId = "";
let userId = "";
let token = "";

function post(body: unknown): Promise<Response> {
  return POST(
    new Request("https://app.test/api/capture", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

beforeAll(async () => {
  await prismaUnsafe.workspace.deleteMany({ where: { name: { startsWith: WORKSPACE } } });
  workspaceId = (await prismaUnsafe.workspace.create({ data: { name: WORKSPACE } })).id;
  const user = await prismaUnsafe.user.upsert({
    where: { email: EMAIL },
    update: {},
    create: { email: EMAIL, name: "Mapping Tester", passwordHash: "x" },
  });
  userId = user.id;
  await prismaUnsafe.membership.upsert({
    where: { userId_workspaceId: { userId, workspaceId } },
    update: {},
    create: { userId, workspaceId, role: "OWNER" },
  });
  token = (await createCaptureToken(userId, workspaceId, "mapping")).token;
});

async function wipe() {
  await prismaUnsafe.activity.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.lead.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.company.deleteMany({ where: { workspaceId } });
}
beforeEach(wipe);

afterAll(async () => {
  await wipe();
  await prismaUnsafe.captureToken.deleteMany({ where: { userId } });
  await prismaUnsafe.membership.deleteMany({ where: { userId } });
  await prismaUnsafe.user.deleteMany({ where: { email: EMAIL } });
  await prismaUnsafe.workspace.deleteMany({ where: { id: workspaceId } });
});

const HEADLINE = "VP Sales @ Metaview | Startup Advisor and Investor | Ramp and Navan Alum";

async function leadFor(url: string) {
  return prismaUnsafe.lead.findFirst({
    where: { workspaceId, linkedinUrl: url },
    include: { company: true },
  });
}

describe("the headline never becomes the job title", () => {
  /** THE SPECIFIED CASE: only a headline and a location were captured. */
  it("leaves title EMPTY when only a headline was captured", async () => {
    const url = "https://www.linkedin.com/in/mapping-headline-only";
    const res = await post({ url, headline: HEADLINE, location: "San Francisco Bay Area" });
    // 201 for a new lead, 200 for an update to an existing one.
    expect([200, 201]).toContain(res.status);

    const lead = await leadFor(url);
    expect(lead).not.toBeNull();
    // The two assertions the screenshot was about.
    expect(lead!.title, "the headline leaked into the job-title column").toBeNull();
    expect(lead!.headline).toBe(HEADLINE);
    // And nothing was shifted into the name either.
    expect(lead!.contactName).toBeNull();
  });

  it("keeps both when both were captured, in their own columns", async () => {
    const url = "https://www.linkedin.com/in/mapping-both";
    await post({ url, name: "Mark Goldberger", jobTitle: "VP Sales", headline: HEADLINE });
    const lead = await leadFor(url);
    expect(lead!.contactName).toBe("Mark Goldberger");
    expect(lead!.title).toBe("VP Sales");
    expect(lead!.headline).toBe(HEADLINE);
  });

  it("never writes the name into any other column", async () => {
    const url = "https://www.linkedin.com/in/mapping-name-only";
    await post({ url, name: "Mark Goldberger" });
    const lead = await leadFor(url);
    expect(lead!.contactName).toBe("Mark Goldberger");
    for (const other of [lead!.title, lead!.headline, lead!.bio]) {
      expect(other).not.toBe("Mark Goldberger");
    }
  });

  it("does not overwrite a job title a human typed", async () => {
    const url = "https://www.linkedin.com/in/mapping-existing";
    await post({ url, name: "Mark Goldberger", jobTitle: "VP Sales" });
    const first = await leadFor(url);
    await prismaUnsafe.lead.update({
      where: { id: first!.id },
      data: { title: "Chief Revenue Officer" },
    });
    // A second capture arrives with only a headline.
    await post({ url, headline: HEADLINE });
    const second = await leadFor(url);
    expect(second!.title).toBe("Chief Revenue Officer");
    expect(second!.headline).toBe(HEADLINE);
  });

  it("puts the location's city on the company, not into a contact field", async () => {
    const url = "https://www.linkedin.com/in/mapping-city";
    await post({
      url,
      name: "Mark Goldberger",
      companyName: "Metaview",
      location: "Budapest, Hungary",
    });
    const lead = await leadFor(url);
    expect(lead!.company?.name).toBe("Metaview");
    expect(lead!.company?.city).toBe("Budapest");
    expect(lead!.title).toBeNull();
    expect(lead!.headline).toBeNull();
  });
});

describe("the form's shape matches the columns", () => {
  /**
   * The mapping is only as good as the inputs it lands in, and the form used to
   * have no headline input at all — which is why sharing the job-title one looked
   * acceptable. Asserted against the component source: one labelled input per
   * field, each with its own test id.
   */
  it("has a distinct input for each captured field", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(
      join(process.cwd(), "src/components/lead-detail-modal.tsx"),
      "utf8",
    );
    for (const testid of [
      "lead-name",
      "lead-title",
      "lead-headline",
      "lead-city",
      "lead-company",
      "lead-language",
    ]) {
      expect(src, `no input carries data-testid="${testid}"`).toContain(`data-testid="${testid}"`);
    }
    // The headline input is bound to the headline, not to the title.
    expect(src).toMatch(/data-testid="lead-headline"[\s\S]{0,120}value=\{form\.headline\}/);
    expect(src).toMatch(/data-testid="lead-title"[\s\S]{0,120}value=\{form\.title\}/);
  });

  it("no longer collapses the headline into the title anywhere in the capture route", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const raw = readFileSync(join(process.cwd(), "src/app/api/capture/route.ts"), "utf8");
    // Comments stripped: the note explaining the bug quotes the old expression,
    // and a check that its own documentation trips is a check nobody keeps.
    const { stripComments } = await import("../helpers/strip-comments");
    const src = stripComments(raw);
    // The exact expression that caused it.
    expect(src).not.toMatch(/title:\s*[^\n]*input\.headline/);
    // And the two fields really are written separately.
    expect(src).toMatch(/headline:\s*(existing\.headline \?\? )?input\.headline/);
  });
});
