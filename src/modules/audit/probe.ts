import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
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
      };
    });

    const [hasSitemap, hasRobots] = await Promise.all([
      headOk(new URL("/sitemap.xml", finalUrl).toString()),
      headOk(new URL("/robots.txt", finalUrl).toString()),
    ]);

    await context.close();
    return {
      url: target,
      finalUrl,
      isHttps: finalUrl.startsWith("https://"),
      statusOk: !!resp && resp.ok(),
      hasSitemap,
      hasRobots,
      pageWeightBytes,
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
