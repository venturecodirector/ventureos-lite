import { tryGetActiveContextOrThrow } from "@/lib/session";
import { buildExtensionPackage } from "@/modules/extension/package";

/**
 * Download the capture extension as a zip (P1/1e).
 *
 * Authenticated: CLAUDE.md serves files through authenticated routes, and
 * while the extension holds no secrets, an anonymous download endpoint on the
 * app origin is a needless invitation. Built fresh on each request so the
 * download always matches the deployment.
 */
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    await tryGetActiveContextOrThrow();
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }

  const pkg = await buildExtensionPackage();
  return new Response(new Uint8Array(pkg.zip), {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${pkg.filename}"`,
      "content-length": String(pkg.zip.byteLength),
      // Rebuilt per request; a cached copy would defeat the point.
      "cache-control": "no-store",
      "x-extension-version": pkg.version,
      "x-extension-fingerprint": pkg.fingerprint,
    },
  });
}
