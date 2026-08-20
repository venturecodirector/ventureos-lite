import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { prismaUnsafe } from "../../src/lib/db";

/**
 * Deleting a share link, as opposed to revoking it.
 *
 * "Public pagesnél ne csak revoke hanem delete gomb is legyen."
 *
 * They are different acts. Revoke backdates the expiry and keeps the row, so who
 * opened the link and when survives. Delete takes it off the list for good —
 * which is what you want for a link made by mistake, or for a prospect who asked
 * to be forgotten. Because the row carries the ONLY record of the opens, the
 * audit entry has to copy them before the row goes, and that is the part worth
 * testing: a delete that quietly erased the evidence of a read would be worse
 * than no delete at all.
 */
const WS = "Share Delete Test";
const EMAIL = "share-delete@iso.test";
let wsId = "";
let ownerId = "";
let auditId = "";

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("@/lib/session", () => ({
  getActiveContext: async () => ({ workspaceId: wsId, userId: ownerId, sessionId: "s" }),
  tryGetActiveContext: async () => ({ workspaceId: wsId, userId: ownerId, sessionId: "s" }),
}));
vi.mock("@/lib/authz", () => ({
  requireOwner: async () => {},
  requireGrant: async () => {},
}));

async function clean() {
  const stale = await prismaUnsafe.workspace.findMany({ where: { name: WS }, select: { id: true } });
  const ids = stale.map((w) => w.id);
  if (ids.length) {
    await prismaUnsafe.auditShare.deleteMany({ where: { workspaceId: { in: ids } } });
    await prismaUnsafe.auditLog.deleteMany({ where: { workspaceId: { in: ids } } });
    await prismaUnsafe.auditResult.deleteMany({ where: { workspaceId: { in: ids } } });
    await prismaUnsafe.membership.deleteMany({ where: { workspaceId: { in: ids } } });
    await prismaUnsafe.workspace.deleteMany({ where: { id: { in: ids } } });
  }
  await prismaUnsafe.user.deleteMany({ where: { email: EMAIL } });
}

beforeAll(async () => {
  await clean();
  wsId = (await prismaUnsafe.workspace.create({ data: { name: WS } })).id;
  ownerId = (
    await prismaUnsafe.user.create({
      data: { email: EMAIL, name: "Share Owner", passwordHash: "x" },
    })
  ).id;
  await prismaUnsafe.membership.create({
    data: { workspaceId: wsId, userId: ownerId, role: "OWNER" },
  });
  auditId = (
    await prismaUnsafe.auditResult.create({
      data: {
        workspaceId: wsId,
        url: "https://share-delete.test",
        status: "done",
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    })
  ).id;
});

afterAll(async () => {
  await clean();
});

async function makeShare(slug: string, openCount = 0) {
  return prismaUnsafe.auditShare.create({
    data: {
      workspaceId: wsId,
      auditId,
      slug,
      openCount,
      firstOpenedAt: openCount > 0 ? new Date("2026-08-01T10:00:00Z") : null,
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
}

describe("deleting a share link", () => {
  it("removes the row", async () => {
    const { deleteAuditShare } = await import("../../src/modules/public-pages/actions");
    const share = await makeShare("del-plain-1");
    expect(await deleteAuditShare({ shareId: share.id })).toEqual({ ok: true });
    expect(await prismaUnsafe.auditShare.findUnique({ where: { id: share.id } })).toBeNull();
  });

  /** THE POINT: the row is the only record of the opens, so the log copies them. */
  it("writes the open count into the audit log before the row goes", async () => {
    const { deleteAuditShare } = await import("../../src/modules/public-pages/actions");
    const share = await makeShare("del-opened-2", 7);
    await deleteAuditShare({ shareId: share.id });

    const entry = await prismaUnsafe.auditLog.findFirst({
      where: { workspaceId: wsId, action: "public.share_deleted", entityId: share.id },
    });
    expect(entry, "no audit entry for a destructive action").not.toBeNull();
    const meta = entry!.meta as Record<string, unknown>;
    expect(meta.slug).toBe("del-opened-2");
    expect(meta.openCount).toBe(7);
    expect(meta.firstOpenedAt).toBe("2026-08-01T10:00:00.000Z");
    expect(entry!.actorUserId).toBe(ownerId);
  });

  it("refuses an unknown share instead of throwing", async () => {
    const { deleteAuditShare } = await import("../../src/modules/public-pages/actions");
    expect(await deleteAuditShare({ shareId: "nope" })).toEqual({
      ok: false,
      error: "Share not found.",
    });
    expect(await deleteAuditShare({})).toEqual({ ok: false, error: "Unknown share." });
  });

  /** Revoke still keeps the row — the two buttons must not do the same thing. */
  it("revoke keeps the row and its opens", async () => {
    const { revokeAuditShare } = await import("../../src/modules/public-pages/actions");
    const share = await makeShare("del-revoked-3", 4);
    expect(await revokeAuditShare({ shareId: share.id })).toEqual({ ok: true });
    const after = await prismaUnsafe.auditShare.findUnique({ where: { id: share.id } });
    expect(after, "revoke deleted the row").not.toBeNull();
    expect(after!.openCount).toBe(4);
    expect(after!.expiresAt.getTime()).toBeLessThan(Date.now());
  });
});
