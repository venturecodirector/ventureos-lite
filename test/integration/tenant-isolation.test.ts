import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { getWorkspaceClient, prismaUnsafe } from "../../src/lib/db";

/**
 * Tenancy isolation proof (CLAUDE.md hard rule #1).
 *
 *   - The Prisma tenant guard scopes every business-table query to the session
 *     workspace. Proven on BOTH flavors.
 *   - On Postgres, RLS keyed to workspace membership blocks cross-workspace
 *     reads at the DB level even when the app layer is bypassed. Proven via a
 *     non-superuser connection with the session GUCs set.
 *
 * "Do not proceed past a red isolation test."
 */

const FLAVOR = process.env.DB_FLAVOR ?? "postgres";

let wsA = "";
let wsB = "";
let userA = "";
let userB = "";
let companyA = "";
let companyB = "";

const FIXTURE_EMAILS = ["alice@alpha.test", "bob@bravo.test"];
const FIXTURE_WORKSPACES = ["Alpha Co", "Bravo Co"];

async function cleanFixtures() {
  const staleWs = await prismaUnsafe.workspace.findMany({
    where: { name: { in: FIXTURE_WORKSPACES } },
    select: { id: true },
  });
  const staleWsIds = staleWs.map((w) => w.id);
  if (staleWsIds.length) {
    await prismaUnsafe.company.deleteMany({
      where: { workspaceId: { in: staleWsIds } },
    });
    // deleting a workspace/user cascades its memberships (FK onDelete: Cascade)
    await prismaUnsafe.workspace.deleteMany({ where: { id: { in: staleWsIds } } });
  }
  await prismaUnsafe.user.deleteMany({ where: { email: { in: FIXTURE_EMAILS } } });
}

beforeAll(async () => {
  // Only manage THIS test's fixtures — never touch seed/other data.
  await cleanFixtures();

  const a = await prismaUnsafe.workspace.create({ data: { name: "Alpha Co" } });
  const b = await prismaUnsafe.workspace.create({ data: { name: "Bravo Co" } });
  wsA = a.id;
  wsB = b.id;

  const ua = await prismaUnsafe.user.create({
    data: { email: "alice@alpha.test", name: "Alice", passwordHash: "x" },
  });
  const ub = await prismaUnsafe.user.create({
    data: { email: "bob@bravo.test", name: "Bob", passwordHash: "x" },
  });
  userA = ua.id;
  userB = ub.id;

  // Bob is a member of workspace B ONLY.
  await prismaUnsafe.membership.create({
    data: { userId: userA, workspaceId: wsA, role: "OWNER" },
  });
  await prismaUnsafe.membership.create({
    data: { userId: userB, workspaceId: wsB, role: "BDR" },
  });

  companyA = (
    await prismaUnsafe.company.create({
      data: { workspaceId: wsA, name: "Alpha Client Kft." },
    })
  ).id;
  companyB = (
    await prismaUnsafe.company.create({
      data: { workspaceId: wsB, name: "Bravo Client Kft." },
    })
  ).id;
});

afterAll(async () => {
  await cleanFixtures();
  await prismaUnsafe.$disconnect();
});

describe("Prisma tenant guard (both flavors)", () => {
  it("findMany returns only the session workspace's rows", async () => {
    const db = getWorkspaceClient(wsB);
    const rows = await db.company.findMany();
    expect(rows.map((r) => r.id)).toEqual([companyB]);
  });

  it("count is scoped to the session workspace", async () => {
    const db = getWorkspaceClient(wsB);
    expect(await db.company.count()).toBe(1);
  });

  it("cannot read another workspace's row by id", async () => {
    const db = getWorkspaceClient(wsB);
    expect(await db.company.findUnique({ where: { id: companyA } })).toBeNull();
    expect(await db.company.findFirst({ where: { id: companyA } })).toBeNull();
  });

  it("cannot update another workspace's row", async () => {
    const db = getWorkspaceClient(wsB);
    await expect(
      db.company.update({ where: { id: companyA }, data: { name: "pwned" } }),
    ).rejects.toThrow();
    const untouched = await prismaUnsafe.company.findUnique({
      where: { id: companyA },
    });
    expect(untouched?.name).toBe("Alpha Client Kft.");
  });

  it("cannot delete another workspace's row", async () => {
    const db = getWorkspaceClient(wsB);
    await expect(
      db.company.delete({ where: { id: companyA } }),
    ).rejects.toThrow();
    expect(
      await prismaUnsafe.company.findUnique({ where: { id: companyA } }),
    ).not.toBeNull();
  });

  it("create forces the session workspace, ignoring an injected workspaceId", async () => {
    const db = getWorkspaceClient(wsB);
    const created = await db.company.create({
      // Attempt to smuggle a row into workspace A.
      data: { name: "Injection Attempt", workspaceId: wsA },
    });
    expect(created.workspaceId).toBe(wsB);
    await prismaUnsafe.company.delete({ where: { id: created.id } });
  });

  it("fails closed when no workspace is provided", () => {
    expect(() => getWorkspaceClient("")).toThrow();
  });
});

describe.runIf(FLAVOR === "postgres")("Postgres RLS (DB-level, keyed to membership)", () => {
  let appUser: PrismaClient;

  beforeAll(async () => {
    const { applyRls, appUserDatabaseUrl } = await import(
      "../../src/lib/rls"
    );
    await applyRls(prismaUnsafe);
    appUser = new PrismaClient({
      datasources: { db: { url: appUserDatabaseUrl() } },
    });
  });

  afterAll(async () => {
    await appUser?.$disconnect();
  });

  async function selectCompaniesAs(
    currentUser: string,
    currentWorkspace: string,
  ): Promise<Array<{ id: string }>> {
    // set_config(..., true) is transaction-local; run the SELECT in the same tx.
    const [, rows] = await appUser.$transaction([
      appUser.$executeRaw`SELECT set_config('app.current_user', ${currentUser}, true), set_config('app.current_workspace', ${currentWorkspace}, true)`,
      appUser.$queryRaw<Array<{ id: string }>>`SELECT id FROM companies`,
    ]);
    return rows;
  }

  it("blocks reading workspace A while acting as a B-only member", async () => {
    const rows = await selectCompaniesAs(userB, wsA);
    expect(rows).toEqual([]);
  });

  it("allows reading the member's own workspace", async () => {
    const rows = await selectCompaniesAs(userB, wsB);
    expect(rows.map((r) => r.id)).toEqual([companyB]);
  });
});
