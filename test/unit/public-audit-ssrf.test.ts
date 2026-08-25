import { describe, it, expect, vi } from "vitest";
import { checkUrl } from "../../src/modules/public-audit/guard";
import { guardPublicNavigation } from "../../src/modules/audit/navigation-guard";

/**
 * The public self-serve audit hands a URL from an UNAUTHENTICATED form to a
 * headless browser, which navigates there and screenshots what answers.
 *
 * Verified live before this was written: with no guard, `localtest.me` — an
 * ordinary public domain whose A record is 127.0.0.1 — loaded a loopback-only
 * service in the audit browser and its page text came back readable. With the
 * guard the same navigation fails with ERR_BLOCKED_BY_CLIENT, and example.com
 * still loads.
 */

describe("the text check is not enough on its own", () => {
  it("passes a hostname that resolves to loopback", () => {
    // localtest.me really does resolve to 127.0.0.1. Nothing about the STRING
    // says so, which is the entire point: this test exists so nobody later
    // concludes that checkUrl is a sufficient SSRF guard and drops the DNS one.
    expect(checkUrl("localtest.me").ok).toBe(true);
    expect(checkUrl("https://sub.example.com/x").ok).toBe(true);
  });

  it("still catches the shapes it was written for", () => {
    for (const raw of ["localhost", "127.0.0.1", "10.0.0.5", "192.168.1.1", "printer.local"]) {
      expect(checkUrl(raw).ok, raw).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------

interface FakeRoute {
  url: string;
  continued: boolean;
  aborted: string | null;
}

/** Enough of a BrowserContext to capture the route handler and drive it. */
function fakeContext() {
  let handler: ((route: unknown) => Promise<unknown>) | null = null;
  const context = {
    route: vi.fn(async (_pattern: string, h: (route: unknown) => Promise<unknown>) => {
      handler = h;
    }),
  };
  const send = async (url: string): Promise<FakeRoute> => {
    const state: FakeRoute = { url, continued: false, aborted: null };
    const route = {
      request: () => ({ url: () => url }),
      continue: async () => {
        state.continued = true;
      },
      abort: async (reason: string) => {
        state.aborted = reason;
      },
    };
    await handler!(route);
    return state;
  };
  return { context, send };
}

describe("guardPublicNavigation", () => {
  it("blocks a public-looking host that resolves inward", async () => {
    const { context, send } = fakeContext();
    const resolve = vi.fn(async () => false); // "its A record points at 127.0.0.1"
    await guardPublicNavigation(context as never, resolve);

    const r = await send("http://localtest.me:8099/");
    expect(r.aborted).toBe("blockedbyclient");
    expect(r.continued).toBe(false);
  });

  it("lets an ordinary public request through", async () => {
    const { context, send } = fakeContext();
    await guardPublicNavigation(context as never, async () => true);
    const r = await send("https://example.com/style.css");
    expect(r.continued).toBe(true);
    expect(r.aborted).toBeNull();
  });

  it("blocks by hostname without asking the resolver at all", async () => {
    const { context, send } = fakeContext();
    const resolve = vi.fn(async () => true); // would say yes — must not be consulted
    await guardPublicNavigation(context as never, resolve);

    for (const url of [
      "http://localhost:6379/",
      "http://127.0.0.1/",
      "http://169.254.169.254/latest/meta-data/",
      "http://db:5432/",
    ]) {
      expect((await send(url)).aborted, url).toBe("blockedbyclient");
    }
    expect(resolve).not.toHaveBeenCalled();
  });

  /**
   * The reason this lives in the browser and not only at the intake: every one
   * of these is a request the page makes AFTER we approved the original URL.
   */
  it("judges each request, so a redirect or subresource cannot slip past", async () => {
    const { context, send } = fakeContext();
    const resolve = vi.fn(async (host: string) => host === "example.com");
    await guardPublicNavigation(context as never, resolve);

    expect((await send("https://example.com/")).continued).toBe(true);
    // …which then redirects, or pulls an image, from somewhere internal:
    expect((await send("https://internal.example.net/")).aborted).toBe("blockedbyclient");
  });

  it("resolves each host once per context, however many assets it serves", async () => {
    const { context, send } = fakeContext();
    const resolve = vi.fn(async () => true);
    await guardPublicNavigation(context as never, resolve);

    await send("https://cdn.example.com/a.js");
    await send("https://cdn.example.com/b.css");
    await send("https://cdn.example.com/c.png");
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("leaves inline data and blob URLs alone", async () => {
    const { context, send } = fakeContext();
    const resolve = vi.fn(async () => false);
    await guardPublicNavigation(context as never, resolve);

    expect((await send("data:image/png;base64,iVBORw0KGgo=")).continued).toBe(true);
    expect((await send("about:blank")).continued).toBe(true);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("refuses a request whose URL will not parse", async () => {
    const { context, send } = fakeContext();
    await guardPublicNavigation(context as never, async () => true);
    expect((await send("http://[not a url")).aborted).toBe("blockedbyclient");
  });
});
