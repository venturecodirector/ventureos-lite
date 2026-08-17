/**
 * Turning a LinkedIn company name into something searchable.
 *
 * LinkedIn's company field is marketing copy, not a legal name. Observed on a
 * real capture: `"Seyu - Together for victory!"` — a name, a dash, a slogan, and
 * a pair of quotation marks that were in the source. Searching for that string
 * finds nothing; searching for `Seyu` finds the company.
 *
 * So this produces an ORDERED LIST of candidates rather than one answer. The
 * cheapest, most likely query goes first, and each subsequent variant loosens or
 * tightens exactly one thing — legal form on or off, city appended or not. The
 * discovery step tries them in order and stops at the first that yields a tax
 * number that validates, which keeps the expensive path (a model call with web
 * search) as short as possible.
 *
 * Nothing here decides anything. It only proposes strings.
 */

/**
 * Hungarian legal forms, longest first so "Nonprofit Kft." is recognised before
 * "Kft." and the qualifier is not silently discarded.
 */
const LEGAL_FORMS = [
  "Nonprofit Kft.", "Nonprofit Zrt.", "Nonprofit Bt.",
  "Nyrt.", "Zrt.", "Kft.", "Bt.", "Kkt.", "Kv.", "Kht.", "Rt.",
  "Nonprofit Korlátolt Felelősségű Társaság",
  "Korlátolt Felelősségű Társaság",
  "Zártkörűen Működő Részvénytársaság",
  "Nyilvánosan Működő Részvénytársaság",
  "Betéti Társaság",
  "Közkereseti Társaság",
  "Egyéni Cég",
  "Alapítvány", "Egyesület", "Szövetkezet", "Ügyvédi Iroda",
] as const;

/** Separators after which LinkedIn tends to put a tagline rather than a name. */
const TAGLINE_SEPARATORS = /\s+[-–—:|!]\s+|\s*[|!]\s*/;

export interface NormalizedCompanyName {
  /** The best single guess at the trading name. */
  primary: string;
  /** The legal form found in the raw name, canonicalised, or null. */
  legalForm: string | null;
  /** Primary with the legal form attached, when one was detected. */
  withLegalForm: string | null;
  /** Search strings in the order they should be tried. */
  candidates: string[];
  /** True when the raw value was clearly a tagline rather than a name. */
  hadTagline: boolean;
}

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

/** Strip the quotation marks LinkedIn sometimes includes in the field itself. */
function unquote(raw: string): string {
  let s = collapse(raw);
  // Repeatedly, because "'Seyu'" arrives with both kinds.
  for (let i = 0; i < 3; i += 1) {
    const before = s;
    s = s.replace(/^["'“”„»«‘’]+/, "").replace(/["'“”„»«‘’]+$/, "").trim();
    if (s === before) break;
  }
  return s;
}

/** Find and remove a trailing legal form, returning both halves. */
function splitLegalForm(name: string): { stem: string; legalForm: string | null } {
  const norm = (s: string) =>
    s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\./g, "");
  for (const form of LEGAL_FORMS) {
    const f = norm(form);
    const n = norm(name);
    if (n.endsWith(` ${f}`) || n === f) {
      // Cut at the same position in the ORIGINAL string, so accents survive.
      const words = name.trim().split(/\s+/);
      const formWords = form.trim().split(/\s+/).length;
      const stem = collapse(words.slice(0, Math.max(0, words.length - formWords)).join(" "));
      return { stem: stem || name, legalForm: form };
    }
  }
  return { stem: name, legalForm: null };
}

/**
 * Normalise a captured company name into ordered search candidates.
 *
 * `city` is the captured location's city when there is one; a name plus a city
 * is a far better query than a name alone for anything generically named, and a
 * far worse one when the city is wrong — which is why it is a later candidate
 * rather than the first.
 */
export function normalizeCompanyName(
  raw: string | null | undefined,
  city?: string | null,
): NormalizedCompanyName {
  const unquoted = unquote(raw ?? "");
  if (!unquoted) {
    return { primary: "", legalForm: null, withLegalForm: null, candidates: [], hadTagline: false };
  }

  // Cut at the first tagline separator. "Seyu - Together for victory!" -> "Seyu".
  const parts = unquoted.split(TAGLINE_SEPARATORS).map(collapse).filter(Boolean);
  const head = parts[0] ?? unquoted;
  const hadTagline = parts.length > 1 && head.length < unquoted.length;

  // A legal form in the SECOND part means the split was wrong — "Danubia -
  // Fogászat Kft." is one name with a dash, not a name plus a slogan.
  const rejoined = collapse(unquoted.replace(TAGLINE_SEPARATORS, " "));
  const headHasForm = splitLegalForm(head).legalForm !== null;
  const wholeHasForm = splitLegalForm(rejoined).legalForm !== null;
  const base = !headHasForm && wholeHasForm ? rejoined : head;

  const { stem, legalForm } = splitLegalForm(unquote(base));
  const primary = collapse(stem);
  const withLegalForm = legalForm ? `${primary} ${legalForm}` : null;

  // Order matters: most specific first, then looser, then city-qualified.
  const ordered = [
    withLegalForm,
    primary,
    // The full raw name, in case the "tagline" was actually part of the name.
    hadTagline ? collapse(unquoted) : null,
    city ? `${primary} ${city}` : null,
    city && legalForm ? `${primary} ${legalForm} ${city}` : null,
  ].filter((v): v is string => !!v && v.length >= 2);

  return {
    primary,
    legalForm,
    withLegalForm,
    candidates: [...new Set(ordered)],
    hadTagline,
  };
}

/**
 * Do two company names plausibly refer to the same company?
 *
 * Used for the cross-check after NAV answers: a tax number can be well-formed,
 * registered, and belong to an entirely different real company. Comparing the
 * NAV legal name against what we searched for is the only defence against
 * silently attaching the wrong company to a lead.
 *
 * Token overlap rather than string distance, because a legal name is the trading
 * name plus noise ("Danubia Fogászat Korlátolt Felelősségű Társaság" vs
 * "Danubia Fogászat"), and edit distance punishes exactly that.
 */
export function nameSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const tokens = (s: string) =>
    new Set(
      s
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 3 && !LEGAL_FORM_TOKENS.has(t)),
    );
  const ta = tokens(a ?? "");
  const tb = tokens(b ?? "");
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  // Against the SMALLER set: "Danubia" inside "Danubia Fogászat Kft." should
  // score 1, not 0.5 — a shorter captured name is normal, not a disagreement.
  return shared / Math.min(ta.size, tb.size);
}

/** Legal-form words carry no identifying information, so they never count. */
const LEGAL_FORM_TOKENS = new Set([
  "kft", "zrt", "bt", "nyrt", "kkt", "rt", "kht", "nonprofit", "korlatolt",
  "felelossegu", "tarsasag", "zartkoruen", "nyilvanosan", "mukodo",
  "reszvenytarsasag", "beteti", "kozkereseti", "egyeni", "ceg", "alapitvany",
  "egyesulet", "szovetkezet", "ugyvedi", "iroda", "holding", "group",
]);

/** Below this, do not auto-accept — show the mismatch and let the user decide. */
export const NAME_MATCH_THRESHOLD = 0.5;

export { LEGAL_FORMS };
