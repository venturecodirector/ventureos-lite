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

  /**
   * The resource census, and the patch health.
   *
   * Page-scoped rather than slug-scoped: it answers "what did this document
   * load", which is a property of the tab, not of a profile. Cleared on
   * navigation with everything else.
   */
  let census = [];
  let health = null;
  const CENSUS_MAX = 200;

  /**
   * Records seen before the URL became a profile.
   *
   * A single-page navigation fetches the next profile's data before, or while,
   * the address bar catches up. These wait here until we know which profile they
   * describe.
   */
  let pending = [];

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
    // A SKIPPED record carries no body and no size — it exists to say that a
    // response went past and why it was not copied.
    if (r.skipped !== undefined) {
      if (typeof r.skipped !== "string" || r.skipped.length > 60) return false;
      if (r.body !== null && r.body !== undefined) return false;
      return true;
    }
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

      /**
       * The census: URLs the document loaded, by whatever mechanism, with no
       * bodies. Validated the same way as everything else arriving here — it is
       * shown to a human as diagnostics, and a hostile page must not be able to
       * put arbitrary text in front of them.
       */
      if (data.kind === "census") {
        if (!Array.isArray(data.entries)) return;
        for (const raw of data.entries) {
          if (!raw || typeof raw !== "object") continue;
          if (typeof raw.path !== "string" || raw.path.length === 0 || raw.path.length > 500) {
            continue;
          }
          try {
            const u = new URL(raw.path, location.href);
            if (!/(^|\.)linkedin\.com$/i.test(u.hostname)) continue;
            // No query, ever — the MAIN side strips it, and this side enforces it.
            if (u.search) continue;
          } catch {
            continue;
          }
          if (census.length >= CENSUS_MAX) break;
          census.push({
            path: raw.path,
            initiatorType: typeof raw.initiatorType === "string" ? raw.initiatorType.slice(0, 40) : "",
            transferSize: typeof raw.transferSize === "number" ? raw.transferSize : null,
            decodedBodySize: typeof raw.decodedBodySize === "number" ? raw.decodedBodySize : null,
          });
        }
        if (data.health && typeof data.health === "object") {
          health = {
            fetchPatched: data.health.fetchPatched === true,
            xhrOpenPatched:
              data.health.xhrOpenPatched === null ? null : data.health.xhrOpenPatched === true,
          };
        }
        return;
      }

      if (data.kind !== "observed") return;
      if (!isValidRecord(data.record)) return;

      /**
       * A record observed while the URL is NOT yet a profile is held, not dropped.
       *
       * This mattered more than it looks. LinkedIn server-renders a profile on a
       * fresh page load, so a reload produces no profile JSON at all — the only
       * JSON on that load is telemetry. The profile is fetched as JSON when the
       * app navigates CLIENT-SIDE to it, and in that case the request very often
       * completes while `location` still points at the page you came from. The old
       * `if (!slug) return` therefore threw away precisely the response we exist
       * to capture, and did it silently.
       *
       * So: no slug yet means "pending". `onNavigate` claims the pending records
       * for whichever profile we land on, which is the only moment we can know
       * who they belonged to.
       */
      const slug = currentSlug();
      if (!slug) {
        pending.push({ ...data.record, observedAt: Date.now() });
        while (pending.length > MAX_RECORDS) pending.shift();
        return;
      }

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
      // The census describes what the DOCUMENT loaded. On a client-side
      // navigation the document is the same one, so it is NOT cleared here: the
      // requests that fetched this profile were made before the URL changed, and
      // throwing them away would delete the evidence at the moment it becomes
      // interesting. It is capped instead, and dies with the tab.

      /**
       * Landing on a profile claims whatever was observed on the way in.
       *
       * The fetch that carries a profile usually finishes before the URL changes,
       * so without this the arrival on the page would find an empty buffer and
       * report "the page loaded before the observer" — which would be wrong, and
       * wrong in the most misleading possible direction.
       */
      if (now && pending.length > 0) {
        prune();
        const entry = buffer.get(now) ?? { at: Date.now(), records: [] };
        entry.at = Date.now();
        for (const record of pending) {
          const existing = entry.records.findIndex((r) => r.url === record.url);
          if (existing >= 0) entry.records.splice(existing, 1);
          entry.records.push(record);
        }
        while (entry.records.length > MAX_RECORDS) entry.records.shift();
        buffer.set(now, entry);
        pending = [];
      }
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
  /**
   * One status shape, built in one place.
   *
   * There were two copies of this — the same fields assembled separately for the
   * same-world handle and for the extension message — and they had already
   * drifted once. A diagnostic that differs depending on which door you knocked
   * on is worse than no diagnostic.
   */
  /**
   * The records a capture may actually use — one implementation, both doors.
   *
   * Only records that HAVE a body. A skipped record is a note ABOUT a response
   * we did not copy; handing it to the mapping as though it were a payload would
   * turn a diagnostic into a wrong answer. (This lived in two places, and the
   * copy behind the extension message did not have the filter — which is exactly
   * the kind of divergence that made the status shape wrong before it.)
   */
  const takeRecords = (slug) => {
    prune();
    const key = slug ? String(slug).toLowerCase() : currentSlug();
    const entry = key ? buffer.get(key) : null;
    const withBody = (r) => !r.skipped && typeof r.body === "string";
    const own = (entry?.records ?? []).filter(withBody).map((r) => ({ ...r }));
    // Anything still unattributed is handed over too: on this page, at this
    // moment, it is the best answer available to "what did the page fetch".
    const held = pending.filter(withBody).map((r) => ({ ...r }));
    const seen = new Set(own.map((r) => r.url));
    return [...own, ...held.filter((r) => !seen.has(r.url))];
  };

  const buildStatus = () => {
    prune();
    const slug = currentSlug();
    const entry = slug ? buffer.get(slug) : null;
    const records = entry?.records ?? [];
    const copied = records.filter((r) => !r.skipped);
    const skipped = [...records, ...pending].filter((r) => r.skipped);
    const byReason = {};
    for (const r of skipped) byReason[r.skipped] = (byReason[r.skipped] ?? 0) + 1;
    return {
      installed: nonce !== null,
      world: installedAt?.world ?? null,
      timing: installedAt?.at ?? null,
      slug,
      // Only records with a body count as observations. This used to include the
      // skipped ones, which would have read as "we captured 12 responses" when we
      // had captured none.
      recordCount: copied.length,
      // Observed but not yet attributed to a profile — visible, so "nothing
      // here" and "held, waiting for a slug" cannot be confused.
      pendingCount: pending.filter((r) => !r.skipped).length,
      /**
       * WHY THERE WAS NOTHING TO CAPTURE.
       *
       * The three fields that turn "the buffer is empty" into an answer:
       * what went past and was not copied, what the document loaded by any
       * mechanism at all, and whether our patches are still the ones installed.
       */
      skippedCount: skipped.length,
      skippedByReason: byReason,
      censusCount: census.length,
      patchHealth: health,
      inventory: copied.map((r) => ({
        url: r.url,
        method: r.method,
        status: r.status,
        contentType: r.contentType,
        bodySize: r.bodySize,
        truncated: !!r.truncated,
      })),
    };
  };

  globalThis.VentureObserved = {
    status() {
      return buildStatus();
    },
    take(slug) {
      return takeRecords(slug);
    },
    /**
     * Everything the diagnostics need and the mapping must not have: the skipped
     * responses, the census, and whether our patches are still installed.
     */
    diagnostics() {
      prune();
      const slug = currentSlug();
      const entry = slug ? buffer.get(slug) : null;
      const all = [...(entry?.records ?? []), ...pending];
      const skipped = all.filter((r) => r.skipped);
      const byReason = {};
      for (const r of skipped) byReason[r.skipped] = (byReason[r.skipped] ?? 0) + 1;
      return {
        health,
        skippedCount: skipped.length,
        skippedByReason: byReason,
        skipped: skipped.map((r) => ({
          url: r.url,
          method: r.method,
          status: r.status,
          contentType: r.contentType,
          bodySize: r.bodySize ?? null,
          reason: r.skipped,
        })),
        censusCount: census.length,
        census: census.slice(),
      };
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
        sendResponse({ ok: true, ...buildStatus() });
        return true;
      }

      if (msg?.type === "observerTake") {
        const slug = msg.slug ? String(msg.slug).toLowerCase() : currentSlug();
        sendResponse({
          ok: true,
          installed: nonce !== null,
          slug,
          records: takeRecords(slug),
        });
        return true;
      }

      /**
       * The full diagnostic dump, for the popup's "Copy observed responses".
       *
       * Separate from `observerStatus` because it is bulky and only wanted when
       * someone is looking into a failure — and separate from `observerTake`
       * because the mapping must never see a skipped record.
       */
      if (msg?.type === "observerDiagnostics") {
        sendResponse({ ok: true, ...buildStatus(), ...globalThis.VentureObserved.diagnostics() });
        return true;
      }

      if (msg?.type === "observerClear") {
        buffer.clear();
        pending = [];
        census = [];
        health = null;
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
