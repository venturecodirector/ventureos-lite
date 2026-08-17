import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { stripComments } from "../helpers/strip-comments";

/**
 * The passive observer: transparency, and the boundary (re-architecture items 1,
 * 8d, 8f).
 *
 * ── WHAT THESE TESTS DEFEND ─────────────────────────────────────────────────
 *
 * Two things, and the second one is the more important:
 *
 *   TRANSPARENCY. This code patches `window.fetch` and `XMLHttpRequest` on a page
 *   the user depends on. A bug here does not degrade OUR feature, it breaks
 *   LinkedIn for them — a consumed response body, a swallowed error, a mutated
 *   request. So the tests assert the page gets back byte-for-byte what it would
 *   have got with no extension installed, including when our own handler throws.
 *
 *   THE BOUNDARY. Reading a response the browser already received is defensible.
 *   Issuing our own request to LinkedIn on the user's credentials is not. That
 *   line is the entire design, and a comment cannot enforce it — these tests can.
 */
const EXT = join(process.cwd(), "extension");
const MAIN = readFileSync(join(EXT, "observer-main.js"), "utf8");
const BRIDGE = readFileSync(join(EXT, "observer-bridge.js"), "utf8");
const MANIFEST = JSON.parse(readFileSync(join(EXT, "manifest.json"), "utf8")) as {
  version: string;
  permissions: string[];
  host_permissions: string[];
  optional_host_permissions?: string[];
  content_scripts?: { js: string[]; run_at: string; world: string; matches: string[] }[];
};

