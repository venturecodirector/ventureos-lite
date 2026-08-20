import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { prismaUnsafe } from "../../src/lib/db";

/**
 * Saving a lead from the detail modal, against the real database.
 *
 * ── THE REPORTED PROBLEM ────────────────────────────────────────────────────
 *
 * "Lead szerkesztésekor a mentés nem megy" — pressing Save changes nothing and
 * says nothing. Silence is the diagnostic clue: every REFUSAL in this action is
 * returned as `{ ok: false, error }` and rendered, so a save that produces no
 * message at all was never refused — it THREW, and Next.js redacts anything
 * thrown out of a Server Action to a bare digest. The client handler had no
 * try/catch, so the rejection went nowhere.
 *
 * Reasoning about the action's source could not find it, and would not have:
 * the schema accepts the payload the modal sends, and every early return is
 * shaped correctly. So this calls the real function against real Postgres with
 * the exact payload the form builds.
 */
const WS = ["Save Test Alpha", "Save Test Bravo"];
const EMAILS = ["save-owner@iso.test"];
let wsA = "";
let wsB = "";
let ownerId = "";
let companyA = "";

vi.mock("next/cache", () => ({
  revalidatePath: () => {},
  revalidateTag: () => {},
  unstable_cache: (f: unknown) => f,
}));
vi.mock("@/lib/session", () => ({
  getActiveContext: async () => ({ workspaceId: wsA, userId: ownerId, sessionId: "s" }),
  tryGetActiveContext: async () => ({ workspaceId: wsA, userId: ownerId, sessionId: "s" }),
}));

async function clean() {
  const stale = await prismaUnsafe.workspace.findMany({
    where: { name: { in: WS } },
    select: { id: true },
  });
  const ids = stale.map((w) => w.id);
  if (ids.length) {
    for (const t of ["activity", "lead", "company"] as const) {
      // @ts-expect-error dynamic model access
      await prismaUnsafe[t].deleteMany({ where: { workspaceId: { in: ids } } });
    }
    await prismaUnsafe.membership.deleteMany({ where: { workspaceId: { in: ids } } });
    await prismaUnsafe.workspace.deleteMany({ where: { id: { in: ids } } });
  }
  await prismaUnsafe.user.deleteMany({ where: { email: { in: EMAILS } } });
}

beforeAll(async () => {
  await clean();
  wsA = (await prismaUnsafe.workspace.create({ data: { name: WS[0] } })).id;
  wsB = (await prismaUnsafe.workspace.create({ data: { name: WS[1] } })).id;
  ownerId = (
    await prismaUnsafe.user.create({
      data: { email: EMAILS[0], name: "Save Owner", passwordHash: "x" },
    })
  ).id;
  await prismaUnsafe.membership.create({
    data: { workspaceId: wsA, userId: ownerId, role: "OWNER" },
  });
  companyA = (
    await prismaUnsafe.company.create({ data: { workspaceId: wsA, name: "Save Co" } })
  ).id;
});

afterAll(async () => {
  await clean();
});

async function makeLead(extra: Record<string, unknown> = {}) {
  return prismaUnsafe.lead.create({
    data: {
      workspaceId: wsA,
      companyId: companyA,
      contactName: "Before Name",
      source: "MANUAL",
      stage: "RESEARCHED",
      language: "HU",
      ...extra,
    },
  });
}

/** Exactly what `save()` in lead-detail-modal.tsx sends. */
function payload(leadId: string, over: Record<string, unknown> = {}) {
  return {
    leadId,
    contactName: "After Name",
    title: "CEO",
    headline: "CEO at Save Co",
    locationRaw: "Budapest, Hungary",
    email: "after@save.test",
    phone: "+36 1 234 5678",
    linkedinUrl: "https://www.linkedin.com/in/after/",
    language: "HU",
    notes: "edited",
    signals: ["hiring"],
    company: { name: "Save Co", domain: "save.test", city: "Budapest", taxId: "" },
    ...over,
  };
}

describe("saving the lead detail form", () => {
  it("saves the payload the modal actually sends", async () => {
    const { updateLeadDetail } = await import("../../src/modules/leads/detail");
    const lead = await makeLead();
    const res = await updateLeadDetail(payload(lead.id));
    expect(res, "the action refused or threw").toEqual({ ok: true });
    const after = await prismaUnsafe.lead.findUnique({ where: { id: lead.id } });
    expect(after?.contactName).toBe("After Name");
    expect(after?.title).toBe("CEO");
    expect(after?.locationRaw).toBe("Budapest, Hungary");
  });

  it("does not throw for a lead in another workspace — it refuses", async () => {
    const { updateLeadDetail } = await import("../../src/modules/leads/detail");
    const other = await prismaUnsafe.lead.create({
      data: { workspaceId: wsB, source: "MANUAL", stage: "RESEARCHED", language: "HU" },
    });
    const res = await updateLeadDetail(payload(other.id));
    expect(res).toEqual({ ok: false, error: "Lead not found." });
    await prismaUnsafe.lead.delete({ where: { id: other.id } });
  });

  /**
   * A lead captured from LinkedIn or added by hand often has NO company row.
   * The form still shows the four company fields, so typing a company name into
   * them and pressing Save looked like it worked and changed nothing at all:
   * the whole company branch was behind `if (lead.companyId && …)`.
   */
  it("creates the company when the lead has none", async () => {
    const { updateLeadDetail } = await import("../../src/modules/leads/detail");
    const lead = await makeLead({ companyId: null });
    const res = await updateLeadDetail(
      payload(lead.id, {
        company: { name: "Brand New Kft", domain: "brandnew.hu", city: "Debrecen", taxId: "" },
      }),
    );
    expect(res).toEqual({ ok: true });
    const after = await prismaUnsafe.lead.findUnique({
      where: { id: lead.id },
      include: { company: true },
    });
    expect(after?.company?.name, "the typed company was discarded").toBe("Brand New Kft");
    expect(after?.company?.city).toBe("Debrecen");
    expect(after?.company?.workspaceId).toBe(wsA);
  });
});
