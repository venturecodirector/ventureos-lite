import { readFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import { prismaUnsafe } from "@/lib/db";
import { brandFrom } from "@/modules/workspaces/brand";

/**
 * A workspace's logo, served publicly (audit-v2 item 6).
 *
 * PUBLIC on purpose, and safe to be: a logo is the most published thing a
 * company owns, and it has to render on the prospect-facing surfaces — share
 * page, acceptance page, booking page — where there is no session to
 * authenticate with, so the authenticated /api/files route cannot serve it.
 *
 * The path comes from the workspace row, never from the request, so this cannot
 * be turned into a reader for arbitrary files under FILES_DIR.
 */
const FILES_DIR = process.env.FILES_DIR ?? "/data/files";

const TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const { workspaceId } = await params;
  const ws = await prismaUnsafe.workspace.findUnique({
    where: { id: workspaceId },
    select: { brand: true },
  });
  const brand = brandFrom(ws?.brand);
  if (!brand.logoPath) return new Response("Not found", { status: 404 });

  // Belt and braces: the stored path is ours, but a normalised join keeps a
  // hand-edited row from escaping the files directory.
  const abs = normalize(join(FILES_DIR, brand.logoPath));
  if (!abs.startsWith(normalize(FILES_DIR))) {
    return new Response("Not found", { status: 404 });
  }

  try {
    const buf = await readFile(abs);
    const ext = brand.logoPath.slice(brand.logoPath.lastIndexOf(".")).toLowerCase();
    return new Response(new Uint8Array(buf), {
      headers: {
        "Content-Type": TYPES[ext] ?? "application/octet-stream",
        // Immutable: the URL is cache-busted on every upload, so a stale logo
        // is impossible and re-fetching per page view is waste.
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
