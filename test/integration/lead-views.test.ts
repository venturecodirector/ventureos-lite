import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prismaUnsafe } from "../../src/lib/db";
import {
  createView,
  deleteView,
  listViews,
  updateView,
} from "../../src/modules/leads/view-store";
import type { FilterSet } from "../../src/modules/leads/filters";

/**
 * Saved views against the real database (playbook-v2 P3/2).
 *
 * Two things need proving here that a pure test cannot: that a view never
 * crosses a workspace (CLAUDE.md hard rule #1), and that "personal" actually
 * means invisible to a colleague rather than merely unlisted in the UI.
 */
const NAMES = ["Views Alpha", "Views Bravo"];
const EMAILS = ["views-fanni@iso.test", "views-tamas@iso.test", "views-bob@iso.test"];

let wsA = "";
let wsB = "";
let fanni = "";
let tamas = "";
let bob = "";

const FILTERS: FilterSet = {
  match: "all",
  conditions: [
    { field: "stage", operator: "is_any_of", values: ["RESEARCHED", "CONTACTED"] },
    { field: "icpScore", operator: "gte", value: 4 },
  ],
};

async function clean() {
  const stale = await prismaUnsafe.workspace.findMany({
    where: { name: { in: NAMES } },
    select: { id: true },
  });
  const ids = stale.map((w) => w.id);
  if (ids.length) {
    await prismaUnsafe.savedView.deleteMany({ where: { workspaceId: { in: ids } } });
    await prismaUnsafe.membership.deleteMany({ where: { workspaceId: { in: ids } } });
    await prismaUnsafe.workspace.deleteMany({ where: { id: { in: ids } } });
  }
  await prismaUnsafe.user.deleteMany({ where: { email: { in: EMAILS } } });
}

beforeAll(async () => {
  await clean();
  wsA = (await prismaUnsafe.workspace.create({ data: { name: NAMES[0] } })).id;
  wsB = (await prismaUnsafe.workspace.create({ data: { name: NAMES[1] } })).id;

  const mk = async (email: string, name: string) =>
    (await prismaUnsafe.user.create({ data: { email, name, passwordHash: "x" } })).id;
  fanni = await mk(EMAILS[0], "Fanni");
  tamas = await mk(EMAILS[1], "Tamas");
  bob = await mk(EMAILS[2], "Bob");

  await prismaUnsafe.membership.create({ data: { userId: fanni, workspaceId: wsA, role: "BDR" } });
  await prismaUnsafe.membership.create({ data: { userId: tamas, workspaceId: wsA, role: "OWNER" } });
  await prismaUnsafe.membership.create({ data: { userId: bob, workspaceId: wsB, role: "OWNER" } });
});

afterAll(async () => {
  await clean();
});

