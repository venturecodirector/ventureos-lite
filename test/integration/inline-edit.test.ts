import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prismaUnsafe, getWorkspaceClient } from "../../src/lib/db";
import { applyInlineEdit } from "../../src/modules/leads/inline";
import { createFieldDef } from "../../src/modules/fields/store";

/**
 * Inline table edits against the real database (playbook-v2 P7/1).
 *
 * The point of these is that a table cell is not a back door: the score gate,
 * the qualification gate, field validation and the tenant guard all still hold
 * when the edit comes from a 90-pixel-wide cell instead of from a modal.
 */
const NAMES = ["Inline Alpha", "Inline Bravo"];
const EMAILS = ["inline-owner@iso.test"];
let wsA = "";
let wsB = "";
let companyA = "";
let ownerId = "";

async function clean() {
  const stale = await prismaUnsafe.workspace.findMany({
    where: { name: { in: NAMES } },
    select: { id: true },
  });
  const ids = stale.map((w) => w.id);
  if (ids.length) {
    for (const t of ["activity", "customFieldDef", "lead", "company"] as const) {
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
  wsA = (await prismaUnsafe.workspace.create({ data: { name: NAMES[0] } })).id;
  wsB = (await prismaUnsafe.workspace.create({ data: { name: NAMES[1] } })).id;
  ownerId = (
    await prismaUnsafe.user.create({
      data: { email: EMAILS[0], name: "Inline Owner", passwordHash: "x" },
    })
  ).id;
  await prismaUnsafe.membership.create({ data: { userId: ownerId, workspaceId: wsA, role: "BDR" } });
});

afterAll(clean);

beforeEach(async () => {
  for (const t of ["activity", "customFieldDef", "lead", "company"] as const) {
    // @ts-expect-error dynamic model access
    await prismaUnsafe[t].deleteMany({ where: { workspaceId: { in: [wsA, wsB] } } });
  }
  companyA = (
    await prismaUnsafe.company.create({ data: { workspaceId: wsA, name: "Danubia Kft" } })
  ).id;
});

const db = () => getWorkspaceClient(wsA);

async function lead(over: Record<string, unknown> = {}) {
  return prismaUnsafe.lead.create({
    data: { workspaceId: wsA, companyId: companyA, contactName: "Kovács Anna", ...over },
  });
}

describe("text fields", () => {
  it("saves a trimmed value and answers with what was stored", async () => {
    const l = await lead();
    const res = await applyInlineEdit(wsA, null, {
      leadId: l.id,
      field: "title",
      value: "  Ügyvezető  ",
    });
    expect(res).toEqual({ ok: true, value: "Ügyvezető" });
    expect((await db().lead.findUniqueOrThrow({ where: { id: l.id } })).title).toBe("Ügyvezető");
  });

  it("clears a field when the cell is emptied", async () => {
    const l = await lead({ title: "CEO" });
    const res = await applyInlineEdit(wsA, null, { leadId: l.id, field: "title", value: "" });
    expect(res).toEqual({ ok: true, value: null });
  });

  it("refuses a value that is not an email, without writing it", async () => {
    const l = await lead({ email: "anna@danubia.hu" });
    const res = await applyInlineEdit(wsA, null, {
      leadId: l.id,
      field: "email",
      value: "anna(at)danubia.hu",
    });
    expect(res.ok).toBe(false);
    expect((await db().lead.findUniqueOrThrow({ where: { id: l.id } })).email).toBe(
      "anna@danubia.hu",
    );
  });

  it("refuses a URL without a scheme", async () => {
    const l = await lead();
    const res = await applyInlineEdit(wsA, null, {
      leadId: l.id,
      field: "linkedinUrl",
      value: "linkedin.com/in/anna",
    });
    expect(res.ok).toBe(false);
  });
});

describe("the gates still hold", () => {
  it("refuses Contacted below the score gate", async () => {
    const l = await lead({ icpScore: 1 });
    const res = await applyInlineEdit(wsA, null, {
      leadId: l.id,
      field: "stage",
      value: "CONTACTED",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/cannot enter Contacted/);
    expect((await db().lead.findUniqueOrThrow({ where: { id: l.id } })).stage).toBe("RESEARCHED");
  });

  it("allows Contacted at or above the gate, and logs the move", async () => {
    const l = await lead({ icpScore: 4 });
    const res = await applyInlineEdit(wsA, ownerId, {
      leadId: l.id,
      field: "stage",
      value: "CONTACTED",
    });
    expect(res.ok).toBe(true);
    expect((await db().lead.findUniqueOrThrow({ where: { id: l.id } })).stage).toBe("CONTACTED");
    const activity = await db().activity.findFirstOrThrow({ where: { leadId: l.id } });
    expect(activity.type).toBe("stage_change");
    expect(activity.byUserId).toBe(ownerId);
  });

  it("refuses Qualified without the qualification answers", async () => {
    const l = await lead({ icpScore: 5 });
    const res = await applyInlineEdit(wsA, null, {
      leadId: l.id,
      field: "stage",
      value: "QUALIFIED",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/qualification/);
  });

  it("sends Disqualified back to the modal, because it needs a reason", async () => {
    const l = await lead({ icpScore: 5 });
    const res = await applyInlineEdit(wsA, null, {
      leadId: l.id,
      field: "stage",
      value: "DISQUALIFIED",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/reason/);
  });
});

describe("fields a cell may not touch", () => {
  it("refuses the ICP score, which has an audited override", async () => {
    const l = await lead({ icpScore: 1 });
    const res = await applyInlineEdit(wsA, null, { leadId: l.id, field: "icpScore", value: 5 });
    expect(res.ok).toBe(false);
    expect((await db().lead.findUniqueOrThrow({ where: { id: l.id } })).icpScore).toBe(1);
  });

  it("refuses a field that does not exist", async () => {
    const l = await lead();
    const res = await applyInlineEdit(wsA, null, {
      leadId: l.id,
      field: "passwordHash",
      value: "x",
    });
    expect(res.ok).toBe(false);
  });
});

describe("owner", () => {
  it("assigns a member of this workspace", async () => {
    const l = await lead();
    const res = await applyInlineEdit(wsA, null, {
      leadId: l.id,
      field: "ownerId",
      value: ownerId,
    });
    expect(res).toEqual({ ok: true, value: ownerId });
  });

  it("refuses someone who is not in this workspace", async () => {
    const l = await lead();
    const res = await applyInlineEdit(wsA, null, {
      leadId: l.id,
      field: "ownerId",
      value: "not-a-member",
    });
    expect(res.ok).toBe(false);
    expect((await db().lead.findUniqueOrThrow({ where: { id: l.id } })).ownerId).toBeNull();
  });

  it("clears the owner", async () => {
    const l = await lead({ ownerId });
    const res = await applyInlineEdit(wsA, null, { leadId: l.id, field: "ownerId", value: null });
    expect(res).toEqual({ ok: true, value: null });
  });
});

describe("custom fields", () => {
  it("stores a valid select value and refuses an invalid one", async () => {
    const created = await createFieldDef(wsA, null, {
      entity: "lead",
      label: "Segment",
      type: "SELECT",
      options: [{ value: "horeca", label: "HoReCa" }],
    });
    if (!created.ok) throw new Error(created.error);
    const l = await lead();

    expect(
      await applyInlineEdit(wsA, null, { leadId: l.id, field: "cf:segment", value: "horeca" }),
    ).toEqual({ ok: true, value: "horeca" });

    const bad = await applyInlineEdit(wsA, null, {
      leadId: l.id,
      field: "cf:segment",
      value: "aerospace",
    });
    expect(bad.ok).toBe(false);
    expect((await db().lead.findUniqueOrThrow({ where: { id: l.id } })).customFields).toEqual({
      segment: "horeca",
    });
  });

  it("coerces a number typed as a string", async () => {
    const created = await createFieldDef(wsA, null, {
      entity: "lead",
      label: "Seats",
      type: "NUMBER",
    });
    if (!created.ok) throw new Error(created.error);
    const l = await lead();
    const res = await applyInlineEdit(wsA, null, {
      leadId: l.id,
      field: "cf:seats",
      value: "42",
    });
    expect(res).toEqual({ ok: true, value: 42 });
  });
});

describe("tenancy", () => {
  it("cannot edit a lead in another workspace", async () => {
    const otherCompany = await prismaUnsafe.company.create({
      data: { workspaceId: wsB, name: "Bravo Kft" },
    });
    const other = await prismaUnsafe.lead.create({
      data: { workspaceId: wsB, companyId: otherCompany.id, contactName: "Theirs" },
    });
    const res = await applyInlineEdit(wsA, null, {
      leadId: other.id,
      field: "title",
      value: "hacked",
    });
    expect(res.ok).toBe(false);
    expect((await prismaUnsafe.lead.findUniqueOrThrow({ where: { id: other.id } })).title).toBeNull();
  });
});