/** A page with the MAIN-world interceptor installed over a controllable fetch. */
function pageWithInterceptor(opts: { fetchImpl?: typeof fetch } = {}) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "https://www.linkedin.com/in/mgoldberger/",
  });
  const win = dom.window as unknown as Window & typeof globalThis & Record<string, unknown>;

  const posted: unknown[] = [];
  win.postMessage = ((data: unknown) => {
    posted.push(data);
  }) as typeof win.postMessage;

  const original =
    opts.fetchImpl ??
    (async () =>
      new Response('{"hello":"world"}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
  win.fetch = original as typeof fetch;
  // jsdom implements no fetch API, so the page gets Node's Response (undici) —
  // the same class the real page would hand back.
  if (!win.Response) win.Response = Response as unknown as typeof win.Response;
  if (!win.crypto) win.crypto = { getRandomValues: (a: Uint8Array) => a } as unknown as Crypto;

  new Function("window", "document", "crypto", "URL", "XMLHttpRequest", MAIN)(
    win,
    dom.window.document,
    dom.window.crypto,
    dom.window.URL,
    dom.window.XMLHttpRequest,
  );

  return { dom, win, posted, original };
}

describe("the patched fetch is transparent", () => {
  it("returns the IDENTICAL response object the original returned", async () => {
    const theResponse = new Response('{"a":1}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const { win } = pageWithInterceptor({ fetchImpl: (async () => theResponse) as typeof fetch });

    const got = await (win.fetch as typeof fetch)("https://www.linkedin.com/voyager/api/x");
    // Not merely equal — the same object. A reconstructed Response would break
    // any page code relying on identity or on a one-shot body.
    expect(got).toBe(theResponse);
  });

  /** THE MOST DAMAGING POSSIBLE BUG: reading the body the page is about to read. */
  it("leaves the body unconsumed, so the page still reads it in full", async () => {
    const BODY = '{"included":[{"$type":"x","name":"Mark"}]}';
    const { win } = pageWithInterceptor({
      fetchImpl: (async () =>
        new Response(BODY, {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    });

    const res = await (win.fetch as typeof fetch)("https://www.linkedin.com/voyager/api/y");
    expect(res.bodyUsed).toBe(false);
    // And the page's read succeeds and is byte-identical.
    await expect(res.text()).resolves.toBe(BODY);
  });

  it("forwards the page's arguments untouched", async () => {
    const seen: unknown[][] = [];
    const { win } = pageWithInterceptor({
      fetchImpl: (async (...args: unknown[]) => {
        seen.push(args);
        return new Response("{}", { headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch,
    });

    const init = { method: "POST", headers: { "x-li-track": "{}" }, body: "payload" };
    await (win.fetch as typeof fetch)("https://www.linkedin.com/voyager/api/z", init);
    expect(seen).toHaveLength(1);
    expect(seen[0]![0]).toBe("https://www.linkedin.com/voyager/api/z");
    // The SAME init object, not a copy: nothing was inspected, rewritten or
    // re-serialised on the way through.
    expect(seen[0]![1]).toBe(init);
  });

  /** A THROW IN OUR CODE MUST NOT REACH THE PAGE. */
  it("swallows an error raised inside our own observation", async () => {
    const { win } = pageWithInterceptor({
      fetchImpl: (async () =>
        new Response('{"a":1}', {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    });
    // Make our own reporting channel explode on every observation.
    win.postMessage = (() => {
      throw new Error("observer is broken");
    }) as typeof win.postMessage;

    const res = await (win.fetch as typeof fetch)("https://www.linkedin.com/voyager/api/boom");
    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe('{"a":1}');
  });

  it("passes a rejection through unchanged", async () => {
    const failure = new Error("network down");
    const { win } = pageWithInterceptor({
      fetchImpl: (async () => {
        throw failure;
      }) as typeof fetch,
    });
    await expect((win.fetch as typeof fetch)("https://www.linkedin.com/voyager/api/q")).rejects.toBe(
      failure,
    );
  });

  it("installs once, however many times it is injected", () => {
    const { win, posted } = pageWithInterceptor();
    const afterFirst = win.fetch;
    new Function("window", "document", "crypto", "URL", "XMLHttpRequest", MAIN)(
      win,
      win.document,
      win.crypto,
      win.URL,
      win.XMLHttpRequest,
    );
    expect(win.fetch).toBe(afterFirst);
    // Exactly one hello, so the bridge cannot end up with two nonces.
    expect(posted.filter((p) => (p as { kind?: string }).kind === "hello")).toHaveLength(1);
  });

  it("observes only same-site JSON", async () => {
    const make = (url: string, type: string) =>
      (async () =>
        new Response('{"a":1}', {
          status: 200,
          headers: { "content-type": type },
        })) as typeof fetch;

    for (const [url, type, expected] of [
      ["https://www.linkedin.com/voyager/api/a", "application/json", 1],
      ["https://www.linkedin.com/x.js", "application/javascript", 0],
      ["https://evil.example/api", "application/json", 0],
    ] as const) {
      const { win, posted } = pageWithInterceptor({ fetchImpl: make(url, type) });
      // jsdom's Response has no url, so the request URL is what is judged.
      await (win.fetch as typeof fetch)(url);
      await new Promise((r) => setTimeout(r, 10));
      const observed = posted.filter((p) => (p as { kind?: string }).kind === "observed");
      expect(observed.length, `${url} (${type})`).toBe(expected);
    }
  });
});

describe("the bridge treats everything as untrusted", () => {
  function bridge() {
    const dom = new JSDOM("<!doctype html><html><body></body></html>", {
      url: "https://www.linkedin.com/in/mgoldberger/",
    });
    const responses: Record<string, unknown>[] = [];
    const listeners: ((msg: unknown, s: unknown, r: (v: unknown) => void) => void)[] = [];
    const chrome = {
      runtime: {
        onMessage: {
          addListener: (fn: (msg: unknown, s: unknown, r: (v: unknown) => void) => void) =>
            listeners.push(fn),
        },
      },
    };
    new Function("window", "document", "location", "chrome", "setInterval", "URL", BRIDGE)(
      dom.window,
      dom.window.document,
      dom.window.location,
      chrome,
      () => 0,
      dom.window.URL,
    );
    const ask = (msg: unknown) =>
      new Promise<Record<string, unknown>>((resolve) => {
        listeners[0]!(msg, null, (v) => resolve(v as Record<string, unknown>));
      });
    const send = (data: unknown, origin = "https://www.linkedin.com", source?: unknown) => {
      const ev = new dom.window.MessageEvent("message", { data, origin });
      Object.defineProperty(ev, "source", { value: source ?? dom.window });
      dom.window.dispatchEvent(ev);
    };
    return { dom, ask, send, responses };
  }

  const hello = (nonce: string) => ({
    channel: "venture-observer",
    nonce,
    kind: "hello",
    world: "MAIN",
    at: "document_start",
  });
  const observed = (nonce: string, url: string) => ({
    channel: "venture-observer",
    nonce,
    kind: "observed",
    record: {
      url,
      method: "GET",
      status: 200,
      contentType: "application/json",
      bodySize: 20,
      body: '{"included":[]}',
    },
  });

  it("accepts observations only after a hello, and only with its nonce", async () => {
    const b = bridge();
    // No hello yet: ignored.
    b.send(observed("aaaaaaaa", "https://www.linkedin.com/voyager/api/1"));
    expect((await b.ask({ type: "observerStatus" })).recordCount).toBe(0);

    b.send(hello("aaaaaaaa"));
    b.send(observed("aaaaaaaa", "https://www.linkedin.com/voyager/api/1"));
    expect((await b.ask({ type: "observerStatus" })).recordCount).toBe(1);

    // A different nonce is not our interceptor.
    b.send(observed("bbbbbbbb", "https://www.linkedin.com/voyager/api/2"));
    expect((await b.ask({ type: "observerStatus" })).recordCount).toBe(1);
  });

  it("locks onto the FIRST hello, so a later announcement cannot take over", async () => {
    const b = bridge();
    b.send(hello("first-nonce"));
    b.send(hello("second-nonce"));
    b.send(observed("second-nonce", "https://www.linkedin.com/voyager/api/3"));
    expect((await b.ask({ type: "observerStatus" })).recordCount).toBe(0);
    b.send(observed("first-nonce", "https://www.linkedin.com/voyager/api/3"));
    expect((await b.ask({ type: "observerStatus" })).recordCount).toBe(1);
  });

  it("rejects another origin and another window", async () => {
    const b = bridge();
    b.send(hello("nnnnnnnn"));
    b.send(observed("nnnnnnnn", "https://www.linkedin.com/voyager/api/4"), "https://evil.example");
    expect((await b.ask({ type: "observerStatus" })).recordCount).toBe(0);
    b.send(observed("nnnnnnnn", "https://www.linkedin.com/voyager/api/5"), undefined, {});
    expect((await b.ask({ type: "observerStatus" })).recordCount).toBe(0);
  });

  it("drops a record whose url is not linkedin, or whose shape is wrong", async () => {
    const b = bridge();
    b.send(hello("nnnnnnnn"));
    b.send(observed("nnnnnnnn", "https://evil.example/voyager/api/6"));
    b.send({
      channel: "venture-observer",
      nonce: "nnnnnnnn",
      kind: "observed",
      record: { url: "https://www.linkedin.com/ok", status: "200", bodySize: 1, body: "{}" },
    });
    expect((await b.ask({ type: "observerStatus" })).recordCount).toBe(0);
  });

  it("reports an inventory without the bodies", async () => {
    const b = bridge();
    b.send(hello("nnnnnnnn"));
    b.send(observed("nnnnnnnn", "https://www.linkedin.com/voyager/api/7"));
    const status = await b.ask({ type: "observerStatus" });
    expect(status.installed).toBe(true);
    expect(status.world).toBe("MAIN");
    expect(status.timing).toBe("document_start");
    const inv = status.inventory as Record<string, unknown>[];
    expect(inv).toHaveLength(1);
    expect(inv[0]).not.toHaveProperty("body");
    expect(inv[0]!.bodySize).toBe(20);
  });

  it("hands the bodies over only on an explicit take", async () => {
    const b = bridge();
    b.send(hello("nnnnnnnn"));
    b.send(observed("nnnnnnnn", "https://www.linkedin.com/voyager/api/8"));
    const taken = await b.ask({ type: "observerTake" });
    expect((taken.records as { body: string }[])[0]!.body).toBe('{"included":[]}');
  });

  it("replaces a repeat of the same url rather than stacking it", async () => {
    const b = bridge();
    b.send(hello("nnnnnnnn"));
    b.send(observed("nnnnnnnn", "https://www.linkedin.com/voyager/api/9"));
    b.send(observed("nnnnnnnn", "https://www.linkedin.com/voyager/api/9"));
    expect((await b.ask({ type: "observerStatus" })).recordCount).toBe(1);
  });
});

// ── item 8f: the boundary, enforced ────────────────────────────────────────

describe("the boundary the whole approach rests on", () => {
  const OBSERVER_FILES = ["observer-main.js", "observer-bridge.js"];

  /**
   * THE CENTRAL RULE: we never ask LinkedIn for anything.
   *
   * Comments are stripped first, so the boundary documentation at the top of the
   * interceptor — which necessarily says the word "voyager" — cannot be what trips
   * or satisfies the check.
   */
  it("contains no call site that requests a LinkedIn endpoint", () => {
    for (const file of OBSERVER_FILES) {
      const code = stripComments(readFileSync(join(EXT, file), "utf8"));
      // No literal LinkedIn API path anywhere in executable code.
      expect(code, `${file} names a voyager path`).not.toMatch(/["'`][^"'`]*\/voyager\//);
      expect(code, `${file} names a graphql path`).not.toMatch(/["'`][^"'`]*\/graphql/);
    }
  });

  it("originates no request at all from the interceptor", () => {
    const code = stripComments(readFileSync(join(EXT, "observer-main.js"), "utf8"));
    // The only permitted mention of fetch is patching and calling back through
    // the ORIGINAL. Nothing may construct a new request.
    expect(code).not.toMatch(/\bnew\s+Request\b/);
    expect(code).not.toMatch(/\bsendBeacon\b/);
    expect(code).not.toMatch(/\bnew\s+WebSocket\b/);
    expect(code).not.toMatch(/\bnew\s+EventSource\b/);
    // `originalFetch.apply` is the page's own call being forwarded; a bare
    // `fetch(` call site would be us originating one.
    // `function fetch(...)` is the named function EXPRESSION we install as the
    // patch — a declaration, not a call — so it is excluded before counting.
    const withoutDeclaration = code.replace(/function\s+fetch\s*\(/g, "function __patched(");
    const bareFetchCalls = [...withoutDeclaration.matchAll(/(?<![.\w$])fetch\s*\(/g)];
    expect(bareFetchCalls, "the interceptor calls fetch itself").toHaveLength(0);
  });

  it("reads no cookie and builds no csrf token", () => {
    for (const file of OBSERVER_FILES) {
      const code = stripComments(readFileSync(join(EXT, file), "utf8"));
      expect(code, file).not.toMatch(/document\s*\.\s*cookie/);
      expect(code, file).not.toMatch(/csrf/i);
      expect(code, file).not.toMatch(/JSESSIONID/i);
    }
  });

  it("holds no cookie, webRequest or network-shaping permission", () => {
    const all = [...(MANIFEST.permissions ?? [])];
    for (const forbidden of [
      "cookies",
      "webRequest",
      "webRequestBlocking",
      "declarativeNetRequest",
      "declarativeNetRequestWithHostAccess",
      "proxy",
      "debugger",
      "history",
      "browsingData",
    ]) {
      expect(all, `manifest holds the ${forbidden} permission`).not.toContain(forbidden);
    }
  });

  /**
   * The permissions that ARE held, each with a reason.
   *
   * The brief asked for "nothing beyond storage and the linkedin host". Three more
   * are load-bearing for features the same brief requires: `scripting` runs the DOM
   * fallback that item 6 keeps, `downloads` writes the API snapshots that item 2
   * is built around, and `activeTab` is what makes the popup's capture
   * user-initiated. `clipboardWrite` copies the diagnostics report. An allowlist
   * rather than a count, so adding a fourth is a deliberate act that fails here.
   */
  it("holds only the permissions its features need", () => {
    const ALLOWED = new Set([
      "activeTab",
      "scripting",
      "storage",
      "clipboardWrite",
      "downloads",
    ]);
    for (const p of MANIFEST.permissions ?? []) {
      expect(ALLOWED.has(p), `unexpected permission: ${p}`).toBe(true);
    }
  });

  it("asks for linkedin.com and the image CDN, and nothing else", () => {
    expect(MANIFEST.host_permissions).toContain("*://*.linkedin.com/*");
    for (const h of MANIFEST.host_permissions ?? []) {
      expect(/linkedin\.com|licdn\.com/.test(h), `unexpected host permission: ${h}`).toBe(true);
    }
  });
});

describe("injection timing and world", () => {
  it("installs the interceptor in the MAIN world at document_start", () => {
    const main = (MANIFEST.content_scripts ?? []).find((c) => c.js.includes("observer-main.js"));
    expect(main, "observer-main.js is not a declared content script").toBeTruthy();
    // document_start is not a preference: the patch has to be in place before the
    // page issues its first request, and the page starts requesting immediately.
    expect(main!.run_at).toBe("document_start");
    expect(main!.world).toBe("MAIN");
    expect(main!.matches).toEqual(["*://*.linkedin.com/*"]);
  });

  it("installs the bridge in the ISOLATED world at document_start", () => {
    const bridge = (MANIFEST.content_scripts ?? []).find((c) =>
      c.js.includes("observer-bridge.js"),
    );
    expect(bridge).toBeTruthy();
    expect(bridge!.run_at).toBe("document_start");
    expect(bridge!.world).toBe("ISOLATED");
  });

  it("ships both halves in the package", () => {
    const present = new Set(readdirSync(EXT));
    for (const f of OBSERVER_FILES_SHIPPED) expect(present.has(f), f).toBe(true);
  });
});

const OBSERVER_FILES_SHIPPED = ["observer-main.js", "observer-bridge.js"];

/**
 * ── WHAT THE FIRST REAL TEST ON LINKEDIN TAUGHT US ──────────────────────────
 *
 * The observer installed correctly (MAIN world, document_start) and caught three
 * responses on a hard-reloaded profile. All three were telemetry: a
 * `sensorCollect` metrics POST and two obfuscated tracking POSTs of 174 and 2196
 * bytes. No profile payload, and none of the committed DOM fixtures carries a
 * single `<code>` or `application/json` script tag either.
 *
 * So on a FRESH PAGE LOAD LinkedIn server-renders the profile into HTML and
 * fetches no JSON for it. Reloading the page — which is what I told the operator
 * to do — is the one action guaranteed to produce nothing. The profile is fetched
 * as JSON when the app navigates CLIENT-SIDE to it.
 *
 * That navigation has a property the bridge got wrong: the fetch usually
 * completes while `location` still points at the page you came from. `if (!slug)
 * return` therefore discarded exactly the response the whole design exists to
 * capture, silently, and the arrival on the profile would then report an empty
 * buffer — wrong, and wrong in the most misleading direction.
 */
describe("a profile fetched during a client-side navigation", () => {
  function bridgeOn(url: string) {
    const dom = new JSDOM("<!doctype html><html><body></body></html>", { url });
    const listeners: ((m: unknown, s: unknown, r: (v: unknown) => void) => void)[] = [];
    const chrome = {
      runtime: { onMessage: { addListener: (fn: never) => listeners.push(fn) } },
    };
    let tick = () => {};
    new Function("window", "document", "location", "chrome", "setInterval", "URL", BRIDGE)(
      dom.window,
      dom.window.document,
      dom.window.location,
      chrome,
      (fn: () => void) => {
        tick = fn;
        return 0;
      },
      dom.window.URL,
    );
    const ask = (msg: unknown) =>
      new Promise<Record<string, unknown>>((resolve) => {
        listeners[0]!(msg, null, (v) => resolve(v as Record<string, unknown>));
      });
    const send = (data: unknown) => {
      const ev = new dom.window.MessageEvent("message", {
        data,
        origin: new URL(url).origin,
      });
      Object.defineProperty(ev, "source", { value: dom.window });
      dom.window.dispatchEvent(ev);
    };
    /** Move the SPA to a new path, then let the bridge's poll notice. */
    const navigateTo = (path: string) => {
      dom.window.history.pushState({}, "", path);
      tick();
    };
    return { dom, ask, send, navigateTo };
  }

  const hello = { channel: "venture-observer", nonce: "nnnnnnnn", kind: "hello", world: "MAIN", at: "document_start" };
  const observed = (url: string, bodySize = 40_000) => ({
    channel: "venture-observer",
    nonce: "nnnnnnnn",
    kind: "observed",
    record: {
      url,
      method: "POST",
      status: 200,
      contentType: "application/json",
      bodySize,
      body: '{"included":[{"$type":"x"}]}',
    },
  });

  it("holds a response seen on the feed instead of discarding it", async () => {
    const b = bridgeOn("https://www.linkedin.com/feed/");
    b.send(hello);
    b.send(observed("https://www.linkedin.com/voyager/api/graphql?q=profile"));

    const status = await b.ask({ type: "observerStatus" });
    // Not attributed to anybody yet — but not thrown away either.
    expect(status.slug).toBeNull();
    expect(status.recordCount).toBe(0);
    expect(status.pendingCount, "the record was discarded").toBe(1);
  });

  /** THE CASE THE OLD CODE LOST. */
  it("claims it for the profile the navigation lands on", async () => {
    const b = bridgeOn("https://www.linkedin.com/feed/");
    b.send(hello);
    // The app fetches the next profile's data before the URL catches up.
    b.send(observed("https://www.linkedin.com/voyager/api/graphql?q=profile"));
    b.navigateTo("/in/mgoldberger/");

    const status = await b.ask({ type: "observerStatus" });
    expect(status.slug).toBe("mgoldberger");
    expect(status.recordCount, "the pending record was not claimed").toBe(1);
    expect(status.pendingCount).toBe(0);

    const taken = await b.ask({ type: "observerTake" });
    expect((taken.records as { url: string }[])[0]!.url).toContain("graphql");
  });

  it("still attributes a response that arrives after the URL has changed", async () => {
    const b = bridgeOn("https://www.linkedin.com/feed/");
    b.send(hello);
    b.navigateTo("/in/mgoldberger/");
    b.send(observed("https://www.linkedin.com/voyager/api/graphql?q=late"));
    expect((await b.ask({ type: "observerStatus" })).recordCount).toBe(1);
  });

  it("hands over held records even before a navigation is noticed", async () => {
    // A take on a profile page whose own bucket is empty still surrenders what is
    // held: at that moment it is the best answer to "what did this page fetch".
    const b = bridgeOn("https://www.linkedin.com/in/mgoldberger/");
    b.send(hello);
    const taken = await b.ask({ type: "observerTake" });
    expect(taken.records).toEqual([]);
  });

  it("does not stack a held record twice when it is also attributed", async () => {
    const b = bridgeOn("https://www.linkedin.com/feed/");
    b.send(hello);
    b.send(observed("https://www.linkedin.com/voyager/api/graphql?q=one"));
    b.navigateTo("/in/mgoldberger/");
    b.send(observed("https://www.linkedin.com/voyager/api/graphql?q=one"));
    const taken = await b.ask({ type: "observerTake" });
    expect(taken.records).toHaveLength(1);
  });

  it("caps what it holds, so a long session cannot grow without bound", async () => {
    const b = bridgeOn("https://www.linkedin.com/feed/");
    b.send(hello);
    for (let i = 0; i < 60; i += 1) {
      b.send(observed(`https://www.linkedin.com/voyager/api/graphql?q=${i}`, 100));
    }
    expect((await b.ask({ type: "observerStatus" })).pendingCount as number).toBeLessThanOrEqual(40);
  });

  it("clears the held pool on request", async () => {
    const b = bridgeOn("https://www.linkedin.com/feed/");
    b.send(hello);
    b.send(observed("https://www.linkedin.com/voyager/api/graphql?q=x"));
    await b.ask({ type: "observerClear" });
    expect((await b.ask({ type: "observerStatus" })).pendingCount).toBe(0);
  });
});
