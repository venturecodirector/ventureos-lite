import { describe, it, expect } from "vitest";
import { inspectImage, MAX_AVATAR_BYTES } from "../../src/modules/capture/image";

/**
 * The upload trust boundary.
 *
 * The extension now sends the profile photo's BYTES, because LinkedIn's signed
 * CDN links refuse a server-side fetch. That changes who the server is trusting:
 * not a CDN it can reason about, but a browser extension posting a file. So the
 * header is read rather than the declared content type believed — a
 * `Content-Type: image/jpeg` costs an attacker nothing.
 */

/** A 1×1 PNG, then patched to whatever dimensions a test needs. */
function png(width = 400, height = 400): Buffer {
  const b = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

/** A minimal JPEG: SOI, then an SOF0 frame carrying the dimensions. */
function jpeg(width = 400, height = 400): Buffer {
  const b = Buffer.alloc(21);
  b.writeUInt16BE(0xffd8, 0); // SOI
  b.writeUInt16BE(0xffe0, 2); // APP0
  b.writeUInt16BE(4, 4); //   length 4 (2 bytes of payload)
  b.writeUInt16BE(0x0000, 6);
  b.writeUInt16BE(0xffc0, 8); // SOF0
  b.writeUInt16BE(11, 10); //  length
  b[12] = 8; //                precision
  b.writeUInt16BE(height, 13);
  b.writeUInt16BE(width, 15);
  return b;
}

/** A lossy WebP: RIFF/WEBP/VP8 with a frame header. */
function webp(width = 400, height = 400): Buffer {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(22, 4);
  b.write("WEBP", 8, "ascii");
  b.write("VP8 ", 12, "ascii");
  b.writeUInt16LE(width & 0x3fff, 26);
  b.writeUInt16LE(height & 0x3fff, 28);
  return b;
}

describe("what it accepts", () => {
  it("reads a PNG's real dimensions from IHDR", () => {
    expect(inspectImage(png(400, 400))).toEqual({
      ok: true, mime: "image/png", ext: "png", width: 400, height: 400,
    });
  });

  it("reads a JPEG's dimensions by walking to the frame header", () => {
    expect(inspectImage(jpeg(400, 400))).toMatchObject({
      ok: true, mime: "image/jpeg", ext: "jpg", width: 400, height: 400,
    });
  });

  it("reads a lossy WebP", () => {
    expect(inspectImage(webp(400, 400))).toMatchObject({
      ok: true, mime: "image/webp", ext: "webp", width: 400, height: 400,
    });
  });
});

describe("what it refuses, and why", () => {
  it("refuses a file that merely claims to be an image", () => {
    // The whole point: the bytes decide, not the Content-Type header.
    const notAnImage = Buffer.from("<?php system($_GET['c']); ?>", "utf8");
    expect(inspectImage(notAnImage)).toEqual({ ok: false, reason: "not_a_jpeg_png_or_webp" });
  });

  it("refuses an HTML error page the CDN might have returned", () => {
    expect(inspectImage(Buffer.from("<!doctype html><title>403</title>", "utf8")).ok).toBe(false);
  });

  it("refuses an empty upload", () => {
    expect(inspectImage(Buffer.alloc(0))).toEqual({ ok: false, reason: "empty_upload" });
  });

  it("refuses anything over 5 MB", () => {
    const big = Buffer.alloc(MAX_AVATAR_BYTES + 1);
    png().copy(big, 0);
    expect(inspectImage(big)).toEqual({ ok: false, reason: "larger_than_5mb" });
  });

  it("refuses a decompression-bomb sized header", () => {
    // A valid PNG header claiming 30000×30000: 3.6 GB of pixels from 24 bytes.
    expect(inspectImage(png(30000, 30000))).toEqual({ ok: false, reason: "dimensions_too_large" });
  });

  it("refuses a tracking-pixel sized image", () => {
    expect(inspectImage(png(1, 1))).toEqual({ ok: false, reason: "dimensions_too_small" });
  });

  it("refuses a truncated PNG header", () => {
    expect(inspectImage(Buffer.from("89504e470d0a1a0a", "hex")).ok).toBe(false);
  });

  it("refuses a JPEG with no frame header", () => {
    expect(inspectImage(Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x00])).ok).toBe(false);
  });

  it("gives every rejection a machine-readable reason", () => {
    for (const bad of [Buffer.alloc(0), Buffer.from("nope"), png(1, 1), png(9999, 9999)]) {
      const v = inspectImage(bad);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.reason).toMatch(/^[a-z0-9_]+$/);
    }
  });
});
