import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient, Prisma } from "@prisma/client";
import { prismaUnsafe } from "../../src/lib/db";
import { appUserDatabaseUrl } from "../../src/lib/rls";

/**
 * Row-level security, proved WITHOUT the tenant guard (CLAUDE.md hard rule #1).
 *
 * The guard has its own tests and they pass. That is exactly why this file
 * exists: a second belt is only worth having if it holds when the first one is
 * removed, so every query below is made through a bare client with no guard
 * extension at all — deliberately the shape of the bug this layer defends
 * against, an application query that forgot to scope itself.
 *
 * Before this was written the policies were applied on every deploy and did
 * nothing: the app connects as the database owner, and a superuser bypasses RLS
 * whatever FORCE says. Measured against production first — as the app's own
 * role, `select count(*) from leads` returned 73; as `app_user` with no session
 * variable, 0.
 */
const NAMES = ["RLS Alpha", "RLS Bravo"];
let wsA = "";
let wsB = "";
/** A bare client on the restricted role: no tenant guard, no scoping at all. */
let bare: PrismaClient;

const isPostgres = (process.env.DB_FLAVOR ?? "postgres") === "postgres";

async function clean() {
  const stale = await prismaUnsafe.workspace.findMany({
    where: { name: { in: NAMES } },
    select: { id: true },
  });
  const ids = stale.map((w) => w.id);
  if (!ids.length) return;
  for (const t of ["lead", "company"] as const) {
    // @ts-expect-error dynamic model access
    await prismaUnsafe[t].deleteMany({ where: { workspaceId: { in: ids } } });
  }
  await prismaUnsafe.workspace.deleteMany({ where: { id: { in: ids } } });
}

beforeAll(async () => {
  if (!isPostgres) return;
  // Policies come from test/global-setup.ts — applied once for the whole run,
  // because two files applying them in parallel raced each other's queries.
  await clean();
  wsA = (await prismaUnsafe.workspace.create({ data: { name: NAMES[0] } })).id;
  wsB = (await prismaUnsafe.workspace.create({ data: { name: NAMES[1] } })).id;
  await prismaUnsafe.company.create({ data: { workspaceId: wsA, name: "Alpha Kft." } });
  await prismaUnsafe.company.create({ data: { workspaceId: wsB, name: "Bravo Kft." } });
  await prismaUnsafe.lead.create({ data: { workspaceId: wsA, contactName: "Alpha Anna" } });
  await prismaUnsafe.lead.create({ data: { workspaceId: wsB, contactName: "Bravo Bea" } });

  bare = new PrismaClient({ datasources: { db: { url: appUserDatabaseUrl() } } });
});

afterAll(async () => {
  if (!isPostgres) return;
  await bare?.$disconnect();
  await clean();
});

/** Run one query with the workspace declared, exactly as the extension does. */
async function asWorkspace<T>(
  workspaceId: string,
  run: () => Prisma.PrismaPromise<T>,
): Promise<T> {
  const [, result] = await bare.$transaction([
    bare.$executeRaw`SELECT set_config('app.current_workspace', ${workspaceId}, TRUE)`,
    run(),
  ]);
  return result;
}

describe.skipIf(!isPostgres)("row-level security", () => {
  it("shows a workspace its own rows", async () => {
    const leads = await asWorkspace(wsA, () => bare.lead.findMany({ where: {} }));
    expect(leads.map((l) => l.contactName)).toEqual(["Alpha Anna"]);
  });

  /**
   * THE ONE THAT MATTERS. An unscoped query — the bug — returns the other
   * workspace's row today, because the guard is what stops it. Under RLS the
   * database refuses on its own.
   */
  it("hides another workspace's rows from an UNSCOPED query", async () => {
    const leads = await asWorkspace(wsA, () => bare.lead.findMany({ where: {} }));
    expect(leads).toHaveLength(1);
    expect(leads.map((l) => l.contactName)).not.toContain("Bravo Bea");
  });

  it("refuses a direct read of another workspace's row by id", async () => {
    const bravo = await prismaUnsafe.lead.findFirst({ where: { workspaceId: wsB } });
    const found = await asWorkspace(wsA, () =>
      bare.lead.findUnique({ where: { id: bravo!.id } }),
    );
    expect(found).toBeNull();
  });

  it("refuses to WRITE a row into another workspace", async () => {
    await expect(
      asWorkspace(wsA, () =>
        bare.lead.create({ data: { workspaceId: wsB, contactName: "Smuggled" } }),
      ),
    ).rejects.toThrow();
    // And nothing landed.
    expect(
      await prismaUnsafe.lead.count({ where: { workspaceId: wsB, contactName: "Smuggled" } }),
    ).toBe(0);
  });

  it("refuses to update another workspace's row", async () => {
    const bravo = await prismaUnsafe.lead.findFirst({ where: { workspaceId: wsB } });
    const updated = await asWorkspace(wsA, () =>
      bare.lead.updateMany({ where: { id: bravo!.id }, data: { contactName: "Overwritten" } }),
    );
    expect(updated.count).toBe(0);
    const after = await prismaUnsafe.lead.findUnique({ where: { id: bravo!.id } });
    expect(after!.contactName).toBe("Bravo Bea");
  });

  it("refuses to delete another workspace's row", async () => {
    const bravo = await prismaUnsafe.lead.findFirst({ where: { workspaceId: wsB } });
    const deleted = await asWorkspace(wsA, () =>
      bare.lead.deleteMany({ where: { id: bravo!.id } }),
    );
    expect(deleted.count).toBe(0);
    expect(await prismaUnsafe.lead.count({ where: { id: bravo!.id } })).toBe(1);
  });

  /**
   * With no workspace declared the answer is nothing — fail closed. This is
   * what a query that escaped the guard entirely would hit.
   */
  it("shows nothing at all when no workspace is declared", async () => {
    expect(await bare.lead.findMany({ where: {} })).toHaveLength(0);
    expect(await bare.company.findMany({ where: {} })).toHaveLength(0);
  });

  /**
   * Connections are pooled: a session-level setting would leak to whichever
   * request picked the connection up next, which is the very bug this layer
   * exists to catch. `set_config(..., TRUE)` is transaction-local.
   */
  it("does not leak the workspace to the next query on the same connection", async () => {
    await asWorkspace(wsA, () => bare.lead.findMany({ where: {} }));
    expect(await bare.lead.findMany({ where: {} })).toHaveLength(0);
  });

  it("still lets the owner connection through — that is the escape hatch", async () => {
    expect(await prismaUnsafe.lead.count({ where: { workspaceId: { in: [wsA, wsB] } } })).toBe(2);
  });
});
