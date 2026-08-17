import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { prismaUnsafe } from "@/lib/db";
import { isShareExpired } from "@/modules/audit/share";
import { guardRoute } from "@/lib/rate-limit-guard";

/**
 * Screenshots for a PUBLIC audit report (P1/3a).
 *
 * The internal file route requires a session, and a prospect reading a shared
 * report has none. Access here is granted by the unguessable share slug and
 * nothing else: the slug is the capability.
 *
 * Deliberately narrow — it serves exactly the two screenshots belonging to the
 * audit behind a live share, by fixed name. It cannot be pointed at any other
 * path, so it is not a general file route wearing a public hat.
 */
const FILES_DIR = process.env.FILES_DIR ?? "/data/files";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string; kind: string }> },
) {
  // The slug is the capability, which means anyone holding a shared link can
  // fetch these images as fast as they like. Rate-limited per address (P6/2):
  // a report is meant to be read, not scraped.
  const limited = await guardRoute("auditShare");
  if (limited) return limited;

  const { slug, kind } = await params;
  if (kind !== "desktop" && kind !== "mobile") {
    return new Response("Not found", { status: 404 });
  }

  const share = await prismaUnsafe.auditShare.findUnique({
    where: { slug },
    select: { expiresAt: true, audit: { select: { screenshots: true } } },
  });
  // An expired share stops serving its images too, or the report leaks on
  // past its own lifetime through a direct image link.
  if (!share || isShareExpired(share.expiresAt, new Date())) {
    return new Response("Not found", { status: 404 });
  }

  const shots = (share.audit.screenshots ?? {}) as Record<string, string>;
  const rel = shots[kind];
  // Only ever a path this audit recorded, under the audits/ directory.
  if (!rel || !/^audits\/[A-Za-z0-9_-]+-(desktop|mobile)\.png$/.test(rel)) {
    return new Response("Not found", { status: 404 });
  }

  try {
    const buf = await readFile(join(FILES_DIR, rel));
    return new Response(new Uint8Array(buf), {
      headers: {
        "content-type": "image/png",
        // Immutable: a given audit's screenshot never changes.
        "cache-control": "public, max-age=86400, immutable",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
