import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prismaUnsafe, getWorkspaceClient } from "@/lib/db";
import { broadSearch } from "@/modules/search/broad";

/**
 * playbook-v2 P3/1 — the tolerant search pass, against a real database.
 *
 * Two things are being proved. That accents and typos actually find the row —
 * the reason the pass exists — and that it CANNOT see another workspace, which
 * matters because this pass reads broadly rather than filtering in SQL. It goes
 * through the guarded client precisely so the guard does that job; this asserts
 * the guard is really in the path.
 */
const RUN = Math.random().toString(36).slice(2, 8);
/** Unique per run: tax_id carries a unique constraint per workspace. */
const TAX_CORE = `1${String(Date.now()).slice(-7)}`;
const TAX_ID = `${TAX_CORE}-1-42`;
let workspaceA = "";
let workspaceB = "";
const cleanup = { companies: [] as string[], leads: [] as string[], workspaces: [] as string[] };

beforeAll(async () => {
  const a = await prismaUnsafe.workspace.findFirst({
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  workspaceA = a!.id;

  const b = await prismaUnsafe.workspace.create({
    data: { name: `search-b-${RUN}` },
    select: { id: true },
  });
  workspaceB = b.id;
  cleanup.workspaces.push(b.id);

  const dbA = getWorkspaceClient(workspaceA);
  const company = await dbA.company.create({
    data: {
      workspaceId: workspaceA,
      name: `Kőbányai Fogászat ${RUN}`,
      domain: `kobanyai-${RUN}.hu`,
      taxId: TAX_ID,
      city: "Budapest",
    },
    select: { id: true },
  });
  cleanup.companies.push(company.id);
  const lead = await dbA.lead.create({
    data: {
      workspaceId: workspaceA,
      companyId: company.id,
      source: "PROSPECTOR",
      stage: "RESEARCHED",
      contactName: `Nagy Örs ${RUN}`,
      email: `ors-${RUN}@kobanyai-${RUN}.hu`,
    },
    select: { id: true },
  });
  cleanup.leads.push(lead.id);

  // The same distinctive name in the OTHER workspace. If the guard is not in
  // the path, a search from A will surface it.
  const dbB = getWorkspaceClient(workspaceB);
  const companyB = await dbB.company.create({
    data: {
      workspaceId: workspaceB,
      name: `Kőbányai Fogászat ${RUN}`,
      domain: `kobanyai-${RUN}.hu`,
    },
    select: { id: true },
  });
  cleanup.companies.push(companyB.id);
});

afterAll(async () => {
  await prismaUnsafe.lead.deleteMany({ where: { id: { in: cleanup.leads } } });
  await prismaUnsafe.company.deleteMany({ where: { id: { in: cleanup.companies } } });
  await prismaUnsafe.workspace.deleteMany({ where: { id: { in: cleanup.workspaces } } });
  await prismaUnsafe.$disconnect();
});

describe("accents", () => {
  it("finds an accented company from an unaccented query", async () => {
    const hits = await broadSearch(getWorkspaceClient(workspaceA), `Kobanyai ${RUN}`);
    expect(hits.some((h) => h.title.includes("Kőbányai"))).toBe(true);
  });

  it("finds an accented contact name from an unaccented query", async () => {
    const hits = await broadSearch(getWorkspaceClient(workspaceA), `Nagy Ors ${RUN}`);
    expect(hits.some((h) => h.kind === "lead")).toBe(true);
  });
});

describe("typos", () => {
  it("finds a transposed company name", async () => {
    // "Kobnayai" — two letters swapped, the most common real mistype.
    const hits = await broadSearch(getWorkspaceClient(workspaceA), "Kobnayai");
    expect(hits.some((h) => h.title.includes("Kőbányai"))).toBe(true);
  });

  it("does not invent hits for an unrelated query", async () => {
    const hits = await broadSearch(getWorkspaceClient(workspaceA), "zzzqqq");
    expect(hits).toEqual([]);
  });
});

describe("tax id", () => {
  it("matches digits against a stored dashed id", async () => {
    const hits = await broadSearch(getWorkspaceClient(workspaceA), TAX_CORE);
    expect(hits.some((h) => h.kind === "company")).toBe(true);
  });

  it("matches a pasted dashed id too", async () => {
    const hits = await broadSearch(getWorkspaceClient(workspaceA), TAX_ID);
    expect(hits.some((h) => h.kind === "company")).toBe(true);
  });
});

describe("tenancy", () => {
  it("never returns the other workspace's row, even for an identical name", async () => {
    // The whole reason this pass reads through the guarded client instead of
    // raw SQL: the guard is the only thing scoping it, so this asserts the
    // guard is genuinely in the path.
    const fromA = await broadSearch(getWorkspaceClient(workspaceA), `Kobanyai ${RUN}`);
    const idsFromA = fromA.map((h) => h.id);

    const dbB = getWorkspaceClient(workspaceB);
    const bCompany = await dbB.company.findFirst({
      where: { name: { contains: RUN } },
      select: { id: true },
    });
    expect(bCompany).not.toBeNull();
    expect(idsFromA).not.toContain(bCompany!.id);
  });

  it("finds it when searching from the workspace that owns it", async () => {
    const fromB = await broadSearch(getWorkspaceClient(workspaceB), `Kobanyai ${RUN}`);
    expect(fromB.some((h) => h.kind === "company")).toBe(true);
  });
});
