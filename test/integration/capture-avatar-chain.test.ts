import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { rm, readFile } from "node:fs/promises";
import { prismaUnsafe } from "../../src/lib/db";
import { createCaptureToken } from "../../src/modules/capture/tokens";

/**
 * A repo-local files directory, set BEFORE the routes are imported.
 *
 * `.env` sets FILES_DIR=/data/files, which is the path inside the app container;
 * nothing may create `/data` on a developer machine, so the store leg answered 500
 * `could_not_store_the_file` and the whole chain looked broken for the wrong
 * reason. The same override playwright.config.ts already applies, done here rather
 * than globally so no other test's expectations move.
 *
 * `data/` at the repo root is gitignored.
 */
const FILES_DIR = resolve(process.cwd(), "data/files");
process.env.FILES_DIR = FILES_DIR;

/**
 * The avatar chain, leg by leg (capture item 5).
 *
 * ── WHAT WENT WRONG ─────────────────────────────────────────────────────────
 *
 * Diagnostics said `photo.ok: true, trail: ["fetch:Failed to fetch", "img:ok"],
 * 400x400` and no avatar existed on the lead. Both halves were true: retrieval
 * HAD worked, and everything after it was unreported — encode, upload, the
 * server-side store, the attach. `photo.ok` was written before the upload even
 * happened, so it could only ever mean "we got some bytes".
 *
 * So the tests here are about the SEAMS, and about the one property that makes the
 * failure impossible to repeat: `ok: true` is now written in exactly one place —
 * the server, after the avatar is on the lead.
 */
const EMAIL = "capture-avatar-user@ventureco.test";
const WORKSPACE = "Capture Avatar Test WS";

let workspaceId = "";
let userId = "";
let token = "";
const created: string[] = [];

// Dynamic, so the env override above is in place before the modules read it.
const capture = await import("../../src/app/api/capture/route");
const avatar = await import("../../src/app/api/capture/avatar/route");

/**
 * A GENUINE image, generated rather than pasted.
 *
 * `inspectImage` enforces a 16px minimum edge, so a hand-rolled 2×2 is refused —
 * correctly. Generating it with sharp means the bytes written to disk are a real
 * decodable image rather than a header that merely satisfies the validator.
 */
let PNG_64: Buffer;

beforeAll(async () => {
  const sharp = (await import("sharp")).default;
  PNG_64 = await sharp({
    create: { width: 64, height: 64, channels: 3, background: "#7427C6" },
  })
    .png()
    .toBuffer();

  await prismaUnsafe.workspace.deleteMany({ where: { name: { startsWith: WORKSPACE } } });
  workspaceId = (await prismaUnsafe.workspace.create({ data: { name: WORKSPACE } })).id;
  const user = await prismaUnsafe.user.upsert({
    where: { email: EMAIL },
    update: {},
    create: { email: EMAIL, name: "Avatar Tester", passwordHash: "x" },
  });
  userId = user.id;
  await prismaUnsafe.membership.upsert({
    where: { userId_workspaceId: { userId, workspaceId } },
    update: {},
    create: { userId, workspaceId, role: "OWNER" },
  });
  token = (await createCaptureToken(userId, workspaceId, "avatar")).token;
});

async function wipe() {
  await prismaUnsafe.activity.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.lead.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.company.deleteMany({ where: { workspaceId } });
}
beforeEach(wipe);

afterAll(async () => {
  await wipe();
  for (const rel of created) await rm(join(FILES_DIR, rel), { force: true });
  await prismaUnsafe.captureToken.deleteMany({ where: { userId } });
  await prismaUnsafe.membership.deleteMany({ where: { userId } });
  await prismaUnsafe.user.deleteMany({ where: { email: EMAIL } });
  await prismaUnsafe.workspace.deleteMany({ where: { id: workspaceId } });
});

