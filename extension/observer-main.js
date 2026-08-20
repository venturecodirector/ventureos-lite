/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  PASSIVE RESPONSE OBSERVER — MAIN world, document_start                   ║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║                                                                          ║
 * ║  WHAT THIS IS PERMITTED TO DO                                            ║
 * ║                                                                          ║
 * ║    Watch responses that LINKEDIN'S OWN FRONTEND already requested, for    ║
 * ║    the page the user is currently looking at, and copy the JSON out of    ║
 * ║    them. Nothing else. It is a tap on a pipe that was already flowing.    ║
 * ║                                                                          ║
 * ║    It also keeps a CENSUS: for every response it declines to copy, the    ║
 * ║    url and the reason, with no body; and from the browser's own resource  ║
 * ║    timeline, the paths the document loaded — query strings stripped,      ║
 * ║    because that is where identifiers live. Both are diagnostics, shown    ║
 * ║    to the operator when a capture found nothing. Reading a list the       ║
 * ║    browser maintains for its own purposes asks LinkedIn for nothing.      ║
 * ║                                                                          ║
 * ║  WHAT IT IS FORBIDDEN TO DO — permanently, not pending a redesign        ║
 * ║                                                                          ║
 * ║    ✗ ISSUE A REQUEST TO LINKEDIN. Not to /voyager/, not to a GraphQL      ║
 * ║      endpoint, not to anything. This file contains no call site that      ║
 * ║      originates a network request, and a test greps for one.              ║
 * ║    ✗ CONSTRUCT OR READ A CSRF TOKEN. If we are not making requests we do  ║
 * ║      not need one, and having one is the first step toward making them.   ║
 * ║    ✗ READ COOKIES. The extension does not hold the `cookies` permission   ║
 * ║      and must never request it.                                           ║
 * ║    ✗ ALTER A REQUEST OR A RESPONSE. Arguments are forwarded untouched and ║
 * ║      the page receives the ORIGINAL response object. We read a clone.     ║
 * ║    ✗ RUN WITHOUT THE USER. Observation fills a buffer; nothing is sent    ║
 * ║      anywhere until the user presses Capture on a profile they opened.    ║
 * ║    ✗ CRAWL. There is no queue, no list of profiles, no navigation. One    ║
 * ║      page at a time, the one on screen.                                   ║
 * ║                                                                          ║
 * ║  WHY THE DISTINCTION MATTERS                                             ║
 * ║                                                                          ║
 * ║    Reading a response the browser already received for a page the user is ║
 * ║    already looking at is the same information the DOM extractor was       ║
 * ║    reading — just before LinkedIn's UI layer mangles it into hashed       ║
 * ║    classes and lazy-mounted sections. Issuing our own request is a        ║
 * ║    categorically different act: it is automated access to a service on    ║
 * ║    the user's credentials, at a rate and pattern they did not choose.     ║
 * ║    The first is defensible; the second is not. That line is the whole     ║
 * ║    design, and it is why this file cannot fetch.                          ║
 * ║                                                                          ║
 * ║  IF YOU ARE EDITING THIS FILE                                            ║
 * ║                                                                          ║
 * ║    Any change that introduces a fetch/XHR/sendBeacon/WebSocket call site  ║
 * ║    here, or that adds the cookies/webRequest permission to the manifest,  ║
 * ║    is out of bounds regardless of how convenient it is. Tests enforce     ║
 * ║    both. If observation stops working, re-record snapshots — do not       ║
 * ║    start asking LinkedIn directly.                                        ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * ── THE HOST PERMISSIONS, AND WHY THEY ARE WHAT THEY ARE ────────────────────
 *
 * `*://*.linkedin.com/*` so this file can be DECLARED at document_start — a
 * dynamically registered script cannot reliably beat the page's own scripts, and
 * the patch has to be in place before the first request. `media.licdn.com` so the
 * SERVICE WORKER can retrieve avatar bytes: those URLs are signed and refuse both
 * an unauthenticated server fetch and a cross-origin page fetch. No cookies, no
 * webRequest, no declarativeNetRequest — this extension never issues a request to
 * LinkedIn and never reads a credential.
 *
 * (This note lived in manifest.json as a `_comment_` key, which Chrome flags as an
 * unrecognised manifest key. A warning on an extension whose content scripts are
 * not appearing is a variable nobody needs, so it moved here.)
 *
 * ── WHY THE MAIN WORLD ──────────────────────────────────────────────────────
 *
 * A content script's `window.fetch` is the ISOLATED world's copy. The page has
 * its own, and patching ours observes nothing the page does. So this runs in the
 * MAIN world and hands what it sees to an isolated-world bridge by postMessage,
 * which is the only channel between the two.
 *
 * ── TRANSPARENCY IS THE FIRST REQUIREMENT ───────────────────────────────────
 *
 * A bug in here must be incapable of breaking LinkedIn for the user. So: the
 * original functions are kept and always called; arguments are forwarded without
 * inspection; the page always receives the original object; and every line of
 * our own work sits inside try/catch. If our observation throws, the page never
 * learns that anything happened.
 */
