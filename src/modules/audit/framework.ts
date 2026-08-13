/**
 * JS-framework detection and the JS-dependency finding (P2/9).
 *
 * A crawler that only reads HTML sees a client-rendered site as an empty page —
 * and so, to a degree, does a search engine. The point of this module is to
 * tell those two cases apart:
 *
 *   - server-rendered React (Next, Nuxt): the markup is there, the fast path is
 *     correct, and a "your content is invisible" finding would be WRONG;
 *   - client-rendered React (Vite/CRA SPA): the markup is a div, and the
 *     finding is the most valuable thing in the report.
 *
 * Framework markers alone cannot separate them — a Next page and a CRA page
 * both contain "react". What separates them is how much text survives with
 * JavaScript off, which is why the decision uses both.
 *
 * Pure, so all three cases are testable against a fixture.
 */
export type Framework = "next" | "nuxt" | "react" | "vue" | "angular" | "svelte" | null;

export interface FrameworkDetection {
  framework: Framework;
  /** True when the framework's own server-rendering marker is present. */
  serverRendered: boolean;
  /** What gave it away, for the report's detail line. */
  evidence: string[];
}

/** Framework fingerprints, most specific first — Next before React. */
const MARKERS: Array<{ framework: Exclude<Framework, null>; ssr?: boolean; re: RegExp; label: string }> = [
  { framework: "next", ssr: true, re: /id=["']__NEXT_DATA__["']/i, label: "__NEXT_DATA__" },
  { framework: "next", re: /\/_next\/static\//i, label: "/_next/static" },
  { framework: "nuxt", ssr: true, re: /window\.__NUXT__/i, label: "__NUXT__" },
  { framework: "nuxt", re: /\/_nuxt\//i, label: "/_nuxt" },
  { framework: "svelte", ssr: true, re: /__sveltekit_/i, label: "__sveltekit_" },
  { framework: "angular", re: /<app-root|ng-version=/i, label: "ng-version" },
  { framework: "vue", re: /data-v-app|__vue__|\bvue(?:\.runtime)?(?:\.min)?\.js/i, label: "vue" },
  { framework: "react", ssr: true, re: /data-reactroot/i, label: "data-reactroot" },
  { framework: "react", re: /\breact(?:-dom)?(?:\.production|\.development)?(?:\.min)?\.js/i, label: "react bundle" },
  { framework: "react", re: /id=["'](root|app)["'][^>]*>\s*<\/div>/i, label: "empty mount node" },
];

export function detectFramework(html: string): FrameworkDetection {
  const evidence: string[] = [];
  let framework: Framework = null;
  let serverRendered = false;

  for (const m of MARKERS) {
    if (!m.re.test(html)) continue;
    evidence.push(m.label);
    if (framework === null) framework = m.framework;
    if (m.ssr && m.framework === framework) serverRendered = true;
  }

  return { framework, serverRendered, evidence };
}

/** Visible text in a raw HTML document, roughly as a JS-less crawler sees it. */
export function visibleTextLength(html: string): number {
  const text = (html ?? "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length;
}

/**
 * Share of the content that only appears once JavaScript has run, 0-100.
 *
 * Clamped at both ends: a rendered page that is SHORTER than its source
 * (a cookie wall replaced by the real page, say) is 0% JS-dependent rather
 * than a negative number, and a page with no server text at all is 100%.
 */
export function jsDependencyPercent(rawHtml: string, renderedTextLength: number): number {
  const raw = visibleTextLength(rawHtml);
  if (renderedTextLength <= 0) return 0;
  if (raw >= renderedTextLength) return 0;
  return Math.round(((renderedTextLength - raw) / renderedTextLength) * 100);
}

/**
 * Enough of the page missing to matter.
 *
 * A third is the threshold: below that we are usually looking at a cookie
 * banner, a lazy-loaded testimonial carousel, or whitespace differences, and
 * calling those "your content is invisible to Google" would be alarmism that
 * costs us the room.
 */
export const JS_DEPENDENCY_THRESHOLD = 33;

export type CrawlMode = "static" | "rendered";

/**
 * Which crawl mode a site gets.
 *
 * Rendering is roughly ten times the cost of fetching, so it has to be earned:
 * a framework marker AND meaningful content missing from the HTML. A
 * server-rendered Next site trips the first and not the second, and correctly
 * stays on the fast path.
 */
export function crawlModeFor(
  detection: FrameworkDetection,
  jsDependency: number,
): CrawlMode {
  if (detection.framework === null) return "static";
  if (jsDependency >= JS_DEPENDENCY_THRESHOLD) return "rendered";
  return "static";
}

/** The finding, in the language the report speaks. */
export function jsDependencyCheck(
  jsDependency: number,
  detection: FrameworkDetection,
): { key: string; label: string; pass: boolean; detail?: string } | null {
  if (detection.framework === null && jsDependency < JS_DEPENDENCY_THRESHOLD) return null;
  return {
    key: "jsDependency",
    label: "Content visible without JavaScript",
    pass: jsDependency < JS_DEPENDENCY_THRESHOLD,
    detail:
      jsDependency > 0
        ? `${jsDependency}% JS-only${detection.framework ? ` · ${detection.framework}` : ""}`
        : detection.framework
          ? `${detection.framework}, server-rendered`
          : undefined,
  };
}

/** Hungarian, for the prospect-facing surfaces. */
export function jsDependencySentenceHu(jsDependency: number): string {
  return `A tartalom ${jsDependency}%-a csak JavaScripttel jelenik meg — ez kockázat a keresőknél.`;
}

// ---------------------------------------------------------------------------
// Cost guards (P2/9)
// ---------------------------------------------------------------------------

/** Rendered crawling is ~10× the cost of fetching, so it gets a tighter cap. */
export const RENDERED_CRAWL_CAP = 10;
export const RENDERED_PAGE_TIMEOUT_MS = 15_000;
/** Whole-audit ceiling for a rendered run. */
export const RENDERED_TOTAL_BUDGET_MS = 180_000;
