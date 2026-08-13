import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { prismaUnsafe } from "@/lib/db";

/**
 * Screenshots for a SELF-SERVE audit teaser (P12/1b).
 *
 * The visitor who ran this audit has no session and no share slug — the
 * capability is the public-audit id they were just handed, which is a cuid
 * they cannot guess for anyone else's run.
 *
 * Deliberately narrow, like the share-page equivalent: it serves exactly the
 * two screenshots belonging to one finished audit, by fixed name, validated
 * against the path the worker recorded. It cannot be pointed anywhere else.
 */
const FILES_DIR = process.env.FILES_DIR ?? "/data/files";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; kind: string }> },
) {
  const { id, kind } = await params;
  if (kind !== "desktop" && kind !== "mobile") {
    return new Response("Not found", { status: 404 });
  }

  const pa = await prismaUnsafe.publicAudit.findUnique({
    where: { id },
    select: { status: true, audit: { select: { screenshots: true } } },
  });
  // Only a finished run has anything to show, and a blocked one must not leak
  // that it exists.
  if (!pa || pa.status !== "done" || !pa.audit) {
    return new Response("Not found", { status: 404 });
  }

  const shots = (pa.audit.screenshots ?? {}) as Record<string, string>;
  const rel = shots[kind];
  if (!rel || !/^audits\/[A-Za-z0-9_-]+-(desktop|mobile)\.png$/.test(rel)) {
    return new Response("Not found", { status: 404 });
  }

  try {
    const buf = await readFile(join(FILES_DIR, rel));
    return new Response(new Uint8Array(buf), {
      headers: {
        "content-type": "image/png",
        "cache-control": "public, max-age=86400, immutable",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