(() => {
  const MARK = "__ventureObserverInstalled";
  // Double-installation guard. Re-injection is normal — a soft navigation, a
  // second registration — and patching a patch would double every message.
  if (window[MARK]) return;
  try {
    Object.defineProperty(window, MARK, { value: true, configurable: false, enumerable: false });
  } catch {
    window[MARK] = true;
  }

  /**
   * A per-page secret, generated before any page script has run.
   *
   * document_start means we are first, which is what makes this worth anything:
   * the bridge locks onto the first `hello` it sees and ignores every later one,
   * so a page script cannot announce itself as the observer afterwards. Messages
   * are in any case only OBSERVATIONS, and the bridge validates their shape —
   * the nonce raises the cost of noise, it is not the only thing standing between
   * the page and our buffer.
   */
  const NONCE = (() => {
    try {
      const a = new Uint8Array(16);
      crypto.getRandomValues(a);
      return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
    } catch {
      return `n${Date.now()}${Math.random().toString(16).slice(2)}`;
    }
  })();

  const CHANNEL = "venture-observer";
  /** Bodies larger than this are noted but not copied. A feed page is megabytes. */
  const MAX_BODY_BYTES = 2_000_000;

  const post = (payload) => {
    try {
      window.postMessage({ channel: CHANNEL, nonce: NONCE, ...payload }, window.location.origin);
    } catch {
      /* a structured-clone failure must not reach the page */
    }
  };

  /**
   * Is this worth copying, and if not, WHY not?
   *
   * A verdict rather than a boolean, because the reason is the thing we were
   * missing. When a capture found nothing, the old filter had already discarded
   * every response it declined — so there was no way to tell "the page fetched no
   * JSON" from "the page fetched something and we skipped it". Those two need
   * completely different fixes, and we spent three rounds unable to tell them
   * apart. A declined response is now announced WITHOUT ITS BODY and with the
   * reason, so the difference is visible.
   *
   * Still deliberately NOT a list of known LinkedIn endpoints: the recorder's job
   * is to tell us what the endpoints are, and a filter written from assumptions
   * would hide exactly what we need to discover.
   */
  const SKIP_OFF_SITE = "off_site";
  const SKIP_NO_TYPE = "no_content_type";
  const SKIP_NOT_JSON = "content_type_not_json";
  const verdictFor = (url, contentType) => {
    try {
      const u = new URL(url, window.location.href);
      if (!/(^|\.)linkedin\.com$/i.test(u.hostname)) return { copy: false, reason: SKIP_OFF_SITE };
      if (!contentType) {
        // Sniff instead of discarding: an API that returns JSON under no
        // content-type at all was previously invisible, and "invisible" is the
        // one outcome that cost us weeks.
        return { copy: true, sniff: true, reason: SKIP_NO_TYPE };
      }
      if (/\bjson\b/i.test(contentType)) return { copy: true, sniff: false, reason: null };
      // text/plain is the other way an API hides. Anything else (html, images,
      // fonts, css) is recorded as skipped and never read.
      if (/\btext\/plain\b/i.test(contentType)) {
        return { copy: true, sniff: true, reason: SKIP_NOT_JSON };
      }
      return { copy: false, reason: SKIP_NOT_JSON };
    } catch {
      return { copy: false, reason: SKIP_OFF_SITE };
    }
  };

  /** Does this text look like a JSON document? Cheap, and never throws. */
  const looksLikeJson = (text) => {
    const head = text.slice(0, 200).trimStart();
    return head.startsWith("{") || head.startsWith("[");
  };

  const announce = (record) => {
    post({ kind: "observed", record });
  };

  // ---- fetch ---------------------------------------------------------------
  /** Our installed patches, so the census can report if either was replaced. */
  let patchedFetch = null;
  let patchedOpen = null;
  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    const patched = function fetch(...args) {
      // The page's call, forwarded untouched. Nothing below may change this.
      const promise = originalFetch.apply(this, args);
      try {
        promise.then(
          (response) => {
            try {
              observeResponse(response, args);
            } catch {
              /* never surface our own failure into the page's promise chain */
            }
            return response;
          },
          () => {
            /* a failed request is the page's business, not ours */
          },
        );
      } catch {
        /* if even attaching the observer throws, the page still gets its promise */
      }
      // THE ORIGINAL PROMISE, not a derived one: the page must receive exactly
      // what the original fetch returned, including identity of the Response.
      return promise;
    };
    try {
      Object.defineProperty(patched, "name", { value: "fetch" });
      Object.defineProperty(patched, "toString", {
        value: () => originalFetch.toString(),
        configurable: true,
      });
    } catch {
      /* cosmetic only */
    }
    window.fetch = patched;
    patchedFetch = patched;
  }

  function observeResponse(response, args) {
    if (!response || typeof response.clone !== "function") return;
    const contentType = response.headers?.get?.("content-type") ?? "";
    const url = response.url || String(args?.[0] ?? "");
    const verdict = verdictFor(url, contentType);

    const method = (() => {
      try {
        if (args?.[1]?.method) return String(args[1].method).toUpperCase();
        if (args?.[0] && typeof args[0] === "object" && args[0].method) {
          return String(args[0].method).toUpperCase();
        }
      } catch {
        /* fall through */
      }
      return "GET";
    })();

    // A declined response is still reported — url, size and the reason, never a
    // body. This is the record that tells us whether the payload went past us.
    if (!verdict.copy) {
      announce({
        url,
        method,
        status: response.status,
        contentType,
        bodySize: null,
        truncated: false,
        body: null,
        skipped: verdict.reason,
        via: "fetch",
      });
      return;
    }

    /**
     * A CLONE. Reading `response.body` would consume the stream the page is about
     * to read, and the page would get an empty body — the single most damaging
     * thing this file could do.
     */
    let clone;
    try {
      clone = response.clone();
    } catch {
      announce({
        url,
        method,
        status: response.status,
        contentType,
        bodySize: null,
        truncated: false,
        body: null,
        skipped: "clone_failed",
        via: "fetch",
      });
      return;
    }
    clone
      .text()
      .then((text) => {
        try {
          if (typeof text !== "string" || text.length === 0) return;
          // Sniffed candidates (no content type, or text/plain) are kept only if
          // they actually look like JSON. Everything else is recorded as skipped,
          // so the census still shows it was there.
          if (verdict.sniff && !looksLikeJson(text)) {
            announce({
              url,
              method,
              status: response.status,
              contentType,
              bodySize: text.length,
              truncated: false,
              body: null,
              skipped: verdict.reason,
              via: "fetch",
            });
            return;
          }
          if (text.length > MAX_BODY_BYTES) {
            announce({
              url,
              method,
              status: response.status,
              contentType,
              bodySize: text.length,
              truncated: true,
              body: null,
              via: "fetch",
            });
            return;
          }
          announce({
            url,
            method,
            status: response.status,
            contentType,
            bodySize: text.length,
            truncated: false,
            body: text,
            via: "fetch",
          });
        } catch {
          /* nothing to do */
        }
      })
      .catch(() => {
        /* a clone that cannot be read is not the page's problem */
      });
  }

  // ---- XMLHttpRequest ------------------------------------------------------
  const XHR = window.XMLHttpRequest;
  if (typeof XHR === "function" && XHR.prototype) {
    const originalOpen = XHR.prototype.open;
    const originalSend = XHR.prototype.send;

    XHR.prototype.open = function open(method, url, ...rest) {
      try {
        this.__ventureMethod = String(method ?? "GET").toUpperCase();
        this.__ventureUrl = String(url ?? "");
      } catch {
        /* a frozen XHR is still the page's to use */
      }
      return originalOpen.apply(this, [method, url, ...rest]);
    };
    patchedOpen = XHR.prototype.open;

    XHR.prototype.send = function send(...args) {
      try {
        this.addEventListener("loadend", () => {
          try {
            const contentType = this.getResponseHeader?.("content-type") ?? "";
            const url = this.responseURL || this.__ventureUrl || "";
            const verdict = verdictFor(url, contentType);
            if (!verdict.copy) {
              announce({
                url,
                method: this.__ventureMethod ?? "GET",
                status: this.status,
                contentType,
                bodySize: null,
                truncated: false,
                body: null,
                skipped: verdict.reason,
                via: "xhr",
              });
              return;
            }
            // Only the response types that are already text. Touching `response`
            // on an arraybuffer/blob request would decode something the page
            // never asked us to decode — so it is recorded as skipped instead.
            const type = this.responseType;
            if (type !== "" && type !== "text" && type !== "json") {
              announce({
                url,
                method: this.__ventureMethod ?? "GET",
                status: this.status,
                contentType,
                bodySize: null,
                truncated: false,
                body: null,
                skipped: `response_type_${type}`,
                via: "xhr",
              });
              return;
            }
            const text =
              type === "json"
                ? (() => {
                    try {
                      return JSON.stringify(this.response);
                    } catch {
                      return null;
                    }
                  })()
                : this.responseText;
            if (typeof text !== "string" || text.length === 0) return;
            if (verdict.sniff && !looksLikeJson(text)) {
              announce({
                url,
                method: this.__ventureMethod ?? "GET",
                status: this.status,
                contentType,
                bodySize: text.length,
                truncated: false,
                body: null,
                skipped: verdict.reason,
                via: "xhr",
              });
              return;
            }
            const tooBig = text.length > MAX_BODY_BYTES;
            announce({
              url,
              method: this.__ventureMethod ?? "GET",
              status: this.status,
              contentType,
              bodySize: text.length,
              truncated: tooBig,
              body: tooBig ? null : text,
              via: "xhr",
            });
          } catch {
            /* never let an observation failure reach the page's handler */
          }
        });
      } catch {
        /* if we cannot listen, the request still goes ahead untouched */
      }
      return originalSend.apply(this, args);
    };
  }

  // ---- the resource census -------------------------------------------------
  /**
   * WHAT THE PAGE FETCHED, whether or not it went through our patches.
   *
   * ── WHY THIS IS THE MISSING PIECE ─────────────────────────────────────────
   *
   * Patching `window.fetch` at document_start sees everything the page's own
   * code does with the page's own fetch. It does NOT see:
   *
   *   · a request issued from a Worker or a Service Worker, which have their own
   *     global scope and their own fetch;
   *   · a request issued through a "clean" function taken from another realm —
   *     `document.createElement("iframe").contentWindow.fetch` is a well-known
   *     way to get an unpatched copy, and an app that does it is invisible to us;
   *   · anything at all, if our patch was replaced afterwards.
   *
   * So when a capture came back with nothing, we could not tell whether the
   * profile payload had never been requested or had gone past us by one of those
   * routes. Three rounds of investigation ended in that ambiguity.
   *
   * The browser already keeps a list. `PerformanceObserver` on resource timings
   * reports every load the document made, by whichever mechanism — and it is a
   * READ of a timeline the browser maintains for its own reasons. It issues
   * nothing, asks LinkedIn for nothing, and cannot see any BODY. URLs only.
   *
   * The query string is stripped before the entry leaves this file: it is where
   * identifiers and tokens live, and a path is all a census needs.
   */
  const CENSUS_MAX = 200;
  const seenResources = new Set();
  const censusQueue = [];
  let censusTimer = null;

  const flushCensus = () => {
    censusTimer = null;
    if (censusQueue.length === 0) return;
    const entries = censusQueue.splice(0, censusQueue.length);
    post({
      kind: "census",
      entries,
      // Checked at flush time rather than at install: if the page replaced our
      // patch afterwards, this is the only way we would ever find out.
      health: {
        fetchPatched: window.fetch === patchedFetch,
        xhrOpenPatched: XHR ? XHR.prototype.open === patchedOpen : null,
      },
    });
  };

  const noteResource = (entry) => {
    try {
      const raw = String(entry.name ?? "");
      const u = new URL(raw, window.location.href);
      if (!/(^|\.)linkedin\.com$/i.test(u.hostname)) return;
      // Path only. The query carries identifiers; the census does not need them.
      const path = `${u.origin}${u.pathname}`;
      const key = `${entry.initiatorType}|${path}`;
      if (seenResources.has(key)) return;
      if (seenResources.size >= CENSUS_MAX) return;
      seenResources.add(key);
      censusQueue.push({
        path,
        initiatorType: String(entry.initiatorType ?? ""),
        transferSize: typeof entry.transferSize === "number" ? entry.transferSize : null,
        // How much came back, which is what tells a payload from a ping.
        decodedBodySize:
          typeof entry.decodedBodySize === "number" ? entry.decodedBodySize : null,
      });
      if (censusTimer === null) censusTimer = setTimeout(flushCensus, 400);
    } catch {
      /* a resource we cannot parse is not worth a line */
    }
  };

  try {
    const PO = window.PerformanceObserver;
    if (typeof PO === "function") {
      const observer = new PO((list) => {
        try {
          for (const entry of list.getEntries()) noteResource(entry);
        } catch {
          /* never surface our own failure into the page */
        }
      });
      // `buffered` picks up what loaded before this ran — which, at
      // document_start, should be nothing, but a missed early request is exactly
      // the kind of thing this census exists to catch.
      observer.observe({ type: "resource", buffered: true });
    }
  } catch {
    /* no census on a browser that has no observer; everything else still works */
  }

  // The bridge is waiting for this and locks onto the first one it sees.
  post({ kind: "hello", world: "MAIN", at: "document_start", url: window.location.href });
})();
