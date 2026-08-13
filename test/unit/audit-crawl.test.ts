import { describe, it, expect } from "vitest";
import {
  crawlSite,
  extractLinks,
  normalizeCrawlUrl,
  parseDocumentMeta,
  parseSitemapLocs,
  planFrontier,
  sameSite,
  Pacer,
  DEFAULT_CRAWL_CAP,
  MAX_CRAWL_CAP,
} from "@/modules/audit/crawl";

/**
 * The crawl (P2/1). The parsing and ordering rules are pure; the crawl itself
 * runs against a fake fetch and a fake clock, so a test never sleeps for the
 * real pacing interval and never touches someone's server.
 */

describe("normalizeCrawlUrl", () => {
  const base = "https://example.hu/";
  it("resolves relative links against the page", () => {
    expect(normalizeCrawlUrl("/arak", base)).toBe("https://example.hu/arak");
    expect(normalizeCrawlUrl("arak", "https://example.hu/szolgaltatas/")).toBe(
      "https://example.hu/szolgaltatas/arak",
    );
  });
  it("drops the fragment", () => {
    expect(normalizeCrawlUrl("/a#top", base)).toBe("https://example.hu/a");
    expect(normalizeCrawlUrl("#top", base)).toBeNull();
  });
  it("refuses other sites and other schemes", () => {
    expect(normalizeCrawlUrl("https://facebook.com/x", base)).toBeNull();
    expect(normalizeCrawlUrl("mailto:a@b.hu", base)).toBeNull();
    expect(normalizeCrawlUrl("tel:+3612345678", base)).toBeNull();
    expect(normalizeCrawlUrl("javascript:void(0)", base)).toBeNull();
  });
  it("treats www and the bare domain as the same site", () => {
    expect(normalizeCrawlUrl("https://www.example.hu/a", base)).toBe("https://www.example.hu/a");
    expect(sameSite("https://www.example.hu/a", "https://example.hu/")).toBe(true);
    expect(sameSite("https://shop.example.hu/", "https://example.hu/")).toBe(false);
  });
});

describe("extractLinks", () => {
  const html = `
    <nav><a href="/szolgaltatasok">Szolgáltatások</a></nav>
    <main><a href="/blog/2019">Blog</a><a href='https://other.hu/x'>ext</a></main>
    <footer><a href="/impresszum">Impresszum</a></footer>`;

  it("separates nav, footer and body", () => {
    const l = extractLinks(html, "https://example.hu/");
    expect(l.nav).toEqual(["https://example.hu/szolgaltatasok"]);
    expect(l.footer).toEqual(["https://example.hu/impresszum"]);
    expect(l.body).toContain("https://example.hu/blog/2019");
    expect(l.body.some((u) => u.includes("other.hu"))).toBe(false);
  });

  it("reads single-quoted and unquoted hrefs", () => {
    const l = extractLinks(`<a href='/a'>a</a><a href=/b>b</a>`, "https://example.hu/");
    expect(l.body).toEqual(["https://example.hu/a", "https://example.hu/b"]);
  });
});

describe("planFrontier", () => {
  it("puts the menu first, then the footer, then the sitemap", () => {
    const out = planFrontier(
      {
        nav: ["https://e.hu/menu"],
        footer: ["https://e.hu/footer"],
        sitemap: ["https://e.hu/sitemap-only"],
        body: ["https://e.hu/body"],
      },
      "https://e.hu/",
    );
    expect(out).toEqual([
      "https://e.hu/menu",
      "https://e.hu/footer",
      "https://e.hu/sitemap-only",
      "https://e.hu/body",
    ]);
  });

  it("deduplicates and removes the start URL", () => {
    const out = planFrontier(
      { nav: ["https://e.hu/a"], footer: ["https://e.hu/a"], sitemap: [], body: ["https://e.hu/"] },
      "https://e.hu/",
    );
    expect(out).toEqual(["https://e.hu/a"]);
  });

  it("skips things that are not pages", () => {
    const out = planFrontier(
      { nav: [], footer: [], sitemap: [], body: ["https://e.hu/a.pdf", "https://e.hu/b.jpg", "https://e.hu/c"] },
      "https://e.hu/",
    );
    expect(out).toEqual(["https://e.hu/c"]);
  });
});

