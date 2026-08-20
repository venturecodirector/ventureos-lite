import { guardRoute } from "@/lib/rate-limit-guard";
import { tryGetActiveContextOrThrow } from "@/lib/session";
import { storeMyAvatar } from "@/modules/users/profile";
import { MAX_AVATAR_BYTES } from "@/modules/users/profile-limits";

/**
 * Upload your own profile photo.
 *
 * A route rather than a Server Action because the body is a file: this keeps the
 * size ceiling enforceable BEFORE the bytes are read into memory, which a
 * FormData-parsing action cannot do.
 */
export async function POST(req: Request) {
  const limited = await guardRoute("api");
  if (limited) return limited;

  try {
    await tryGetActiveContextOrThrow();
  } catch {
    return Response.json({ ok: false, error: "Not signed in." }, { status: 401 });
  }

  // Declared length first — refuse a large upload before reading it.
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_AVATAR_BYTES) {
    return Response.json({ ok: false, error: "Keep the image under 2 MB." }, { status: 413 });
  }

  const contentType = req.headers.get("content-type") ?? "";
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await req.arrayBuffer());
  } catch {
    return Response.json({ ok: false, error: "Could not read the upload." }, { status: 400 });
  }
  if (bytes.byteLength > MAX_AVATAR_BYTES) {
    return Response.json({ ok: false, error: "Keep the image under 2 MB." }, { status: 413 });
  }

  const res = await storeMyAvatar(bytes, contentType);
  return Response.json(res, { status: res.ok ? 200 : 400 });
}
