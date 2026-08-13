/**
 * Which language a public page speaks.
 *
 * The product UI is English (CLAUDE.md); the prospect-facing pages are for
 * Hungarian businesses and default to Hungarian. English exists because some
 * of them are foreign-owned or forward the link to someone who is.
 *
 * Pure so the precedence rule can be tested without a request. The rule is
 * deliberately boring: an explicit choice beats a browser hint, and a browser
 * hint beats the default.
 */
export const LOCALES = ["hu", "en"] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "hu";

/** The cookie the switcher sets. Read by the redirect on every later visit. */
export const LOCALE_COOKIE = "venture_lang";
/** A year: a language preference is not something to ask twice. */
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function isLocale(v: unknown): v is Locale {
  return typeof v === "string" && (LOCALES as readonly string[]).includes(v);
}

/**
 * Best supported language from an `Accept-Language` header.
 *
 * Quality-weighted, because `hu;q=0.9, en;q=1.0` means English however the
 * order reads. Region subtags are ignored — we have no en-GB/en-US split, and
 * "en-AU" wanting English is not ambiguous.
 *
 * Returns null when the header expresses no opinion we can serve, so the
 * caller can tell "asked for something we do not have" apart from "asked for
 * Hungarian".
 */
export function localeFromAcceptLanguage(header: string | null | undefined): Locale | null {
  if (!header) return null;

  const candidates = header
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params
        .map((p) => p.trim())
        .find((p) => p.startsWith("q="));
      const quality = q ? Number(q.slice(2)) : 1;
      return {
        base: (tag ?? "").trim().toLowerCase().split("-")[0] ?? "",
        // A malformed q is treated as 0 rather than 1: a header we cannot
        // parse should not outrank one we can.
        quality: Number.isFinite(quality) ? quality : 0,
      };
    })
    .filter((c) => c.base.length > 0 && c.quality > 0)
    .sort((a, b) => b.quality - a.quality);

  for (const c of candidates) {
    if (isLocale(c.base)) return c.base;
    // "*" means "anything", which is not a preference worth honouring over
    // our own default.
  }
  return null;
}

/**
 * The language to serve: explicit choice, then browser hint, then default.
 */
export function detectLocale(opts: {
  cookie?: string | null;
  acceptLanguage?: string | null;
}): Locale {
  if (isLocale(opts.cookie)) return opts.cookie;
  return localeFromAcceptLanguage(opts.acceptLanguage) ?? DEFAULT_LOCALE;
}

/** The other one, for the switcher. */
export function otherLocale(current: Locale): Locale {
  return current === "hu" ? "en" : "hu";
}
