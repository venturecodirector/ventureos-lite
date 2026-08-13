import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prismaUnsafe } from "../../src/lib/db";
import { createCaptureToken, resolveCaptureToken, hashToken } from "../../src/modules/capture/tokens";

/**
 * P1/1e — the credential the extension uses. It authenticates writes into a
 * workspace from a page LinkedIn also controls, so the failure modes matter
 * more than the happy path.
 */
const EMAIL = "capture-token-user@ventureco.test";
let userId = "";
let workspaceId = "";

beforeEach(async () => {
  const ws = await prismaUnsafe.workspace.findFirst({ select: { id: true } });
  workspaceId = ws!.id;
  const user = await prismaUnsafe.user.upsert({
    where: { email: EMAIL },
    update: {},
    create: { email: EMAIL, name: "Capture Tester", passwordHash: "x" },
  });
  userId = user.id;
  await prismaUnsafe.captureToken.deleteMany({ where: { userId } });
});

afterAll(async () => {
  await prismaUnsafe.captureToken.deleteMany({ where: { userId } });
  await prismaUnsafe.user.deleteMany({ where: { email: EMAIL } });
});

describe("capture tokens", () => {
  it("resolves a freshly issued token to its user and workspace", async () => {
    const { token } = await createCaptureToken(userId, workspaceId, "laptop");
    const id = await resolveCaptureToken(`Bearer ${token}`);
    expect(id).toMatchObject({ userId, workspaceId });
  });

  it("stores only a hash, never the token", async () => {
    const { token } = await createCaptureToken(userId, workspaceId);
    const row = await prismaUnsafe.captureToken.findFirst({ where: { userId } });
    expect(row!.tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it("accepts the bare token as well as a Bearer header", async () => {
    const { token } = await createCaptureToken(userId, workspaceId);
    expect(await resolveCaptureToken(token)).not.toBeNull();
  });

  it("refuses a revoked token", async () => {
    const { token, id } = await createCaptureToken(userId, workspaceId);
    await prismaUnsafe.captureToken.update({
      where: { id },
      data: { revokedAt: new Date() },
    });
    expect(await resolveCaptureToken(token)).toBeNull();
  });

  it.each([null, undefined, "", "Bearer ", "garbage", "vos_cap_short"])(
    "refuses malformed credential %s",
    async (value) => {
      expect(await resolveCaptureToken(value as string | null)).toBeNull();
    },
  );

  it("refuses a token that was never issued", async () => {
    expect(await resolveCaptureToken("vos_cap_" + "a".repeat(32))).toBeNull();
  });

  it("records last use so a stale token is visible in Settings", async () => {
    const { token, id } = await createCaptureToken(userId, workspaceId);
    expect((await prismaUnsafe.captureToken.findUnique({ where: { id } }))!.lastUsedAt).toBeNull();
    await resolveCaptureToken(token);
    // The stamp is fire-and-forget; give it a tick to land.
    await new Promise((r) => setTimeout(r, 120));
    expect((await prismaUnsafe.captureToken.findUnique({ where: { id } }))!.lastUsedAt).not.toBeNull();
  });
});