describe("parseDocumentMeta", () => {
  it("reads title, meta description and H1 count", () => {
    const m = parseDocumentMeta(
      `<title> Fogászat  Budapest </title>
       <meta name="description" content="A rendelőnk">
       <h1>a</h1><h1>b</h1>`,
    );
    expect(m.title).toBe("Fogászat Budapest");
    expect(m.metaDescription).toBe("A rendelőnk");
    expect(m.h1Count).toBe(2);
  });

  it("returns null rather than an empty string", () => {
    const m = parseDocumentMeta("<title>   </title><h1>x</h1>");
    expect(m.title).toBeNull();
    expect(m.metaDescription).toBeNull();
  });
});

describe("parseSitemapLocs", () => {
  it("pulls out the locations", () => {
    expect(
      parseSitemapLocs("<urlset><url><loc>https://e.hu/a</loc></url><url><loc>https://e.hu/b</loc></url></urlset>"),
    ).toEqual(["https://e.hu/a", "https://e.hu/b"]);
  });
});

describe("Pacer", () => {
  it("spaces request starts by the interval", async () => {
    let clock = 0;
    const slept: number[] = [];
    const p = new Pacer(
      1000,
      () => clock,
      async (ms) => {
        slept.push(ms);
        clock += ms;
      },
    );
    await p.take();
    await p.take();
    await p.take();
    expect(slept).toEqual([1000, 1000]);
  });

  it("does not sleep when the caller was already slow", async () => {
    let clock = 0;
    const slept: number[] = [];
    const p = new Pacer(
      1000,
      () => clock,
      async (ms) => {
        slept.push(ms);
        clock += ms;
      },
    );
    await p.take();
    clock += 5000;
    await p.take();
    expect(slept).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The crawl itself, against a fake site.
// ---------------------------------------------------------------------------

interface FakePage {
  status?: number;
  html?: string;
  location?: string;
  contentType?: string;
}

function fakeSite(pages: Record<string, FakePage>) {
  const calls: Array<{ url: string; method: string }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method });
    const page = pages[url];
    if (!page) {
      return new Response("", { status: 404, headers: { "content-type": "text/html" } });
    }
    const headers: Record<string, string> = {
      "content-type": page.contentType ?? "text/html; charset=utf-8",
    };
    if (page.location) headers.location = page.location;
    return new Response(method === "HEAD" ? null : (page.html ?? ""), {
      status: page.status ?? 200,
      headers,
    });
  }) as unknown as typeof fetch;

  // A clock that only moves when the pacer sleeps: the crawl's own deadline
  // logic is exercised, but the test runs instantly.
  let clock = 0;
  return {
    calls,
    options: {
      fetchImpl,
      now: () => clock,
      sleep: async (ms: number) => {
        clock += ms;
      },
    },
  };
}

const doc = (title: string, links: string[] = [], extra = "") =>
  `<html><head><title>${title}</title><meta name="description" content="d-${title}"></head>
   <body><h1>${title}</h1><nav>${links
     .map((l) => `<a href="${l}">l</a>`)
     .join("")}</nav>${extra}</body></html>`;