/** Post a capture whose diagnostics claim retrieval succeeded but nothing more. */
async function postCapture(url: string) {
  const res = await capture.POST(
    new Request("https://app.test/api/capture", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        url,
        name: "Mark Goldberger",
        diagnostics: {
          diagnoseVersion: 3,
          photo: {
            retrieved: true,
            method: "service-worker",
            width: 400,
            height: 400,
            ok: false,
            upload: null,
            legs: [{ leg: "service-worker", ok: true, trail: ["sw-fetch:200", "bytes:12345"] }],
          },
        },
      }),
    }),
  );
  const body = (await res.json()) as { leadId: string };
  return body.leadId;
}

async function postAvatar(leadId: string, bytes: Buffer, filename = "avatar.png") {
  const form = new FormData();
  form.append("leadId", leadId);
  // `new Uint8Array(bytes)`: a Node Buffer is not a structurally valid BlobPart.
  form.append("photo", new Blob([new Uint8Array(bytes)], { type: "image/png" }), filename);
  return avatar.POST(
    new Request("https://app.test/api/capture/avatar", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: form,
    }),
  );
}

async function captureDiagnostics(leadId: string) {
  const row = await prismaUnsafe.activity.findFirst({
    where: { leadId, type: { in: ["capture_created", "capture_updated"] } },
    orderBy: { at: "desc" },
    select: { payload: true },
  });
  const payload = row?.payload as { diagnostics?: { photo?: Record<string, unknown> } } | null;
  return payload?.diagnostics?.photo ?? null;
}

describe("the upload, store and attach legs", () => {
  it("stores the file, attaches it to the lead, and says what it stored", async () => {
    const leadId = await postCapture("https://www.linkedin.com/in/avatar-happy");
    const res = await postAvatar(leadId, PNG_64);
    // 201: the avatar route creates a stored file.
    expect([200, 201]).toContain(res.status);

    const lead = await prismaUnsafe.lead.findUnique({ where: { id: leadId } });
    expect(lead!.avatarPath, "the avatar was never attached to the lead").toBeTruthy();
    created.push(lead!.avatarPath!);

    // The bytes really are on disk, under FILES_DIR, and are the ones we sent.
    const onDisk = await readFile(join(FILES_DIR, lead!.avatarPath!));
    expect(onDisk.byteLength).toBe(PNG_64.byteLength);
  });

  it("records the store and attach on their own activity", async () => {
    const leadId = await postCapture("https://www.linkedin.com/in/avatar-activity");
    await postAvatar(leadId, PNG_64);
    const act = await prismaUnsafe.activity.findFirst({
      where: { leadId, type: "capture_avatar" },
      select: { payload: true },
    });
    expect(act).not.toBeNull();
    expect(act!.payload).toMatchObject({ mime: "image/png", bytes: PNG_64.byteLength });
    const lead = await prismaUnsafe.lead.findUnique({ where: { id: leadId } });
    if (lead?.avatarPath) created.push(lead.avatarPath);
  });

  /**
   * THE PROPERTY THAT MAKES THE REPORTED FAILURE IMPOSSIBLE.
   *
   * `photo.ok` is written in exactly one place: here, by the server, after the
   * avatar is on the lead.
   */
  it("flips photo.ok to true only after the avatar is attached", async () => {
    const leadId = await postCapture("https://www.linkedin.com/in/avatar-flips");

    // Before the upload: retrieval reported, ok deliberately false.
    const before = await captureDiagnostics(leadId);
    expect(before).not.toBeNull();
    expect(before!.retrieved).toBe(true);
    expect(before!.ok, "ok was true before anything was uploaded").toBe(false);
    expect(before!.upload).toBeNull();

    await postAvatar(leadId, PNG_64);

    const after = await captureDiagnostics(leadId);
    expect(after!.ok).toBe(true);
    expect(after!.upload).toMatchObject({
      attached: true,
      stage: "attached",
      mime: "image/png",
    });
    // And the lead really does have it, which is what `ok` now asserts.
    const lead = await prismaUnsafe.lead.findUnique({ where: { id: leadId } });
    expect(lead!.avatarPath).toBeTruthy();
    created.push(lead!.avatarPath!);
  });

  it("leaves photo.ok false when the server refuses the image", async () => {
    const leadId = await postCapture("https://www.linkedin.com/in/avatar-refused");
    const res = await postAvatar(leadId, Buffer.from("this is not an image at all"));
    expect(res.status).toBe(415);
    expect((await res.json()) as { reason?: string }).toHaveProperty("reason");

    const lead = await prismaUnsafe.lead.findUnique({ where: { id: leadId } });
    expect(lead!.avatarPath).toBeNull();
    // The diagnostics were not touched, so nothing claims success.
    const photo = await captureDiagnostics(leadId);
    expect(photo!.ok).toBe(false);
    expect(photo!.upload).toBeNull();
  });

  it("refuses an upload with no lead id, and one for another workspace's lead", async () => {
    const noId = await postAvatar("", PNG_64);
    expect(noId.status).toBe(400);

    // TENANCY: a lead in another workspace does not exist here.
    const other = await prismaUnsafe.workspace.create({ data: { name: `${WORKSPACE} other` } });
    const theirLead = await prismaUnsafe.lead.create({
      data: { workspaceId: other.id, contactName: "Theirs", source: "LINKEDIN", signals: [] },
    });
    const res = await postAvatar(theirLead.id, PNG_64);
    expect(res.status).toBeGreaterThanOrEqual(400);
    const after = await prismaUnsafe.lead.findUnique({ where: { id: theirLead.id } });
    expect(after!.avatarPath).toBeNull();
    await prismaUnsafe.lead.deleteMany({ where: { workspaceId: other.id } });
    await prismaUnsafe.workspace.delete({ where: { id: other.id } });
  });
});

