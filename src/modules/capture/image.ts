/**
 * Deciding whether an upload is really an image, from its bytes.
 *
 * The extension now sends the profile photo's BYTES rather than a URL, because
 * LinkedIn's signed CDN links refuse a server-side fetch. That moves the trust
 * boundary: the server is no longer fetching from a CDN it can reason about, it
 * is accepting a file from a browser extension. So it reads the header itself
 * rather than believing the declared content type — a `Content-Type:
 * image/jpeg` header costs an attacker nothing.
 *
 * No image library. The three formats a canvas can emit have fixed, documented
 * headers, and parsing 30 bytes of each is smaller and safer than adding a
 * native dependency to a container that already ships Chromium. This does not
 * re-encode — the extension's canvas round-trip already decoded to pixels and
 * encoded fresh, which is what strips anything embedded in the original.
 */
export interface ImageInfo {
  ok: true;
  mime: "image/jpeg" | "image/png" | "image/webp";
  ext: "jpg" | "png" | "webp";
  width: number;
  height: number;
}
export type ImageVerdict = ImageInfo | { ok: false; reason: string };

export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
/** A profile photo far larger than this is not a profile photo. */
const MAX_EDGE = 4096;
const MIN_EDGE = 16;

function png(b: Buffer): ImageVerdict {
  // 8-byte signature, then a 4-byte length, "IHDR", width, height.
  if (b.length < 24) return { ok: false, reason: "png_header_truncated" };
  if (b.toString("ascii", 12, 16) !== "IHDR") return { ok: false, reason: "png_missing_ihdr" };
  return {
    ok: true,
    mime: "image/png",
    ext: "png",
    width: b.readUInt32BE(16),
    height: b.readUInt32BE(20),
  };
}

function jpeg(b: Buffer): ImageVerdict {
  // Walk the marker chain to a Start-Of-Frame, which carries the dimensions.
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = b[i + 1]!;
    // SOF0/1/2/9/10 carry dimensions; DHT/SOS and friends do not.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return {
        ok: true,
        mime: "image/jpeg",
        ext: "jpg",
        height: b.readUInt16BE(i + 5),
        width: b.readUInt16BE(i + 7),
      };
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = b.readUInt16BE(i + 2);
    if (len < 2) return { ok: false, reason: "jpeg_bad_segment_length" };
    i += 2 + len;
  }
  return { ok: false, reason: "jpeg_no_frame_header" };
}

function webp(b: Buffer): ImageVerdict {
  if (b.length < 30) return { ok: false, reason: "webp_header_truncated" };
  const chunk = b.toString("ascii", 12, 16);
  if (chunk === "VP8 ") {
    return {
      ok: true, mime: "image/webp", ext: "webp",
      width: b.readUInt16LE(26) & 0x3fff,
      height: b.readUInt16LE(28) & 0x3fff,
    };
  }
  if (chunk === "VP8L") {
    const bits = b.readUInt32LE(21);
    return {
      ok: true, mime: "image/webp", ext: "webp",
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }
  if (chunk === "VP8X") {
    return {
      ok: true, mime: "image/webp", ext: "webp",
      width: 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)),
      height: 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)),
    };
  }
  return { ok: false, reason: "webp_unknown_chunk" };
}

/** What this buffer actually is — never what it claims to be. */
export function inspectImage(buf: Buffer): ImageVerdict {
  if (buf.length === 0) return { ok: false, reason: "empty_upload" };
  if (buf.length > MAX_AVATAR_BYTES) return { ok: false, reason: "larger_than_5mb" };

  let verdict: ImageVerdict;
  if (buf.length >= 8 && buf.toString("hex", 0, 8) === "89504e470d0a1a0a") verdict = png(buf);
  else if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) verdict = jpeg(buf);
  else if (
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  ) {
    verdict = webp(buf);
  } else {
    return { ok: false, reason: "not_a_jpeg_png_or_webp" };
  }

  if (!verdict.ok) return verdict;
  const { width, height } = verdict;
  if (!width || !height) return { ok: false, reason: "no_dimensions_in_header" };
  if (width > MAX_EDGE || height > MAX_EDGE) return { ok: false, reason: "dimensions_too_large" };
  if (width < MIN_EDGE || height < MIN_EDGE) return { ok: false, reason: "dimensions_too_small" };
  return verdict;
}
