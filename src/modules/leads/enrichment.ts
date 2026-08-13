import { prismaUnsafe } from "@/lib/db";
import { parseRobots, isAllowed, VENTURE_USER_AGENT } from "@/lib/robots";

/**
 * Company-website enrichment (P1/1c).
 *
 * One fetch of the company's public homepage, cached 30 days, stripped down to
 * readable prose and fed into the research call. The point is to give Claude
 * something real to work with instead of three fields, WITHOUT turning every
 * research run into a crawl: one page, one request, honoured robots.txt, and a
 * cache so a re-run costs nothing.
 */
const CACHE_DAYS = 30;
const CACHE_MS = CACHE_DAYS * 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;
/** Hard cap on what we keep, well under the prompt's own trim. */
const MAX_TEXT = 4000;

/**
 * Strip a page down to the prose a human would read.
 *
 * Pure and exported so it can be tested without a network. Deliberately
 * simple: no DOM parser, because the input is untrusted HTML from an arbitrary
 * site and the output only ever becomes prompt text — never markup we render.
 */
export function extractReadableText(html: string): string {
  return (html ?? "")
    // Whole regions that are never prose.
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    // Chrome that carries no information about the business.
    .replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/gi, " ")
    .replace(/<header\b[^>]*>[\s\S]*?<\/header>/gi, " ")
    // Keep block boundaries as line breaks so sentences do not run together.
    .replace(/<\/(p|div|li|h[1-6]|section|article|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    // Entities we are likely to meet.
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    // Collapse whitespace, drop the empty lines left behind.
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, MAX_TEXT);
}

export interface EnrichmentResult {
  text: string | null;
  /** Why there is no text, when there is none. */
  skipped: "no_domain" | "robots" | "unreachable" | "empty" | null;
  fromCache: boolean;
}

/**
 * Fetch and cache the homepage text for a company. Never throws: enrichment is
 * a bonus, and a site being down must not fail a research run.
 */
export async function enrichCompanySite(companyId: string): Promise<EnrichmentResult> {
  const company = await prismaUnsafe.company.findUnique({
    where: { id: companyId },
    select: { id: true, domain: true, website: true, siteText: true, siteFetchedAt: true },
  });
  if (!company) return { text: null, skipped: "no_domain", fromCache: false };

  const fresh =
    company.siteFetchedAt && Date.now() - company.siteFetchedAt.getTime() < CACHE_MS;
  if (fresh) {
    return { text: company.siteText, skipped: company.siteText ? null : "empty", fromCache: true };
  }

  const raw = company.website ?? company.domain;
  if (!raw) return { text: null, skipped: "no_domain", fromCache: false };

  let origin: string;
  let path: string;
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    origin = u.origin;
    path = u.pathname || "/";
  } catch {
    return { text: null, skipped: "no_domain", fromCache: false };
  }

  // robots.txt first. A site that asks us not to read a page does not get read,
  // even though this is a single request on a company we are researching.
  try {
    const res = await fetch(`${origin}/robots.txt`, {
      headers: { "User-Agent": VENTURE_USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.ok) {
      const rules = parseRobots(await res.text(), VENTURE_USER_AGENT);
      if (!isAllowed(rules, path)) {
        await stampFetch(company.id, null);
        return { text: null, skipped: "robots", fromCache: false };
      }
    }
    // A missing or erroring robots.txt means no restrictions.
  } catch {
    /* unreachable robots.txt is not a prohibition */
  }

  let text: string | null = null;
  try {
    const res = await fetch(`${origin}${path}`, {
      headers: { "User-Agent": VENTURE_USER_AGENT, Accept: "text/html" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: "follow",
    });
    if (res.ok && (res.headers.get("content-type") ?? "").includes("text/html")) {
      text = extractReadableText(await res.text()) || null;
    }
  } catch {
    await stampFetch(company.id, null);
    return { text: null, skipped: "unreachable", fromCache: false };
  }

  await stampFetch(company.id, text);
  return { text, skipped: text ? null : "empty", fromCache: false };
}

/** Record the attempt either way, so a dead site is not refetched every run. */
async function stampFetch(companyId: string, text: string | null): Promise<void> {
  await prismaUnsafe.company.update({
    where: { id: companyId },
    data: { siteText: text, siteFetchedAt: new Date() },
  });
}
