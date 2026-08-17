/**
 * The isolated-world half of the passive observer. document_start, ISOLATED world.
 *
 * The MAIN-world interceptor cannot talk to `chrome.*`; a content script cannot
 * see the page's `fetch`. So one runs in each world and they meet at
 * `window.postMessage`, which is the only channel between them. This side owns
 * everything the MAIN side must not be trusted with: the buffer, the extension
 * messaging, and deciding what counts as a valid observation.
 *
 * ── EVERYTHING ARRIVING HERE IS UNTRUSTED ───────────────────────────────────
 *
 * `postMessage` is a public letterbox: LinkedIn's own scripts can post to it, and
 * so could anything else running on the page. Four checks, in order of how much
 * they are worth:
 *
 *   1. `event.source === window` and `event.origin === location.origin` — a
 *      different frame or a different origin is not our interceptor.
 *   2. The channel tag, which is only a cheap filter.
 *   3. The nonce, locked to the FIRST hello seen. The interceptor runs at
 *      document_start, so it announces itself before any page script executes;
 *      a later announcement is by definition not ours.
 *   4. SHAPE VALIDATION on every record, because none of the above proves the
 *      contents are what they claim. A record with a hostile URL or a body that
 *      is not a string is dropped rather than buffered.
 *
 * None of this is load-bearing for safety in the way it would be if we acted on
 * the data: an observation only ever becomes a lead the user is looking at, on a
 * page they opened, after they press Capture. The checks exist so that a noisy or
 * hostile page cannot fill the buffer with rubbish and make a capture wrong.
 *
 * ── THE BUFFER ──────────────────────────────────────────────────────────────
 *
 * Keyed by profile slug, capped, and short-lived. A capture normally needs no
 * network at all: the page fetched its own data on load, so by the time the user
 * presses the button it is already here. The TTL exists so a tab left open for an
 * hour cannot hand a stale profile to a capture, and the size cap so a long
 * session cannot grow without bound.
 */
