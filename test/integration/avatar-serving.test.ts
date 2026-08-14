import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prismaUnsafe } from "../../src/lib/db";
import { resolveFileWorkspace } from "../../src/lib/file-owner";

/**
 * Serving a captured avatar (P1/1e).
 *
 * The capture route downloaded the photo and wrote `avatarPath` from the day the
 * extension shipped, but `avatars/` was never a case in the owner resolver — so
 * the authenticated file route fell through to its fail-closed default and 404'd
 * every avatar. Nothing caught it because nothing rendered an avatar either: the
 * two halves were missing in a way that hid each other.
 *
 * The resolver is also the tenancy boundary for these files, so the
 * cross-workspace case is tested, not assumed.
 */
const OWNER = "avatar-owner@ventureco.test";
let workspaceId = "";
let otherWorkspaceId = "";
let leadId = "";

beforeAll(async () => {
  const ws = await prismaUnsafe.workspace.findFirst({ select: { id: true } });
  workspaceId = ws!.id;

  const other = await prismaUnsafe.workspace.create({
    data: { name: "Avatar Neighbour" },
    select: { id: true },
  });
  otherWorkspaceId = other.id;

  const lead = await prismaUnsafe.lead.create({
    data: {
      workspaceId,
      contactName: OWNER,
      source: "LINKEDIN",
      stage: "RESEARCHED",
      signals: [],
      avatarPath: "avatars/avatar-test-lead.jpg",
    },
    select: { id: true },
  });
  leadId = lead.id;
});

afterAll(async () => {
  await prismaUnsafe.lead.deleteMany({ where: { id: leadId } });
  await prismaUnsafe.workspace.deleteMany({ where: { id: otherWorkspaceId } });
});

describe("avatar files resolve to the workspace that captured them", () => {
  it("resolves a stored avatar path to its owning workspace", async () => {
    const owner = await resolveFileWorkspace("avatars/avatar-test-lead.jpg");
    expect(owner).toBe(workspaceId);
  });

  it("does not resolve to a workspace that does not own the lead", async () => {
    const owner = await resolveFileWorkspace("avatars/avatar-test-lead.jpg");
    expect(owner).not.toBe(otherWorkspaceId);
  });

  it("fails closed on an avatar path no lead claims", async () => {
    // A guessed filename must be indistinguishable from a missing one.
    const owner = await resolveFileWorkspace("avatars/not-a-real-lead.jpg");
    expect(owner).toBeNull();
  });
});
