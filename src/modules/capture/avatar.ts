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

export interface AvatarResult {
  path: string | null;
  /** Why there is no path. Short, safe to show a user, never contains the URL. */
  reason: string | null;
}

/**
 * Fetch and store an avatar.
 *
 * Never throws — a missing picture must not fail a capture. But it no longer
 * fails SILENTLY: every rejection returns a reason. This function had eight
 * separate `return null` paths and no logging, so when captured photos stopped
 * appearing there was no way to tell which one fired without adding print
 * statements to production. The reason travels back to the popup instead.
 */
export async function storeAvatar(leadId: string, url: string): Promise<AvatarResult> {
  const no = (reason: string): AvatarResult => ({ path: null, reason });

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return no("the photo address was not a URL");
  }
  // Same SSRF reasoning as the public audit: we fetch what we are handed.
  // The `data:` lazy-load placeholder is now refused a layer earlier, by the
  // capture body schema, so that a capture never claims a photo it does not
  // have. This check stays as the backstop it always was: `storeAvatar` must be
  // safe on its own terms, whatever hands it a URL.
  if (parsed.protocol !== "https:") {
    return no(`the photo was a ${parsed.protocol.replace(":", "")} address, not https`);
  }
  if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/i.test(parsed.hostname)) {
    return no("the photo pointed at a private address");
  }

  try {
    const res = await fetch(parsed.toString(), { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return no(`the photo host answered ${res.status}`);

    const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    const ext = ALLOWED[type];
    if (!ext) return no(`the photo came back as ${type || "an unknown type"}`);

    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > MAX_BYTES) return no("the photo was larger than 2 MB");

    const buf = Buffer.from(await res.arrayBuffer());
    // Re-check after download: content-length can lie or be absent.
    if (buf.byteLength === 0) return no("the photo downloaded empty");
    if (buf.byteLength > MAX_BYTES) return no("the photo was larger than 2 MB");

    const rel = `avatars/${leadId}.${ext}`;
    await mkdir(join(FILES_DIR, "avatars"), { recursive: true });
    await writeFile(join(FILES_DIR, rel), buf);
    return { path: rel, reason: null };
  } catch (e) {
    // Say WHICH failure it was.
    //
    // "the photo could not be fetched" was every network error collapsed into
    // one sentence, and it cost a whole debugging round: the host was
    // reachable, DNS resolved, a plain request to the same CDN returned fine,
    // and the message ruled none of that out. `fetch` in Node reports the real
    // reason on `cause` — ENOTFOUND, ECONNRESET, a TLS failure — and throwing
    // it away is what made a five-second diagnosis into a redeploy.
    //
    // The code, never the URL: these are signed CDN links that identify a
    // person, and this string is shown in a popup and stored in an activity.
    const err = e as { name?: string; message?: string; cause?: { code?: string; message?: string } };
    const code = err?.cause?.code ?? err?.name ?? "";
    if (code === "TimeoutError" || code === "AbortError") return no("the photo host timed out");
    const detail = code || err?.cause?.message?.slice(0, 40) || err?.message?.slice(0, 40);
    // Logged with the host so a recurring CDN problem is visible in the logs,
    // where the full address is not.
    console.warn(`[avatar] fetch failed for ${parsed.hostname}: ${detail ?? "unknown"}`);
    return no(`the photo could not be fetched (${detail || "unknown"})`);
  }
}

/** Stable cache-buster so a re-captured avatar actually refreshes in the UI. */
export function avatarVersion(path: string, at: Date | null): string {
  return createHash("sha1").update(`${path}:${at?.getTime() ?? 0}`).digest("hex").slice(0, 8);
}
