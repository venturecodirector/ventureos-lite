import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  detectFramework,
  visibleTextLength,
  jsDependencyPercent,
  crawlModeFor,
  jsDependencyCheck,
  jsDependencySentenceHu,
  JS_DEPENDENCY_THRESHOLD,
  RENDERED_CRAWL_CAP,
} from "@/modules/audit/framework";

/**
 * P2/9 — the three cases that matter, each with a fixture:
 *   static      → fast path, no finding
 *   Next SSR    → framework detected, fast path anyway, no finding
 *   CSR React   → rendered mode, and the finding
 *
 * The middle one is the whole reason this module reads content as well as
 * markers: a server-rendered React site trips every "react" fingerprint while
 * being perfectly crawlable.
 */
const SITES = join(process.cwd(), "test/fixtures/sites");
const html = (name: string) => readFileSync(join(SITES, name), "utf8");

/** What a browser would report after hydration, per fixture. */
const RENDERED_TEXT = {
  "static.html": visibleTextLength(html("static.html")),
  "next-ssr.html": visibleTextLength(html("next-ssr.html")),
  // The SPA paints a full page from an almost empty document.
  "csr-react.html": 900,
};

describe("detectFramework", () => {
  it("finds nothing on a plain HTML site", () => {
    const d = detectFramework(html("static.html"));
    expect(d.framework).toBeNull();
    expect(d.serverRendered).toBe(false);
  });

  it("recognises Next and knows it server-rendered", () => {
    const d = detectFramework(html("next-ssr.html"));
    expect(d.framework).toBe("next");
    expect(d.serverRendered).toBe(true);
    expect(d.evidence).toContain("__NEXT_DATA__");
  });

  it("recognises a client-rendered React app", () => {
    const d = detectFramework(html("csr-react.html"));
    expect(d.framework).toBe("react");
    expect(d.serverRendered).toBe(false);
    expect(d.evidence).toContain("empty mount node");
  });

  it("prefers the specific framework over the generic one", () => {
    // A Next page contains React markers too; it must not be reported as React.
    expect(detectFramework('<div id="__NEXT_DATA__"></div><script src="react.min.js">').framework).toBe(
      "next",
    );
  });

  it("recognises the other frameworks by their own markers", () => {
    expect(detectFramework("<script>window.__NUXT__={}</script>").framework).toBe("nuxt");
    expect(detectFramework('<div id="app" data-v-app></div>').framework).toBe("vue");
    expect(detectFramework('<app-root ng-version="17"></app-root>').framework).toBe("angular");
  });
});

describe("jsDependencyPercent", () => {
  it("is zero when the server already sent the content", () => {
    expect(jsDependencyPercent(html("static.html"), RENDERED_TEXT["static.html"])).toBe(0);
    expect(jsDependencyPercent(html("next-ssr.html"), RENDERED_TEXT["next-ssr.html"])).toBe(0);
  });

  it("is high when the document is an empty mount node", () => {
    const pct = jsDependencyPercent(html("csr-react.html"), RENDERED_TEXT["csr-react.html"]);
    expect(pct).toBeGreaterThan(90);
  });

  it("never goes negative when the rendered page is shorter", () => {
    expect(jsDependencyPercent("<p>a long server-rendered paragraph</p>", 5)).toBe(0);
  });

  it("says zero rather than dividing by nothing", () => {
    expect(jsDependencyPercent("<p>x</p>", 0)).toBe(0);
  });

  it("ignores script and style bodies when measuring the server's text", () => {
    const withScript = "<script>const x = 'a'.repeat(5000);</script><p>rövid</p>";
    expect(visibleTextLength(withScript)).toBeLessThan(20);
  });
});

describe("crawlModeFor", () => {
  it("keeps a plain site on the fast path", () => {
    const d = detectFramework(html("static.html"));
    expect(crawlModeFor(d, 0)).toBe("static");
  });

  it("keeps a SERVER-rendered framework site on the fast path too", () => {
    const d = detectFramework(html("next-ssr.html"));
    expect(crawlModeFor(d, 0)).toBe("static");
  });

  it("switches to rendered only for a framework site missing its content", () => {
    const d = detectFramework(html("csr-react.html"));
    expect(crawlModeFor(d, 95)).toBe("rendered");
  });

  it("does not render a framework site whose content is merely partly lazy", () => {
    const d = detectFramework(html("csr-react.html"));
    expect(crawlModeFor(d, JS_DEPENDENCY_THRESHOLD - 1)).toBe("static");
  });

  it("never renders a site with no framework at all", () => {
    expect(crawlModeFor({ framework: null, serverRendered: false, evidence: [] }, 99)).toBe(
      "static",
    );
  });

  it("caps rendered crawls harder than static ones", () => {
    expect(RENDERED_CRAWL_CAP).toBeLessThanOrEqual(10);
  });
});

describe("the finding", () => {
  it("fails the check and says how much is JS-only", () => {
    const d = detectFramework(html("csr-react.html"));
    const check = jsDependencyCheck(96, d)!;
    expect(check.key).toBe("jsDependency");
    expect(check.pass).toBe(false);
    expect(check.detail).toContain("96% JS-only");
    expect(check.detail).toContain("react");
  });

  it("passes, with the framework named, on a server-rendered site", () => {
    const d = detectFramework(html("next-ssr.html"));
    const check = jsDependencyCheck(0, d)!;
    expect(check.pass).toBe(true);
    expect(check.detail).toContain("next");
  });

  it("emits nothing at all for a plain site", () => {
    const d = detectFramework(html("static.html"));
    expect(jsDependencyCheck(0, d)).toBeNull();
  });

  it("phrases it as a search risk in Hungarian", () => {
    expect(jsDependencySentenceHu(96)).toContain("96%");
    expect(jsDependencySentenceHu(96)).toContain("keresők");
  });
});
