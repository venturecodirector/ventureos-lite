/**
 * Normalising contact details read from the contact-info overlay.
 *
 * These are the only fields on a LinkedIn profile that are NOT on the profile
 * page: the diagnostics measured zero `mailto:` links, zero `tel:` links and no
 * outbound hosts. They exist behind an overlay the person chose to publish to
 * their connections, and the extension opens it on an explicit capture.
 *
 * Normalisation is here rather than in the extension for the same reason the
 * gazetteer is: it is a set of RULES that must not exist in two drifting copies,
 * and the server must not trust what an extension hands it in any case. The
 * extension reads labels and values; this decides what they mean.
 *
 * Everything returns a reason on refusal. A blank phone number costs a BDR one
 * question on a call; a wrong one gets dialled.
 */

export interface ContactField<T = string> {
  value: T | null;
  reason: string | null;
}

/** RFC-shaped enough to send to, without pretending to implement RFC 5322. */
export function normalizeEmail(raw: string | null | undefined): ContactField {
  const s = (raw ?? "").trim().replace(/^mailto:/i, "");
  if (!s) return { value: null, reason: "no_email_found" };
  if (s.length > 320) return { value: null, reason: "email_too_long" };
  // One @, a dot-bearing domain, no whitespace, no consecutive dots.
  if (!/^[^\s@,;]+@[^\s@,;.]+(\.[^\s@,;.]+)+$/.test(s)) {
    return { value: null, reason: "email_not_a_valid_address" };
  }
  if (/\.\./.test(s)) return { value: null, reason: "email_not_a_valid_address" };
  const lower = s.toLowerCase();
  // LinkedIn's own addresses appear in boilerplate and belong to nobody.
  if (/@(linkedin|licdn)\.com$/.test(lower)) return { value: null, reason: "email_is_linkedins_own" };
  return { value: lower, reason: null };
}

/**
 * A phone number in E.164, defaulting to Hungary.
 *
 * The overlay shows numbers the way their owner typed them: "06 1 234 5678",
 * "+36 30 123 4567", "(06) 1/234-5678".
 *
 * Hungarian national numbers are EIGHT or NINE digits, not nine — Budapest is
 * area code "1" plus seven subscriber digits, everywhere else is a two-digit area
 * code plus seven, and mobiles are 20/30/31/50/70 plus seven. A first version
 * here required nine and therefore rejected every Budapest landline, which for a
 * Budapest-based business is close to rejecting the useful half of the input.
 */
export function normalizePhone(raw: string | null | undefined): ContactField {
  const s = (raw ?? "").trim().replace(/^tel:/i, "");
  if (!s) return { value: null, reason: "no_phone_found" };

  const hadPlus = s.trimStart().startsWith("+");
  let digits = s.replace(/\D/g, "");
  if (!digits) return { value: null, reason: "phone_had_no_digits" };

  // 00 is the international prefix outside North America.
  if (!hadPlus && digits.startsWith("00")) digits = digits.slice(2);
  // 06 is the Hungarian trunk prefix: 06 1 234 5678 -> 36 1 234 5678.
  else if (!hadPlus && digits.startsWith("06")) digits = `36${digits.slice(2)}`;
  // A bare Hungarian national number: nine digits (mobile or a two-digit area
  // code), or eight beginning with 1 (Budapest).
  else if (!hadPlus && !digits.startsWith("36") && digits.length === 9) digits = `36${digits}`;
  else if (!hadPlus && !digits.startsWith("36") && digits.length === 8 && digits.startsWith("1")) {
    digits = `36${digits}`;
  }

  if (digits.length < 8) return { value: null, reason: "phone_too_short" };
  if (digits.length > 15) return { value: null, reason: "phone_too_long_for_e164" };
  // 36 + 8 (Budapest) or 36 + 9 (everywhere else, and mobiles). Anything else
  // with a Hungarian country code is not a Hungarian number.
  if (digits.startsWith("36") && digits.length !== 10 && digits.length !== 11) {
    return { value: null, reason: "phone_wrong_length_for_hungary" };
  }
  return { value: `+${digits}`, reason: null };
}

/** The qualifier LinkedIn appends — "(Mobile)", "(Home)" — kept as a note. */
export function phoneQualifier(raw: string | null | undefined): string | null {
  const m = /\((mobile|home|work|otthoni|mobil|munkahelyi)\)/i.exec(raw ?? "");
  return m ? m[1]!.toLowerCase() : null;
}

/** A website reduced to its origin, so two spellings of one site match. */
export function normalizeWebsite(raw: string | null | undefined): ContactField {
  const s = (raw ?? "").trim();
  if (!s) return { value: null, reason: "no_website_found" };
  const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return { value: null, reason: "website_not_a_url" };
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  if (!host.includes(".")) return { value: null, reason: "website_has_no_domain" };
  if (/(^|\.)(linkedin\.com|licdn\.com|lnkd\.in)$/.test(host)) {
    return { value: null, reason: "website_is_linkedins_own" };
  }
  return { value: `https://${host}`, reason: null };
}

/**
 * Which of several websites is the company's.
 *
 * LinkedIn labels each one — "(Company)", "(Personal)", "(Blog)" — and a lead's
 * company domain is what feeds enrichment and dedupe, so a personal blog in that
 * field is actively harmful. Prefer anything not marked personal; if every
 * candidate is personal, take the first rather than inventing a preference.
 */
export function pickCompanyWebsite(
  entries: { url: string; qualifier?: string | null }[],
): { value: string | null; reason: string | null; all: string[] } {
  const normalized = entries
    .map((e) => ({ ...e, norm: normalizeWebsite(e.url) }))
    .filter((e) => e.norm.value);
  const all = [...new Set(normalized.map((e) => e.norm.value!))];
  if (all.length === 0) return { value: null, reason: "no_usable_website", all: [] };

  const isPersonal = (q?: string | null) => /personal|szemelyes|blog/i.test(q ?? "");
  const preferred = normalized.find((e) => !isPersonal(e.qualifier));
  return { value: (preferred ?? normalized[0]!).norm.value!, reason: null, all };
}
