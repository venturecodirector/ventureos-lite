import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

/**
 * Lead avatars captured from a profile page (P1/1e).
 *
 * Downloaded ONCE, server-side, and stored on our own volume. Two reasons not
 * to hotlink: the source URL is a signed CDN link that expires, so the card
 * would silently break; and rendering a remote image would leak every lead
 * card view to that CDN. Stored under avatars/<leadId>.<ext> so the file route
 * can attribute it, and so erasure knows exactly what to delete.
 */
const FILES_DIR = process.env.FILES_DIR ?? "/data/files";
const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 6000;

const ALLOWED: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/**
 * Fetch and store an avatar. Returns the relative path, or null for anything
 * that is not plainly a small image — never throws, because a missing picture
 * must not fail a capture.
 */
export async function storeAvatar(leadId: string, url: string): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // Same SSRF reasoning as the public audit: we fetch what we are handed.
  if (parsed.protocol !== "https:") return null;
  if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/i.test(parsed.hostname)) {
    return null;
  }

  try {
    const res = await fetch(parsed.toString(), { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;

    const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    const ext = ALLOWED[type];
    if (!ext) return null;

    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > MAX_BYTES) return null;

    const buf = Buffer.from(await res.arrayBuffer());
    // Re-check after download: content-length can lie or be absent.
    if (buf.byteLength === 0 || buf.byteLength > MAX_BYTES) return null;

    const rel = `avatars/${leadId}.${ext}`;
    await mkdir(join(FILES_DIR, "avatars"), { recursive: true });
    await writeFile(join(FILES_DIR, rel), buf);
    return rel;
  } catch {
    return null;
  }
}

/** Stable cache-buster so a re-captured avatar actually refreshes in the UI. */
export function avatarVersion(path: string, at: Date | null): string {
  return createHash("sha1").update(`${path}:${at?.getTime() ?? 0}`).digest("hex").slice(0, 8);
}
