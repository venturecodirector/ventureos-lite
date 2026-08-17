import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prismaUnsafe } from "../../src/lib/db";
import { createCaptureToken } from "../../src/modules/capture/tokens";
import { resolveFileWorkspace } from "../../src/lib/file-owner";

/**
 * Uploading the profile photo's BYTES, end to end.
 *
 * This route exists because the previous design could not work: LinkedIn's
 * avatar URLs are signed and time-limited, and the CDN refuses a request that
 * arrives without the session that minted them. Every capture reported "the
 * photo could not be fetched" while the picture sat visibly on screen. The
 * extension now fetches it in the tab and posts the bytes here — which makes
 * this endpoint the trust boundary, so the refusals matter as much as the happy
 * path.
 */

// The route reads FILES_DIR at module load, so it has to be set before import.
const FILES_DIR = mkdtempSync(join(tmpdir(), "vos-avatar-"));
process.env.FILES_DIR = FILES_DIR;
const { POST } = await import("../../src/app/api/capture/avatar/route");

const EMAIL = "capture-avatar-user@ventureco.test";
const WORKSPACE = "Capture Avatar Test WS";

let workspaceId = "";
let otherWorkspaceId = "";
let userId = "";
let token = "";
let leadId = "";

/** A valid 400×400 PNG header — enough for the inspector, which never decodes. */
function png(width = 400, height = 400): Buffer {
  const b = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

function upload(body: FormData, bearer = token): Promise<Response> {
  return POST(
    new Request("https://app.test/api/capture/avatar", {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}` },
      body,
    }),
  );
}

function form(id: string, bytes: Buffer, type = "image/png"): FormData {
  const f = new FormData();
  f.append("leadId", id);
  // Buffer's ArrayBufferLike does not satisfy BlobPart's ArrayBuffer; the
  // underlying bytes are the same, so hand Blob a plain Uint8Array view.
  f.append("photo", new Blob([new Uint8Array(bytes)], { type }), "avatar.png");
  return f;
}

beforeAll(async () => {
  await prismaUnsafe.workspace.deleteMany({ where: { name: WORKSPACE } }).catch(() => {});
  workspaceId = (await prismaUnsafe.workspace.create({ data: { name: WORKSPACE } })).id;
  otherWorkspaceId = (
    await prismaUnsafe.workspace.create({ data: { name: `${WORKSPACE} neighbour` } })
  ).id;

  const user = await prismaUnsafe.user.upsert({
    where: { email: EMAIL },
    update: {},
    create: { email: EMAIL, name: "Avatar Upload Tester", passwordHash: "x" },
  });
  userId = user.id;
  await prismaUnsafe.membership.upsert({
    where: { userId_workspaceId: { userId, workspaceId } },
    update: {},
    create: { userId, workspaceId, role: "OWNER" },
  });
  token = (await createCaptureToken(userId, workspaceId, "test")).token;
});

beforeEach(async () => {
  await prismaUnsafe.activity.deleteMany({ where: { workspaceId } });
  await prismaUnsafe.lead.deleteMany({ where: { workspaceId } });
  leadId = (
    await prismaUnsafe.lead.create({
      data: {
        workspaceId,
        contactName: "Kovács Anna",
        linkedinUrl: "https://www.linkedin.com/in/avatar-upload-tester",
        source: "LINKEDIN",
        stage: "RESEARCHED",
        signals: [],
      },
    })
  ).id;
});

afterAll(async () => {
  for (const ws of [workspaceId, otherWorkspaceId]) {
    await prismaUnsafe.activity.deleteMany({ where: { workspaceId: ws } });
    await prismaUnsafe.lead.deleteMany({ where: { workspaceId: ws } });
  }
  await prismaUnsafe.captureToken.deleteMany({ where: { userId } });
  await prismaUnsafe.membership.deleteMany({ where: { userId } });
  await prismaUnsafe.user.deleteMany({ where: { email: EMAIL } });
  await prismaUnsafe.workspace.deleteMany({
    where: { id: { in: [workspaceId, otherWorkspaceId] } },
  });
});

describe("a photo uploaded as bytes", () => {
  it("stores the file and attaches it to the lead", async () => {
    const res = await upload(form(leadId, png()));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, width: 400, height: 400 });

    const lead = await prismaUnsafe.lead.findUnique({ where: { id: leadId } });
    expect(lead!.avatarPath).toBe(`avatars/${leadId}.png`);
    // Actually on disk, byte-identical.
    const stored = join(FILES_DIR, lead!.avatarPath!);
    expect(existsSync(stored)).toBe(true);
    expect(readFileSync(stored).equals(png())).toBe(true);
  });

  it("is reachable through the authenticated file route's owner resolver", async () => {
    // The half that was missing when avatars first shipped: a stored path that
    // the file route could not attribute 404'd every avatar.
    await upload(form(leadId, png()));
    const lead = await prismaUnsafe.lead.findUnique({ where: { id: leadId } });
    await expect(resolveFileWorkspace(lead!.avatarPath!)).resolves.toBe(workspaceId);
  });

  it("records the upload as an activity, with the dimensions", async () => {
    await upload(form(leadId, png()));
    const act = await prismaUnsafe.activity.findFirst({
      where: { leadId, type: "capture_avatar" },
    });
    expect(act).toBeTruthy();
    expect(act!.payload).toMatchObject({ mime: "image/png", width: 400, height: 400 });
  });
});

describe("what the endpoint refuses", () => {
  it("refuses a file that only claims to be an image", async () => {
    // A reasoned failure, not a silent null — the reason reaches the popup.
    const res = await upload(form(leadId, Buffer.from("<?php echo 1; ?>"), "image/png"));
    expect(res.status).toBe(415);
    expect((await res.json()).reason).toBe("not_a_jpeg_png_or_webp");
    const lead = await prismaUnsafe.lead.findUnique({ where: { id: leadId } });
    expect(lead!.avatarPath).toBeNull();
  });

  it("refuses an image whose header claims absurd dimensions", async () => {
    const res = await upload(form(leadId, png(30000, 30000)));
    expect(res.status).toBe(415);
    expect((await res.json()).reason).toBe("dimensions_too_large");
  });

  it("refuses an unauthenticated upload", async () => {
    expect((await upload(form(leadId, png()), `vos_cap_${"a".repeat(32)}`)).status).toBe(401);
  });

  it("refuses a body that is not multipart", async () => {
    const res = await POST(
      new Request("https://app.test/api/capture/avatar", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ leadId }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("refuses an upload with no photo part", async () => {
    const f = new FormData();
    f.append("leadId", leadId);
    expect((await upload(f)).status).toBe(400);
  });

  /**
   * TENANCY (hard rule #1). A capture token is scoped to one workspace, and the
   * lookup goes through the guarded client — so another workspace's lead is not
   * "forbidden", it does not exist.
   */
  it("cannot attach a photo to another workspace's lead", async () => {
    const foreign = await prismaUnsafe.lead.create({
      data: {
        workspaceId: otherWorkspaceId,
        contactName: "Someone Else",
        linkedinUrl: "https://www.linkedin.com/in/someone-else-entirely",
        source: "LINKEDIN",
        stage: "RESEARCHED",
        signals: [],
      },
    });
    const res = await upload(form(foreign.id, png()));
    expect(res.status).toBe(404);
    const after = await prismaUnsafe.lead.findUnique({ where: { id: foreign.id } });
    expect(after!.avatarPath).toBeNull();
  });
});
