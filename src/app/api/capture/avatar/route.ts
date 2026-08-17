import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getWorkspaceClient } from "@/lib/db";
import { takeRateLimit } from "@/lib/rate-limit";
import { RATE_LIMITS, tooManyRequests } from "@/lib/rate-limit-policy";
import { resolveCaptureToken } from "@/modules/capture/tokens";
import { inspectImage, MAX_AVATAR_BYTES } from "@/modules/capture/image";

/**
 * The profile photo, uploaded as BYTES by the extension.
 *
 * Separate from /api/capture on purpose. The capture is a small JSON document
 * and stays that way; an image is a different kind of payload with a different
 * size ceiling and a different failure mode, and mixing base64 into the capture
 * body would make one request that either wholly succeeds or wholly fails —
 * losing a whole lead because a picture was too big.
 *
 * WHY THE BYTES COME FROM THE EXTENSION AT ALL: LinkedIn's avatar URLs are
 * signed and time-limited, and the CDN refuses a request without the session
 * that minted them. Every capture used to report "the photo could not be
 * fetched" while the picture sat visibly on screen — the URL was right, the
 * fetcher was the wrong machine. The extension fetches it in the tab, crops and
 * re-encodes it on a canvas, and sends the result here.
 *
 * Which makes this endpoint the trust boundary. It believes nothing it is told:
 * the declared content type is ignored in favour of the actual header bytes, and
 * the file is refused unless it is a real JPEG, PNG or WebP of plausible size
 * and dimensions.
 */
export const dynamic = "force-dynamic";

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const FILES_DIR = process.env.FILES_DIR ?? "/data/files";

export async function POST(req: Request): Promise<Response> {
  const identity = await resolveCaptureToken(req.headers.get("authorization"));
  if (!identity) return json({ error: "unauthorized" }, 401);

  const rate = await takeRateLimit(
    `${RATE_LIMITS.capture.bucket}:avatar:${identity.tokenId}`,
    RATE_LIMITS.capture,
  );
  if (!rate.allowed) return tooManyRequests(rate.resetAtMs, "Too many uploads. Slow down.");

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ error: "expected_multipart_form_data" }, 400);
  }

  const leadId = String(form.get("leadId") ?? "");
  if (!leadId) return json({ error: "missing_lead_id" }, 400);

  const file = form.get("photo");
  if (!(file instanceof Blob)) return json({ error: "missing_photo_part" }, 400);
  if (file.size > MAX_AVATAR_BYTES) return json({ error: "larger_than_5mb" }, 413);

  const db = getWorkspaceClient(identity.workspaceId);
  // Tenant-guarded: a token for one workspace cannot attach a photo to another
  // workspace's lead, and a lead id that is not ours simply does not exist.
  const lead = await db.lead.findUnique({ where: { id: leadId }, select: { id: true } });
  if (!lead) return json({ error: "no_such_lead" }, 404);

  const buf = Buffer.from(await file.arrayBuffer());
  const verdict = inspectImage(buf);
  if (!verdict.ok) {
    // The reason travels back so the popup can say WHY there is no photo,
    // rather than degrading silently to initials.
    return json({ error: "rejected", reason: verdict.reason }, 415);
  }

  const rel = `avatars/${lead.id}.${verdict.ext}`;
  try {
    await mkdir(join(FILES_DIR, "avatars"), { recursive: true });
    await writeFile(join(FILES_DIR, rel), buf);
  } catch {
    return json({ error: "could_not_store_the_file" }, 500);
  }

  await db.lead.update({ where: { id: lead.id }, data: { avatarPath: rel } });

  /**
   * PATCH THE CAPTURE'S OWN DIAGNOSTICS with how this went.
   *
   * The capture is written before the photo is uploaded — the upload needs the
   * lead id the capture returns — so the `photo` section stored with it can only
   * ever describe RETRIEVAL. That is how a lead ended up carrying
   * `photo.ok: true` while no avatar existed anywhere: retrieval had worked, and
   * the four steps after it (encode, upload, store, attach) were unreported.
   *
   * This is the only place that knows the outcome of the last three, so it writes
   * them into the same record rather than leaving the client to re-post a whole
   * capture for the sake of one field. `ok` becomes true HERE and nowhere else,
   * which is what makes "ok but no avatar" impossible rather than merely unlikely.
   */
  try {
    const capture = await db.activity.findFirst({
      where: { leadId: lead.id, type: { in: ["capture_created", "capture_updated"] } },
      orderBy: { at: "desc" },
      select: { id: true, payload: true },
    });
    const payload = (capture?.payload ?? null) as Record<string, unknown> | null;
    const diagnostics = (payload?.diagnostics ?? null) as Record<string, unknown> | null;
    if (capture && diagnostics && typeof diagnostics === "object") {
      const photo = (diagnostics.photo ?? {}) as Record<string, unknown>;
      await db.activity.update({
        where: { id: capture.id },
        data: {
          payload: {
            ...payload,
            diagnostics: {
              ...diagnostics,
              photo: {
                ...photo,
                ok: true,
                upload: {
                  attached: true,
                  stage: "attached",
                  status: 200,
                  storedBytes: buf.byteLength,
                  storedPath: rel,
                  mime: verdict.mime,
                  width: verdict.width,
                  height: verdict.height,
                },
              },
            },
          },
        },
      });
    }
  } catch {
    // A diagnostics patch must never cost the avatar that was just stored.
  }
  await db.activity.create({
    data: {
      workspaceId: identity.workspaceId,
      leadId: lead.id,
      type: "capture_avatar",
      byUserId: identity.userId,
      payload: {
        bytes: buf.byteLength,
        mime: verdict.mime,
        width: verdict.width,
        height: verdict.height,
      },
    },
  });

  return json(
    { ok: true, path: rel, width: verdict.width, height: verdict.height, bytes: buf.byteLength },
    201,
  );
}
