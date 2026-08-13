import { resolveTxt } from "node:dns/promises";
import { connect as tlsConnect } from "node:tls";
import { chromium, type Page } from "playwright";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PageProbe } from "./types";

const FILES_DIR = process.env.FILES_DIR ?? "/data/files";
const NAV_TIMEOUT = 20_000;

function normalizeUrl(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

async function headOk(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: "HEAD" });
    return res.ok;
  } catch {
    return false;
  }
}

/** Stage 1: deterministic checks via a headless render. psi/screenshots added later. */
export async function probeSite(url: string): Promise<PageProbe> {
  const target = normalizeUrl(url);
  const browser = await chromium.launch({ headless: true });
  let pageWeightBytes = 0;
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    page.on("response", async (res) => {
      try {
        pageWeightBytes += (await res.body()).length;
      } catch {
        /* some responses (redirects) have no body */
      }
    });

    const resp = await page.goto(target, { waitUntil: "networkidle", timeout: NAV_TIMEOUT });
    const finalUrl = page.url();

    const dom = await page.evaluate(() => {
      const title = document.title || null;
      const metaDescription =
        document.querySelector('meta[name="description"]')?.getAttribute("content") || null;
      const hasViewport = !!document.querySelector('meta[name="viewport"]');
      const h1Count = document.querySelectorAll("h1").length;
      const imgs = Array.from(document.querySelectorAll("img"));
      const imgTotal = imgs.length;
      const imgWithAlt = imgs.filter((i) => (i.getAttribute("alt") ?? "").trim().length > 0).length;
      const bodyText = document.body?.innerText ?? "";
      const html = document.documentElement.outerHTML.toLowerCase();

      const cm = bodyText.match(/(?:©|\(c\)|copyright)\s*(\d{4})/i);
      const copyrightYear = cm ? parseInt(cm[1], 10) : null;

      const hasPhone = /href=["']tel:/.test(html) || /\+?\d[\d\s().-]{7,}\d/.test(bodyText);
      const hasEmail = /href=["']mailto:/.test(html) || /[\w.-]+@[\w.-]+\.\w{2,}/.test(bodyText);
      const hasForm = !!document.querySelector("form");
      const hasBooking =
        /(book|booking|reserve|reservation|appointment|foglal|időpont)/i.test(html);
      const hasCookieBanner = /(cookie|süti|gdpr|consent)/i.test(html);

      return {
        title,
        metaDescription,
        hasViewport,
        h1Count,
        imgTotal,
        imgWithAlt,
        copyrightYear,
        hasPhone,
        hasEmail,
        hasForm,
        hasBooking,
        hasCookieBanner,

        // ---- P1/3c ---------------------------------------------------------
        // All derived from the page already in memory: no extra request.
        hasOpenGraph: !!document.querySelector('meta[property^="og:"]'),
        hasCanonical: !!document.querySelector('link[rel="canonical"]'),
        hasSchemaOrg:
          !!document.querySelector('script[type="application/ld+json"]') ||
          /itemscope|itemtype=/.test(html),
        // Exactly one h1, and no level skipped on the way down.
        headingHierarchyOk: (() => {
          if (document.querySelectorAll("h1").length !== 1) return false;
          const levels = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6")).map((el) =>
            Number(el.tagName[1]),
          );
          for (let i = 1; i < levels.length; i++) {
            if (levels[i]! - levels[i - 1]! > 1) return false;
          }
          return true;
        })(),
        // An http:// subresource on an https page: the browser blocks or warns.
        mixedContent:
          location.protocol === "https:" &&
          Array.from(document.querySelectorAll("img,script,link,iframe")).some((el) => {
            const src =
              el.getAttribute("src") ?? el.getAttribute("href") ?? "";
            return src.startsWith("http://");
          }),
        hasAnalytics:
          /googletagmanager\.com|google-analytics\.com|gtag\(|plausible\.io|matomo|umami/.test(
            html,
          ),
        // Hungarian legal pages are found by their link text or href, which is
        // how a person finds them too.
        hasImpresszum: /impresszum|impressum/.test(html),
        hasPrivacyPolicy:
          /adatkezel|adatvédelm|privacy[-_ ]?policy|gdpr-tajekoztato/.test(html),
        hasAszf: /ászf|aszf|általános szerződési|altalanos szerzodesi|terms/.test(html),
        // Treat it as a webshop only on strong signals; ÁSZF is only expected
        // of one, and a false positive invents a legal finding.
        isWebshop:
          /add[-_ ]?to[-_ ]?cart|kosárba|kosarba|woocommerce|shopify|checkout|pénztár/.test(html),
      };
    });

    // Security headers come off the navigation response we already have.
    const headers = resp?.headers() ?? {};
    const has = (name: string) => !!headers[name];

    // DNS and the HEAD probes run together: they are independent waits, and
    // the item's budget is a 45s whole-audit runtime.
    const [hasSitemap, hasRobots, sitemapUrlCount, mail, sslDaysLeft, a11y] = await Promise.all([
      headOk(new URL("/sitemap.xml", finalUrl).toString()),
      headOk(new URL("/robots.txt", finalUrl).toString()),
      countSitemapUrls(new URL("/sitemap.xml", finalUrl).toString()),
      lookupMailHygiene(new URL(finalUrl).hostname),
      certificateDaysLeft(new URL(finalUrl).hostname),
      runAxe(page),
    ]);

    await context.close();
    return {
      url: target,
      finalUrl,
      isHttps: finalUrl.startsWith("https://"),
      statusOk: !!resp && resp.ok(),
      hasSitemap,
      hasRobots,
      sitemapUrlCount,
      pageWeightBytes,
      // A redirect chain that started on http and ended on https.
      httpsRedirect: finalUrl.startsWith("https://"),
      hsts: has("strict-transport-security"),
      xContentTypeOptions: has("x-content-type-options"),
      xFrameOptions: has("x-frame-options") || /frame-ancestors/.test(headers["content-security-policy"] ?? ""),
      csp: has("content-security-policy"),
      spf: mail.spf,
      dmarc: mail.dmarc,
      sslDaysLeft,
      a11y,
      psi: null,
      screenshots: {},
      ...dom,
    };
  } finally {
    await browser.close();
  }
}

/** Stage 3: mobile + desktop screenshots written to the files volume. */
export async function captureScreenshots(
  url: string,
  auditId: string,
): Promise<{ desktop?: string; mobile?: string }> {
  const target = normalizeUrl(url);
  const dir = join(FILES_DIR, "audits");
  await mkdir(dir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const desktopRel = `audits/${auditId}-desktop.png`;
    const mobileRel = `audits/${auditId}-mobile.png`;

    const dctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const dp = await dctx.newPage();
    await dp.goto(target, { waitUntil: "networkidle", timeout: NAV_TIMEOUT });
    await dp.screenshot({ path: join(FILES_DIR, desktopRel) });
    await dctx.close();

    const mctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
    });
    const mp = await mctx.newPage();
    await mp.goto(target, { waitUntil: "networkidle", timeout: NAV_TIMEOUT });
    await mp.screenshot({ path: join(FILES_DIR, mobileRel) });
    await mctx.close();

    return { desktop: desktopRel, mobile: mobileRel };
  } finally {
    await browser.close();
  }
}

