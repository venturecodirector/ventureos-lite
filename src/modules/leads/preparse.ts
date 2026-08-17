/**
 * Deterministic extraction from pasted profile text (P1/1b).
 *
 * Runs BEFORE any Claude call and populates real lead fields on its own. Two
 * reasons this is not an AI job: an email address is a regex, not a judgement,
 * and paying Sonnet to find one is the kind of call CLAUDE.md's budget rule
 * exists to prevent. It also means a paste with no usable text still yields
 * something rather than nothing.
 *
 * Everything here is pure and synchronous so it is trivially testable.
 */

export interface PreParsed {
  emails: string[];
  phones: string[];
  /** Registrable domain of the first non-social website found. */
  domain: string | null;
  websites: string[];
  city: string | null;
  /** True when there is enough prose for a research call to be worth making. */
  hasProse: boolean;
}

/**
 * Hosts that identify a person's presence somewhere, not their company site.
 * A LinkedIn URL is not a company domain, and treating it as one poisons both
 * enrichment and dedupe.
 */
const SOCIAL_HOSTS = [
  "linkedin.com",
  "facebook.com",
  "fb.com",
  "instagram.com",
  "x.com",
  "twitter.com",
  "tiktok.com",
  "youtube.com",
  "goo.gl",
  "maps.google.com",
  "google.com",
];

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const URL_RE = /\bhttps?:\/\/[^\s<>"')]+|\bwww\.[^\s<>"')]+/gi;

/**
 * Hungarian phone shapes: +36 1 234 5678, 06-30-123-4567, (06 1) 234 5678,
 * and bare 9-11 digit runs with separators. Deliberately conservative — a
 * false positive lands a wrong number on a lead card.
 */
const PHONE_RE =
  /(?:\+36|0036|06)[\s./-]?\(?\d{1,2}\)?[\s./-]?\d{3}[\s./-]?\d{3,4}|\+\d{1,3}[\s./-]?\d{2,3}[\s./-]?\d{3}[\s./-]?\d{3,4}/g;

/** Cities we can recognise without a gazetteer. Budapest districts included. */
const HU_CITIES = [
  "Budapest", "Debrecen", "Szeged", "Miskolc", "Pécs", "Győr", "Nyíregyháza",
  "Kecskemét", "Székesfehérvár", "Szombathely", "Szolnok", "Tatabánya", "Kaposvár",
  "Békéscsaba", "Érd", "Veszprém", "Zalaegerszeg", "Sopron", "Eger", "Nagykanizsa",
  "Dunaújváros", "Hódmezővásárhely", "Salgótarján", "Cegléd", "Baja", "Vác",
  "Szigetszentmiklós", "Gödöllő", "Esztergom", "Szentendre",
];

function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase().replace(/[.,;:]+$/, "");
}

function normalizePhone(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return digits;
  if (digits.startsWith("0036")) return `+${digits.slice(2)}`;
  if (digits.startsWith("06")) return `+36${digits.slice(2)}`;
  return digits;
}

export function hostOf(raw: string): string | null {
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return u.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function isSocialHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, "");
  return SOCIAL_HOSTS.some((s) => h === s || h.endsWith(`.${s}`));
}

/**
 * Is there enough prose here for a research call to have anything to work with?
 * A bare URL is not — that is the case P1/1a turns into guidance rather than a
 * doomed Claude call.
 */
export function hasAnalyzableText(text: string): boolean {
  const stripped = (text ?? "")
    .replace(URL_RE, " ")
    .replace(EMAIL_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Two short words are not a profile; require some actual substance.
  return stripped.length >= 40 && stripped.split(" ").filter((w) => w.length > 1).length >= 8;
}

/**
 * Everything on a lead that a research call could actually read.
 *
 * `notes` used to be the only source, and that is why research was dead on
 * every lead the browser extension captured: the capture endpoint wrote what it
 * read into `bio`, `title` and the company row and left `notes` empty, so a
 * lead with a full About section still answered "there is no profile text to
 * analyse yet". The capture endpoint now writes notes as well — but gathering
 * the structured fields here is what makes the leads captured BEFORE that fix
 * work, with no migration and nobody having to re-capture anything.
 */
export function researchSource(lead: {
  notes?: string | null;
  bio?: string | null;
  title?: string | null;
  contactName?: string | null;
  personBrief?: string | null;
  company?: { name?: string | null } | null;
}): string {
  return [
    lead.notes,
    lead.bio,
    lead.contactName && lead.title ? `${lead.contactName} — ${lead.title}` : lead.title,
    lead.company?.name,
    lead.personBrief,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function preParse(text: string): PreParsed {
  const src = text ?? "";

  const emails = [...new Set((src.match(EMAIL_RE) ?? []).map(normalizeEmail))]
    // Image filenames and asset paths sometimes look like addresses.
    .filter((e) => !/\.(png|jpe?g|gif|svg|webp)$/i.test(e));

  const phones = [...new Set((src.match(PHONE_RE) ?? []).map(normalizePhone))].filter(
    (p) => p.replace(/\D/g, "").length >= 9,
  );

  const rawUrls = src.match(URL_RE) ?? [];
  const hosts = rawUrls
    .map((u) => hostOf(u.replace(/[.,;:)]+$/, "")))
    .filter((h): h is string => !!h);
  const websites = [...new Set(hosts)];
  const domain = websites.find((h) => !isSocialHost(h)) ?? null;

  // A city mentioned anywhere in the text, longest name first so "Budapest"
  // does not shadow a compound name that contains it.
  const byLength = [...HU_CITIES].sort((a, b) => b.length - a.length);
  const city =
    byLength.find((c) => new RegExp(`\\b${c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(src)) ??
    null;

  return { emails, phones, domain, websites, city, hasProse: hasAnalyzableText(src) };
}