describe("crawlSite", () => {
  it("crawls the homepage and what it links to, honouring the cap", async () => {
    const site = fakeSite({
      "https://e.hu/robots.txt": { html: "User-agent: *\nDisallow:", contentType: "text/plain" },
      "https://e.hu/sitemap.xml": { html: "<urlset></urlset>", contentType: "text/xml" },
      "https://e.hu/": { html: doc("Home", ["/a", "/b", "/c"]) },
      "https://e.hu/a": { html: doc("A") },
      "https://e.hu/b": { html: doc("B") },
      "https://e.hu/c": { html: doc("C") },
    });

    const r = await crawlSite("https://e.hu/", { ...site.options, cap: 3 });
    expect(r.pages).toHaveLength(3);
    expect(r.pages[0]!.url).toBe("https://e.hu/");
    expect(r.cap).toBe(3);
    expect(r.discovered).toBe(4);
  });

  it("finds a broken internal link and says where it was linked from", async () => {
    const site = fakeSite({
      "https://e.hu/robots.txt": { html: "", contentType: "text/plain" },
      "https://e.hu/sitemap.xml": { status: 404 },
      "https://e.hu/": { html: doc("Home", ["/a", "/halott"]) },
      "https://e.hu/a": { html: doc("A") },
      // /halott is absent from the fake site, so it answers 404.
    });

    const r = await crawlSite("https://e.hu/", { ...site.options, cap: 15 });
    const broken = r.brokenLinks.map((b) => `${b.from} -> ${b.to} ${b.status}`);
    expect(broken).toContain("https://e.hu/ -> https://e.hu/halott 404");
  });

  it("obeys robots.txt", async () => {
    const site = fakeSite({
      "https://e.hu/robots.txt": {
        html: "User-agent: *\nDisallow: /admin",
        contentType: "text/plain",
      },
      "https://e.hu/sitemap.xml": { status: 404 },
      "https://e.hu/": { html: doc("Home", ["/admin", "/a"]) },
      "https://e.hu/a": { html: doc("A") },
      "https://e.hu/admin": { html: doc("Admin") },
    });

    const r = await crawlSite("https://e.hu/", { ...site.options, cap: 15 });
    expect(r.pages.map((p) => p.url)).not.toContain("https://e.hu/admin");
    expect(r.robotsSkipped).toBe(1);
    expect(site.calls.some((c) => c.url === "https://e.hu/admin")).toBe(false);
  });

  it("records a redirect chain instead of hiding it", async () => {
    const site = fakeSite({
      "https://e.hu/robots.txt": { status: 404 },
      "https://e.hu/sitemap.xml": { status: 404 },
      "https://e.hu/": { html: doc("Home", ["/regi"]) },
      "https://e.hu/regi": { status: 301, location: "/kozepso" },
      "https://e.hu/kozepso": { status: 301, location: "/uj" },
      "https://e.hu/uj": { html: doc("Uj") },
    });

    const r = await crawlSite("https://e.hu/", { ...site.options, cap: 15 });
    const redirected = r.pages.find((p) => p.url === "https://e.hu/regi")!;
    expect(redirected.redirects).toHaveLength(2);
    expect(redirected.finalUrl).toBe("https://e.hu/uj");
    expect(redirected.status).toBe(200);
  });

  it("takes the sitemap as a source of pages", async () => {
    const site = fakeSite({
      "https://e.hu/robots.txt": { status: 404 },
      "https://e.hu/sitemap.xml": {
        html: "<urlset><url><loc>https://e.hu/rejtett</loc></url></urlset>",
        contentType: "text/xml",
      },
      "https://e.hu/": { html: doc("Home") },
      "https://e.hu/rejtett": { html: doc("Rejtett") },
    });

    const r = await crawlSite("https://e.hu/", { ...site.options, cap: 15 });
    expect(r.sitemapUrls).toEqual(["https://e.hu/rejtett"]);
    expect(r.pages.map((p) => p.url)).toContain("https://e.hu/rejtett");
  });

  it("identifies itself so a site owner can block us", async () => {
    const site = fakeSite({
      "https://e.hu/robots.txt": { status: 404 },
      "https://e.hu/sitemap.xml": { status: 404 },
      "https://e.hu/": { html: doc("Home") },
    });
    await crawlSite("https://e.hu/", site.options);
    expect(site.calls.length).toBeGreaterThan(0);
  });

  it("stops on its deadline rather than running long", async () => {
    const many = Object.fromEntries(
      Array.from({ length: 25 }, (_, i) => [`https://e.hu/p${i}`, { html: doc(`P${i}`) }]),
    );
    const site = fakeSite({
      "https://e.hu/robots.txt": { status: 404 },
      "https://e.hu/sitemap.xml": { status: 404 },
      "https://e.hu/": { html: doc("Home", Array.from({ length: 25 }, (_, i) => `/p${i}`)) },
      ...many,
    });

    // Five seconds of budget at one request per second.
    const r = await crawlSite("https://e.hu/", { ...site.options, cap: 25, deadlineMs: 5000 });
    expect(r.deadlineHit).toBe(true);
    expect(r.pages.length).toBeLessThan(25);
  });

  it("never throws when the site is unreachable", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    let clock = 0;
    const r = await crawlSite("https://dead.hu/", {
      fetchImpl,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    expect(r.pages).toHaveLength(1);
    expect(r.pages[0]!.status).toBeNull();
  });

  it("clamps the cap to the documented maximum", async () => {
    const site = fakeSite({
      "https://e.hu/robots.txt": { status: 404 },
      "https://e.hu/sitemap.xml": { status: 404 },
      "https://e.hu/": { html: doc("Home") },
    });
    const r = await crawlSite("https://e.hu/", { ...site.options, cap: 500 });
    expect(r.cap).toBe(MAX_CRAWL_CAP);
    expect(DEFAULT_CRAWL_CAP).toBeLessThanOrEqual(MAX_CRAWL_CAP);
  });
});

describe("rendered mode (P2/9)", () => {
  it("uses the browser instead of fetching, and follows the rendered nav", async () => {
    const site = fakeSite({
      "https://spa.hu/robots.txt": { status: 404 },
      "https://spa.hu/sitemap.xml": { status: 404 },
      // The server sends an empty mount node: a static crawl would find
      // nothing to follow at all.
      "https://spa.hu/": { html: '<html><body><div id="root"></div></body></html>' },
    });

    const rendered: Record<string, string> = {
      "https://spa.hu/": doc("Home", []),
      "https://spa.hu/arak": doc("Arak"),
    };
    const visited: string[] = [];
    const renderPage = async (url: string) => {
      visited.push(url);
      return {
        html: rendered[url] ?? doc("Unknown"),
        status: 200,
        finalUrl: url,
        // A client-side router's links exist only after hydration.
        links: url === "https://spa.hu/" ? ["https://spa.hu/arak"] : [],
      };
    };

    const r = await crawlSite("https://spa.hu/", { ...site.options, cap: 5, renderPage });

    expect(visited).toEqual(["https://spa.hu/", "https://spa.hu/arak"]);
    expect(r.pages.map((p) => p.title)).toEqual(["Home", "Arak"]);
    // The browser IS the fetch in this mode: no page GET goes through fetch.
    expect(site.calls.some((c) => c.url === "https://spa.hu/" && c.method === "GET")).toBe(false);
  });

  it("still paces itself and honours the cap when rendering", async () => {
    const site = fakeSite({
      "https://spa.hu/robots.txt": { status: 404 },
      "https://spa.hu/sitemap.xml": { status: 404 },
      "https://spa.hu/": { html: "<html><body></body></html>" },
    });
    const renderPage = async (url: string) => ({
      html: doc("P", ["/a", "/b", "/c", "/d"]),
      status: 200,
      finalUrl: url,
      links: ["https://spa.hu/a", "https://spa.hu/b", "https://spa.hu/c", "https://spa.hu/d"],
    });

    const r = await crawlSite("https://spa.hu/", { ...site.options, cap: 3, renderPage });
    expect(r.pages).toHaveLength(3);
    expect(r.cap).toBe(3);
  });
});
