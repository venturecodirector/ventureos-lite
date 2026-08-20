import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { guardRoute } from "@/lib/rate-limit-guard";
import { prismaUnsafe } from "@/lib/db";
import { tryGetActiveContextOrThrow } from "@/lib/session";

/**
 * Serve a user's profile photo to their colleagues.
 *
 * ── WHY THIS IS NOT THE SHARED FILE ROUTE ──────────────────────────────────
 *
 * `/api/files/[...path]` authorises by asking which WORKSPACE owns a file. A
 * person's photo is owned by a person, and someone can be in two workspaces, so
 * that question has no single answer. The rule here is the one that actually
 * applies: you may see the photo of somebody you share the active workspace
 * with. Fails closed — an unknown user, someone outside the workspace, or a
 * missing file are all 404, so this cannot be used to probe for accounts.
 */
const FILES_DIR = process.env.FILES_DIR ?? "/data/files";
const TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

export async function GET(_req: Request, { params }: { params: Promise<{ userId: string }> }) {
  const limited = await guardRoute("api");
  if (limited) return limited;

  let workspaceId: string;
  let viewerId: string;
  try {
    ({ workspaceId, userId: viewerId } = await tryGetActiveContextOrThrow());
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }

  const { userId } = await params;
  const target = await prismaUnsafe.user.findUnique({
    where: { id: userId },
    select: { avatarPath: true },
  });
  if (!target?.avatarPath) return new Response("Not found", { status: 404 });

  if (userId !== viewerId) {
    const shared = await prismaUnsafe.membership.findUnique({
      where: { userId_workspaceId: { userId, workspaceId } },
      select: { userId: true },
    });
    if (!shared) return new Response("Not found", { status: 404 });
  }

  // Belt: the path is ours to build, but a traversal in stored data must not
  // become a file read.
  if (target.avatarPath.includes("..")) return new Response("Not found", { status: 404 });

  try {
    const buf = await readFile(join(FILES_DIR, target.avatarPath));
    const ext = target.avatarPath.split(".").pop()?.toLowerCase() ?? "";
    return new Response(new Uint8Array(buf), {
      headers: {
        "Content-Type": TYPES[ext] ?? "application/octet-stream",
        // Private: it is a photo of a person, behind a session.
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
