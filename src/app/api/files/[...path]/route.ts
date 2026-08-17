import { guardRoute } from "@/lib/rate-limit-guard";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tryGetActiveContextOrThrow } from "@/lib/session";
import { resolveFileWorkspace } from "@/lib/file-owner";

/**
 * Authenticated file serving for the /data/files volume (CLAUDE.md: files
 * served through authenticated routes). Screenshots + audit PDFs for internal
 * users. Public share pages are served separately by slug, not through here.
 */
const FILES_DIR = process.env.FILES_DIR ?? "/data/files";

const CONTENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  // Accepted by the avatar downloader, so it has to be servable too.
  webp: "image/webp",
  zip: "application/zip",
  csv: "text/csv",
};

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  // The API-wide backstop (P6/2). Authenticated, so this is not an abuse
  // control so much as a guard against a runaway client asking for the same
  // PDF a thousand times a second.
  const limited = await guardRoute("api");
  if (limited) return limited;

  let workspaceId: string;
  try {
    ({ workspaceId } = await tryGetActiveContextOrThrow());
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }

  const { path } = await params;
  const rel = path.join("/");
  if (rel.includes("..")) return new Response("Bad path", { status: 400 });

  // Tenancy: serve only files owned by the caller's active workspace. Fail closed
  // (404) on unknown paths or cross-workspace requests — never leak existence.
  const owner = await resolveFileWorkspace(rel);
  if (owner === null || owner !== workspaceId) {
    return new Response("Not found", { status: 404 });
  }

  try {
    const buf = await readFile(join(FILES_DIR, rel));
    const ext = rel.split(".").pop()?.toLowerCase() ?? "";
    return new Response(new Uint8Array(buf), {
      headers: {
        "Content-Type": CONTENT_TYPES[ext] ?? "application/octet-stream",
        "Cache-Control": "private, max-age=60",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
