/**
 * Turning what someone typed — or what a web search answered — into a hostname.
 *
 * Pure and shared, so the form field, the lookup and its tests all agree on
 * what "a domain" is. Everything here is text work: whether the host is safe to
 * FETCH is a separate question, answered by `src/lib/safe-fetch.ts`.
 */

/**
 * Sites that describe companies but are never a company's own.
 *
 * A web search for "<company> hivatalos weboldal" reliably surfaces the
 * directory listing above the actual site — that is what these places are FOR —
 * so a match here is a wrong answer confidently given, and the one failure mode
 * worth spending a deterministic check on.
 */
export const DIRECTORY_DOMAINS = [
  // Social and video
  "linkedin.com", "facebook.com", "instagram.com", "x.com", "twitter.com",
  "youtube.com", "tiktok.com", "pinterest.com", "threads.net",
  // Hungarian company registries and directories
  "e-cegjegyzek.hu", "cegjegyzek.hu", "opten.hu", "ceginformacio.hu",
  "nemzeticegtar.hu", "ceginfo.hu", "cegtar.hu", "bisnode.hu", "cylex.hu",
  "aranyoldalak.hu", "telefonkonyv.hu", "nevjegy.hu", "cegkatalogus.hu",
  // Job boards and review sites
  "profession.hu", "cvonline.hu", "indeed.com", "glassdoor.com", "jooble.org",
  // International data vendors and encyclopaedias
  "crunchbase.com", "zoominfo.com", "dnb.com", "bloomberg.com", "kompass.com",
  "europages.co.uk", "europages.com", "wikipedia.org", "yelp.com",
  // Search engines and map listings
  "google.com", "bing.com", "maps.google.com", "waze.com", "tripadvisor.com",
] as const;

/**
 * Read a bare hostname out of anything domain-shaped.
 *
 * Accepts a URL, a `www.` prefix, a trailing path, a pasted address with
 * spaces around it. Returns null when what is left is not a hostname at all —
 * an empty field, a sentence, an email address without a domain.
 */
export function normalizeDomain(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (!s || /\s/.test(s)) return null;

  let host: string;
  try {
    // `new URL` does the punycode conversion, so `példa.hu` and `xn--plda-3qa.hu`
    // normalise to the same thing rather than to two different companies.
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
    host = u.hostname.toLowerCase();
  } catch {
    return null;
  }

  host = host.replace(/\.$/, "");
  if (host.startsWith("www.")) host = host.slice(4);
  if (host.length === 0 || host.length > 253) return null;

  const labels = host.split(".");
  if (labels.length < 2) return null;
  for (const label of labels) {
    if (label.length === 0 || label.length > 63) return null;
    if (!/^[a-z0-9-]+$/.test(label)) return null;
    if (label.startsWith("-") || label.endsWith("-")) return null;
  }
  // A real TLD is alphabetic — this also rejects the four-number case, so a
  // bare IP address never passes as a company domain.
  if (!/^[a-z]{2,}$/.test(labels[labels.length - 1]!)) return null;

  return host;
}

/** True when the host is a directory or social profile rather than a company site. */
export function isDirectoryDomain(host: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  return DIRECTORY_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`));
}
