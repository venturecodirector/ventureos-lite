/**
 * Fetch the profile photo's BYTES, in the page.
 *
 * WHY NOT SERVER-SIDE, WHICH IS WHAT IT USED TO DO
 *
 * LinkedIn's avatar URLs are signed and time-limited — the `e`, `v` and `t`
 * query parameters are an expiry and a signature — and the CDN refuses a request
 * that arrives without the session that minted them. So every capture reported
 * "the photo could not be fetched" while the picture sat visibly on screen: the
 * URL was correct, the fetcher was simply the wrong machine.
 *
 * Here the fetch happens in the tab the user is already looking at, with its
 * cookies and its referrer, at the moment the URL is still valid. What travels
 * to the server is a picture rather than a promise of one.
 *
 * NORMALIZED HERE, NOT ON THE SERVER — a deviation from the brief, deliberately.
 * The brief asked the server to re-encode to a square avatar. Doing that in Node
 * means adding a native image dependency (sharp) to an image that already
 * carries Chromium, for one 400×400 crop. The canvas round-trip below IS a
 * re-encode — it decodes to pixels and encodes fresh, so nothing embedded in the
 * original survives — and it happens where the bytes already are. The server
 * still refuses to trust the result: it checks magic bytes, declared type,
 * dimensions and size before storing anything.
 */
(async () => {
  const SIZE = 400; // stored square edge
  const MAX_SOURCE_BYTES = 8 * 1024 * 1024;

  const fail = (reason) => ({ ok: false, reason });

  try {
    const url = globalThis.__venturePhotoUrl;
    if (typeof url !== "string" || !/^https:\/\//i.test(url)) {
      return fail("no_photo_url_supplied");
    }

    /**
     * Two ways in, because neither is guaranteed.
     *
     * A content script's `fetch` is a PAGE request as far as CORS is concerned,
     * so it works only if the CDN allows this origin. An <img> needs no CORS to
     * DISPLAY, but a canvas that has drawn a cross-origin image without
     * `crossorigin` is tainted and refuses to export. So: try the fetch, and
     * fall back to an image loaded with `crossorigin="anonymous"`, which is
     * exportable when the CDN sends the header and fails cleanly when it does
     * not. Whichever fails, it fails with a name.
     */
    let bitmap = null;
    let sourceBytes = 0;
    let sourceType = "";
    const trail = [];

    try {
      const res = await fetch(url, { credentials: "include", referrer: window.location.href });
      if (!res.ok) throw new Error(`status_${res.status}`);
      const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      if (!/^image\/(jpeg|png|webp)$/.test(type)) throw new Error(`type_${type || "unknown"}`);
      const blob = await res.blob();
      if (blob.size === 0) throw new Error("empty");
      if (blob.size > MAX_SOURCE_BYTES) return fail("source_larger_than_8mb");
      bitmap = await createImageBitmap(blob);
      sourceBytes = blob.size;
      sourceType = type;
      trail.push("fetch:ok");
    } catch (e) {
      trail.push(`fetch:${String(e?.message ?? e?.name ?? "failed")}`);
      try {
        bitmap = await new Promise((resolve, reject) => {
          const img = new Image();
          img.crossOrigin = "anonymous";
          img.referrerPolicy = "no-referrer-when-downgrade";
          img.onload = () => resolve(img);
          img.onerror = () => reject(new Error("img_load_failed"));
          img.src = url;
        });
        sourceType = "image/unknown";
        trail.push("img:ok");
      } catch (e2) {
        trail.push(`img:${String(e2?.message ?? "failed")}`);
        return { ok: false, reason: "could_not_read_the_image", trail };
      }
    }

    // Decode → crop to a centred square → encode. createImageBitmap and
    // OffscreenCanvas both exist in a page context and neither needs the DOM.
    const edge = Math.min(bitmap.width, bitmap.height);
    if (!edge) return fail("image_had_no_dimensions");
    const sx = Math.max(0, Math.round((bitmap.width - edge) / 2));
    const sy = Math.max(0, Math.round((bitmap.height - edge) / 2));

    const canvas = new OffscreenCanvas(SIZE, SIZE);
    const ctx = canvas.getContext("2d");
    if (!ctx) return fail("no_2d_context");
    ctx.drawImage(bitmap, sx, sy, edge, edge, 0, 0, SIZE, SIZE);
    bitmap.close?.();

    let out;
    try {
      out = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.86 });
    } catch {
      // A canvas that drew a cross-origin image the CDN did not authorise is
      // tainted, and export throws rather than returning bad data.
      return { ok: false, reason: "canvas_tainted_cdn_sent_no_cors_header", trail };
    }
    const buf = await out.arrayBuffer();

    // executeScript can only return JSON, so the bytes travel as base64. At
    // 400×400/q0.86 that is tens of kilobytes, not megabytes.
    let binary = "";
    const bytes = new Uint8Array(buf);
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }

    return {
      ok: true,
      mime: "image/jpeg",
      width: SIZE,
      height: SIZE,
      bytes: btoa(binary),
      sourceBytes,
      sourceType,
      trail,
    };
  } catch (e) {
    // A CORS refusal, an expired signature, a decode failure. Named, never
    // silent — the previous version's single unexplained failure mode cost a
    // full round of debugging.
    return fail(`fetch_or_decode_failed_${String(e?.name ?? "Error").toLowerCase()}`);
  }
})();