/**
 * SPF and DMARC via DNS (P1/3c).
 *
 * Both are TXT lookups and both are allowed to fail: a nameserver timing out
 * tells us nothing about the domain's mail setup, so we return undefined and
 * the analysis emits no check rather than a false "missing SPF".
 */
async function lookupMailHygiene(
  hostname: string,
): Promise<{ spf?: boolean; dmarc?: boolean }> {
  const bare = hostname.replace(/^www\./, "");
  const [spf, dmarc] = await Promise.all([
    resolveTxtSafe(bare).then((rs) =>
      rs === null ? undefined : rs.some((r) => r.toLowerCase().startsWith("v=spf1")),
    ),
    resolveTxtSafe(`_dmarc.${bare}`).then((rs) =>
      rs === null ? undefined : rs.some((r) => r.toLowerCase().startsWith("v=dmarc1")),
    ),
  ]);
  return { spf, dmarc };
}

/** Flattened TXT records, or null when the lookup itself failed. */
async function resolveTxtSafe(name: string): Promise<string[] | null> {
  try {
    const records = await resolveTxt(name);
    return records.map((chunks) => chunks.join(""));
  } catch (e) {
    // NXDOMAIN / ENODATA are real answers: the record is genuinely absent.
    const code = (e as { code?: string }).code;
    if (code === "ENOTFOUND" || code === "ENODATA") return [];
    return null;
  }
}