(() => {
  const CHANNEL = "venture-observer";
  const TTL_MS = 10 * 60 * 1000;
  const MAX_RECORDS = 40;
  const MAX_TOTAL_BYTES = 8_000_000;

  if (window.__ventureBridgeInstalled) return;
  window.__ventureBridgeInstalled = true;

  /** The nonce announced by the first `hello`. Never reassigned afterwards. */
  let nonce = null;
  let installedAt = null;

  /** slug -> { at, records: [] }. One page's worth of observations. */
  const buffer = new Map();

  const slugOf = (href) => {
    try {
      const m = /^\/in\/([^/]+)/.exec(new URL(href, location.href).pathname);
      return m ? decodeURIComponent(m[1]).toLowerCase() : null;
    } catch {
      return null;
    }
  };

  /** The slug of the page currently on screen — what an observation belongs to. */
  const currentSlug = () => slugOf(location.href);

  const totalBytes = () => {
    let n = 0;
    for (const entry of buffer.values()) {
      for (const r of entry.records) n += r.bodySize ?? 0;
    }
    return n;
  };

  const prune = () => {
    const now = Date.now();
    for (const [slug, entry] of buffer) {
      if (now - entry.at > TTL_MS) buffer.delete(slug);
    }
    // Oldest-first eviction until the cap is respected.
    while (totalBytes() > MAX_TOTAL_BYTES && buffer.size > 1) {
      let oldest = null;
      for (const [slug, entry] of buffer) {
        if (!oldest || entry.at < oldest[1].at) oldest = [slug, entry];
      }
      if (!oldest) break;
      buffer.delete(oldest[0]);
    }
  };

  /**
   * Is this record shaped like an observation?
   *
   * Checked rather than assumed: everything here arrived through a public
   * letterbox. A record that fails is dropped silently — there is nobody to
   * report it to who could act on it.
   */
  const isValidRecord = (r) => {
    if (!r || typeof r !== "object") return false;
    if (typeof r.url !== "string" || r.url.length === 0 || r.url.length > 4000) return false;
    try {
      const u = new URL(r.url, location.href);
      if (!/(^|\.)linkedin\.com$/i.test(u.hostname)) return false;
    } catch {
      return false;
    }
    if (typeof r.status !== "number") return false;
    if (typeof r.bodySize !== "number" || r.bodySize < 0) return false;
    if (r.body !== null && typeof r.body !== "string") return false;
    return true;
  };

  window.addEventListener("message", (event) => {
    try {
      // (1) Same window, same origin. A frame or another origin is not ours.
      if (event.source !== window) return;
      if (event.origin !== location.origin) return;
      const data = event.data;
      if (!data || typeof data !== "object" || data.channel !== CHANNEL) return;

      if (data.kind === "hello") {
        // (3) First one wins, for ever.
        if (nonce === null && typeof data.nonce === "string" && data.nonce.length >= 8) {
          nonce = data.nonce;
          installedAt = { world: data.world ?? null, at: data.at ?? null, when: Date.now() };
        }
        return;
      }

      if (nonce === null || data.nonce !== nonce) return;
      if (data.kind !== "observed") return;
      if (!isValidRecord(data.record)) return;

      const slug = currentSlug();
      if (!slug) return; // Not a profile page; nothing here belongs to a lead.

      prune();
      const entry = buffer.get(slug) ?? { at: Date.now(), records: [] };
      entry.at = Date.now();
      // Newest wins on a repeat of the same URL: LinkedIn re-fetches on
      // interaction, and the later copy is the one the user is looking at.
      const existing = entry.records.findIndex((r) => r.url === data.record.url);
      if (existing >= 0) entry.records.splice(existing, 1);
      entry.records.push({ ...data.record, observedAt: Date.now() });
      while (entry.records.length > MAX_RECORDS) entry.records.shift();
      buffer.set(slug, entry);
    } catch {
      /* a malformed message is not an error worth surfacing */
    }
  });

  /**
   * Navigating away clears the previous page's records.
   *
   * LinkedIn is a single-page app, so there is no unload between profiles. Without
   * this, one profile's responses could still be in the buffer while the user is
   * looking at another — and a capture would attach the wrong person's data to the
   * right person's lead.
   */
  let lastSlug = currentSlug();
  const onNavigate = () => {
    try {
      const now = currentSlug();
      if (now === lastSlug) return;
      if (lastSlug) buffer.delete(lastSlug);
      lastSlug = now;
    } catch {
      /* nothing to do */
    }
  };
  window.addEventListener("popstate", onNavigate);
  setInterval(onNavigate, 1000);

  /**
   * A same-world handle, for the state machine.
   *
   * The machine is injected into the ISOLATED world, which is the world this
   * script already runs in — same extension, same frame, so one global object.
   * It cannot use `chrome.tabs.sendMessage` to reach us (a content script cannot
   * message itself), so the buffer is exposed directly.
   *
   * READ-ONLY, and a copy: a caller that mutated what it was handed would corrupt
   * the buffer for the next capture.
   */
  globalThis.VentureObserved = {
    status() {
      prune();
      const slug = currentSlug();
      const entry = slug ? buffer.get(slug) : null;
      return {
        installed: nonce !== null,
        world: installedAt?.world ?? null,
        timing: installedAt?.at ?? null,
        slug,
        recordCount: entry?.records.length ?? 0,
        inventory: (entry?.records ?? []).map((r) => ({
          url: r.url,
          method: r.method,
          status: r.status,
          contentType: r.contentType,
          bodySize: r.bodySize,
          truncated: !!r.truncated,
        })),
      };
    },
    take(slug) {
      prune();
      const key = slug ? String(slug).toLowerCase() : currentSlug();
      const entry = key ? buffer.get(key) : null;
      return (entry?.records ?? []).map((r) => ({ ...r }));
    },
  };

  /**
   * Answer the popup and the service worker.
   *
   * Read-only: this hands over what was observed and never fetches anything to
   * fill a gap. An empty answer is a real answer — the orchestrator uses it to
   * decide between prompting a reload and falling back to the DOM.
   */
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    try {
      if (msg?.type === "observerStatus") {
        prune();
        const slug = currentSlug();
        const entry = slug ? buffer.get(slug) : null;
        sendResponse({
          ok: true,
          installed: nonce !== null,
          world: installedAt?.world ?? null,
          timing: installedAt?.at ?? null,
          slug,
          recordCount: entry?.records.length ?? 0,
          // The inventory, without the bodies: what was seen, how big, and when.
          inventory: (entry?.records ?? []).map((r) => ({
            url: r.url,
            method: r.method,
            status: r.status,
            contentType: r.contentType,
            bodySize: r.bodySize,
            truncated: !!r.truncated,
          })),
        });
        return true;
      }

      if (msg?.type === "observerTake") {
        prune();
        const slug = msg.slug ? String(msg.slug).toLowerCase() : currentSlug();
        const entry = slug ? buffer.get(slug) : null;
        sendResponse({
          ok: true,
          installed: nonce !== null,
          slug,
          records: entry?.records ?? [],
        });
        return true;
      }

      if (msg?.type === "observerClear") {
        buffer.clear();
        sendResponse({ ok: true });
        return true;
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.name ?? "Error") });
      return true;
    }
    return undefined;
  });
})();