describe("creating and listing views", () => {
  it("round-trips a filter set through the JSON column unchanged", async () => {
    const created = await createView(wsA, fanni, {
      name: "Hot researched",
      shared: false,
      filters: FILTERS,
      sort: { field: "icpScore", direction: "desc" },
      columns: ["contact", "company", "icpScore"],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const mine = await listViews(wsA, fanni);
    const found = mine.find((v) => v.id === created.view.id);
    expect(found).toBeDefined();
    expect(found!.filters).toEqual(FILTERS);
    expect(found!.sort).toEqual({ field: "icpScore", direction: "desc" });
    expect(found!.columns).toEqual(["contact", "company", "icpScore"]);
  });

  it("refuses a nameless view", async () => {
    const res = await createView(wsA, fanni, {
      name: "   ",
      shared: false,
      filters: FILTERS,
      sort: { field: "createdAt", direction: "desc" },
      columns: ["contact"],
    });
    expect(res.ok).toBe(false);
  });

  it("refuses a second view with the same name from the same person", async () => {
    const input = {
      name: "Duplicate",
      shared: false,
      filters: FILTERS,
      sort: { field: "createdAt", direction: "desc" } as const,
      columns: ["contact"],
    };
    expect((await createView(wsA, fanni, input)).ok).toBe(true);
    const second = await createView(wsA, fanni, input);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toMatch(/already/i);
  });

  it("lets two different people each keep a view of the same name", async () => {
    const input = {
      name: "My leads",
      shared: false,
      filters: FILTERS,
      sort: { field: "createdAt", direction: "desc" } as const,
      columns: ["contact"],
    };
    expect((await createView(wsA, fanni, input)).ok).toBe(true);
    expect((await createView(wsA, tamas, input)).ok).toBe(true);
  });
});

describe("personal vs shared", () => {
  it("hides a personal view from a colleague in the same workspace", async () => {
    const created = await createView(wsA, fanni, {
      name: "Fanni private",
      shared: false,
      filters: FILTERS,
      sort: { field: "createdAt", direction: "desc" },
      columns: ["contact"],
    });
    expect(created.ok).toBe(true);

    const tamasSees = await listViews(wsA, tamas);
    expect(tamasSees.some((v) => v.name === "Fanni private")).toBe(false);

    const fanniSees = await listViews(wsA, fanni);
    expect(fanniSees.some((v) => v.name === "Fanni private")).toBe(true);
  });

  it("shows a shared view to everyone in the workspace", async () => {
    await createView(wsA, fanni, {
      name: "Team pipeline",
      shared: true,
      filters: FILTERS,
      sort: { field: "createdAt", direction: "desc" },
      columns: ["contact"],
    });
    const tamasSees = await listViews(wsA, tamas);
    expect(tamasSees.some((v) => v.name === "Team pipeline")).toBe(true);
  });
});

describe("tenant isolation", () => {
  it("never shows workspace A's views in workspace B — shared or not", async () => {
    await createView(wsA, fanni, {
      name: "Alpha only",
      shared: true,
      filters: FILTERS,
      sort: { field: "createdAt", direction: "desc" },
      columns: ["contact"],
    });

    const inB = await listViews(wsB, bob);
    expect(inB.some((v) => v.name === "Alpha only")).toBe(false);
    // Even for a user who is a member of A, asking as B returns nothing of A's.
    const crossed = await listViews(wsB, fanni);
    expect(crossed).toHaveLength(0);
  });

  it("cannot update a view belonging to another workspace, even with its id", async () => {
    const created = await createView(wsA, fanni, {
      name: "Not yours",
      shared: true,
      filters: FILTERS,
      sort: { field: "createdAt", direction: "desc" },
      columns: ["contact"],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const res = await updateView(wsB, bob, "OWNER", created.view.id, { name: "Stolen" });
    expect(res.ok).toBe(false);

    const still = await prismaUnsafe.savedView.findUnique({ where: { id: created.view.id } });
    expect(still?.name).toBe("Not yours");
  });
});

describe("editing and deleting", () => {
  async function seedShared(name: string) {
    const res = await createView(wsA, fanni, {
      name,
      shared: true,
      filters: FILTERS,
      sort: { field: "createdAt", direction: "desc" },
      columns: ["contact"],
    });
    if (!res.ok) throw new Error(res.error);
    return res.view.id;
  }

  it("lets the creator rename their own view", async () => {
    const id = await seedShared("Rename me");
    const res = await updateView(wsA, fanni, "BDR", id, { name: "Renamed" });
    expect(res.ok).toBe(true);
    const row = await prismaUnsafe.savedView.findUnique({ where: { id } });
    expect(row?.name).toBe("Renamed");
  });

  it("lets an Owner curate a shared view they did not create", async () => {
    const id = await seedShared("Owner curates");
    const res = await updateView(wsA, tamas, "OWNER", id, { name: "Curated" });
    expect(res.ok).toBe(true);
  });

  it("refuses a BDR editing a colleague's view", async () => {
    const id = await seedShared("Hands off");
    // A second BDR in the same workspace.
    const other = await prismaUnsafe.user.create({
      data: { email: "views-other@iso.test", name: "Other", passwordHash: "x" },
    });
    await prismaUnsafe.membership.create({
      data: { userId: other.id, workspaceId: wsA, role: "BDR" },
    });
    try {
      const res = await updateView(wsA, other.id, "BDR", id, { name: "Nope" });
      expect(res.ok).toBe(false);
      const row = await prismaUnsafe.savedView.findUnique({ where: { id } });
      expect(row?.name).toBe("Hands off");
    } finally {
      await prismaUnsafe.membership.deleteMany({ where: { userId: other.id } });
      await prismaUnsafe.user.delete({ where: { id: other.id } });
    }
  });

  it("deletes a view its owner asks to delete", async () => {
    const id = await seedShared("Delete me");
    expect((await deleteView(wsA, fanni, "BDR", id)).ok).toBe(true);
    expect(await prismaUnsafe.savedView.findUnique({ where: { id } })).toBeNull();
  });

  it("refuses to delete someone else's view", async () => {
    const id = await seedShared("Keep me");
    const other = await prismaUnsafe.user.create({
      data: { email: "views-thief@iso.test", name: "Thief", passwordHash: "x" },
    });
    await prismaUnsafe.membership.create({
      data: { userId: other.id, workspaceId: wsA, role: "BDR" },
    });
    try {
      expect((await deleteView(wsA, other.id, "BDR", id)).ok).toBe(false);
      expect(await prismaUnsafe.savedView.findUnique({ where: { id } })).not.toBeNull();
    } finally {
      await prismaUnsafe.membership.deleteMany({ where: { userId: other.id } });
      await prismaUnsafe.user.delete({ where: { id: other.id } });
    }
  });
});

describe("stored filters are validated on the way in", () => {
  it("drops a condition whose operator does not belong to its field", async () => {
    const res = await createView(wsA, fanni, {
      name: "Sanitised",
      shared: false,
      // "stage between 3 and 5" is not a question anyone can answer.
      filters: {
        match: "all",
        conditions: [
          { field: "stage", operator: "is", value: "RESEARCHED" },
          { field: "stage", operator: "between", min: 3, max: 5 },
        ],
      } as FilterSet,
      sort: { field: "createdAt", direction: "desc" },
      columns: ["contact"],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.view.filters.conditions).toHaveLength(1);
  });

  it("keeps the lead column even when asked for a view without it", async () => {
    const res = await createView(wsA, fanni, {
      name: "No contact column",
      shared: false,
      filters: { match: "all", conditions: [] },
      sort: { field: "createdAt", direction: "desc" },
      columns: ["stage", "icpScore"],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.view.columns).toContain("contact");
  });
});