/** How many URLs the sitemap lists — depth of the site, cheaply. */
async function countSitemapUrls(url: string): Promise<number | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const body = await res.text();
    return (body.match(/<loc>/gi) ?? []).length;
  } catch {
    return null;
  }
}

/**
 * Days until the TLS certificate expires (P1/3c).
 *
 * A separate connection because Playwright does not surface the peer
 * certificate. Cheap, and worth it: an expiring certificate is the single
 * most urgent finding an audit can produce — the site is days away from
 * browsers refusing it outright.
 *
 * Returns undefined when the check could not be made at all, so the analysis
 * emits no check rather than a false failure.
 */
async function certificateDaysLeft(hostname: string): Promise<number | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: number | undefined) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    try {
      const socket = tlsConnect(
        { host: hostname, port: 443, servername: hostname, timeout: 6000 },
        () => {
          const cert = socket.getPeerCertificate();
          socket.end();
          if (!cert || !cert.valid_to) return done(undefined);
          const ms = new Date(cert.valid_to).getTime() - Date.now();
          done(Number.isFinite(ms) ? Math.floor(ms / 86_400_000) : undefined);
        },
      );
      socket.on("error", () => done(undefined));
      socket.on("timeout", () => {
        socket.destroy();
        done(undefined);
      });
    } catch {
      done(undefined);
    }
  });
}

/**
 * Accessibility violations via axe-core (P1/3c).
 *
 * axe is injected as a source string into the page we already loaded, so the
 * scan costs no extra navigation. Everything is best-effort: a page that
 * breaks axe (heavy CSP, exotic framework) yields null, and the analysis then
 * emits no accessibility check rather than punishing the site for our
 * tooling's limits.
 *
 * Only the counts and the worst three descriptions are kept. The full axe
 * report is megabytes of JSON, and none of it is actionable in a sales audit.
 */
async function runAxe(page: Page): Promise<PageProbe["a11y"]> {
  try {
    const source = await readFile(
      join(process.cwd(), "node_modules", "axe-core", "axe.min.js"),
      "utf8",
    );
    await page.addScriptTag({ content: source });
    const raw = await page.evaluate(async () => {
      const axe = (window as unknown as { axe?: { run: (o: unknown) => Promise<unknown> } }).axe;
      if (!axe) return null;
      const result = (await axe.run({
        // Only the rule sets a business actually gets judged on.
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] },
        resultTypes: ["violations"],
      })) as { violations?: Array<{ impact?: string; help?: string; nodes?: unknown[] }> };
      return (result.violations ?? []).map((v) => ({
        impact: v.impact ?? "minor",
        help: v.help ?? "",
        count: (v.nodes ?? []).length,
      }));
    });
    if (!raw) return null;

    const tally = { critical: 0, serious: 0, moderate: 0, minor: 0 };
    for (const v of raw) {
      if (v.impact in tally) tally[v.impact as keyof typeof tally] += 1;
    }
    const order = ["critical", "serious", "moderate", "minor"];
    const top = [...raw]
      .sort((a, b) => order.indexOf(a.impact) - order.indexOf(b.impact) || b.count - a.count)
      .slice(0, 3)
      .map((v) => v.help)
      .filter(Boolean);
    return { ...tally, top };
  } catch {
    return null;
  }
}