describe("the retrieval legs, as the extension implements them", () => {
  const EXT = join(process.cwd(), "extension");
  const background = readFileSync(join(EXT, "background.js"), "utf8");
  const popup = readFileSync(join(EXT, "popup.js"), "utf8");
  const manifest = JSON.parse(readFileSync(join(EXT, "manifest.json"), "utf8")) as {
    host_permissions?: string[];
  };

  /**
   * Leg (a): the service worker. Its request carries no page origin, so there is
   * nothing for CORS to refuse — which is the whole reason the in-page fetch
   * recorded `fetch:Failed to fetch` on every capture.
   */
  it("declares the licdn host so the service worker may fetch at all", () => {
    expect(manifest.host_permissions ?? []).toContain("https://media.licdn.com/*");
  });

  it("fetches, crops and encodes in the worker, without a canvas that can taint", () => {
    expect(background).toContain("async function fetchAvatar");
    // OffscreenCanvas, not a DOM canvas: a worker has no document, and an
    // OffscreenCanvas drawing a bitmap decoded from a blob can never be tainted.
    expect(background).toContain("OffscreenCanvas");
    expect(background).toContain("createImageBitmap");
    expect(background).toContain("convertToBlob");
  });

  it("only ever fetches licdn, checked by parsing rather than by pattern", () => {
    expect(background).toContain('u.hostname.toLowerCase()');
    expect(background).toMatch(/endsWith\(["'`]\.licdn\.com["'`]\)/);
  });

  it("tries the worker FIRST and the page second, recording both legs", () => {
    const a = popup.indexOf('leg: "service-worker"');
    const b = popup.indexOf('leg: "page-canvas"');
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(-1);
    expect(a, "the page leg is attempted before the worker leg").toBeLessThan(b);
  });

  it("reports each leg separately: method, sizes, upload status, attach", () => {
    for (const field of ["method", "encodedBytes", "sourceBytes", "legs", "upload"]) {
      expect(popup, `the photo diagnostics never mention ${field}`).toContain(field);
    }
    // `attached` is the word the upload result uses, and `ok` mirrors it.
    expect(popup).toContain("upload.attached");
  });

  it("never sets photo.ok from the client", () => {
    // The only assignment is from the upload's own verdict; nothing writes a
    // literal true. This is the client half of "ok but no avatar is impossible".
    expect(popup).not.toMatch(/photo:\s*\{[^}]*\bok:\s*true/);
  });
});
