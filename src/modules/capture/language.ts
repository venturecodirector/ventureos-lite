/**
 * Which language is this lead's? Decided from their own words.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * A lead captured from /in/mgoldberger came out Hungarian. The person lives in the
 * San Francisco Bay Area and every word of their bio and posts is English. It was
 * Hungarian because `Lead.language` defaults to HU, and nothing ever looked at the
 * text — the workspace's own language was silently applied to everybody in it.
 *
 * That is not a cosmetic field. It picks which template an outreach draft is
 * written from, which language Claude is instructed to write in, and how a quote
 * and a contract are worded. Getting it wrong means sending a Hungarian email to
 * somebody in California.
 *
 * ── HOW IT DECIDES ─────────────────────────────────────────────────────────
 *
 * Deterministic and cheap: no AI call, because this runs on every capture and
 * CLAUDE.md hard rule #3 is that Claude is frugal and manually triggered.
 *
 *   1. HUNGARIAN-ONLY LETTERS. `ő` and `ű` exist in essentially no other language
 *      written in Latin script. One of them is strong evidence; the shared
 *      diacritics (á é í ó ö ú ü) are weaker, because German, Czech, Spanish and
 *      Portuguese all use some of them.
 *   2. STOPWORD FREQUENCY, both directions. Function words are the most reliable
 *      signal in short text: "the/and/of/to" against "a/az/és/hogy". Compared as
 *      RATES rather than counts, so a long English post cannot out-vote a short
 *      Hungarian bio by sheer length.
 *   3. THE COUNTRY, as a secondary signal only. Hungary leans HU; the US, UK,
 *      Ireland, Canada and Australia lean EN. Never decisive on its own — a
 *      Hungarian speaker in London is common, and so is the reverse.
 *   4. TOO SHORT TO JUDGE (< 40 characters of real text): the workspace default,
 *      labelled as a default rather than as a detection.
 */

export type Lang = "HU" | "EN";

/**
 * The deployment's default, mirroring `Lead.language`'s schema default.
 *
 * There is no per-workspace language setting, so this IS the "workspace default"
 * the fallback refers to. Named rather than inlined so the two cannot drift.
 */
export const DEFAULT_LANG: Lang = "HU";

/** Set once a human has chosen in the form. A capture never overwrites it. */
export const MANUAL_CONFIDENCE = "manual";

/**
 * Should a fresh detection replace what is already stored?
 *
 * Never over a human's choice, and never a confident value with a vaguer one — a
 * second capture with less text must not undo what a first capture with more text
 * worked out.
 */
export function shouldReplaceLanguage(
  existing: { language: Lang; languageConfidence: string | null },
  next: LanguageVerdict,
): boolean {
  if (existing.languageConfidence === MANUAL_CONFIDENCE) return false;
  if (existing.language === next.language) return false;
  const rank = (c: string | null) => (c === "high" ? 3 : c === "medium" ? 2 : c === "low" ? 1 : 0);
  return rank(next.confidence) > rank(existing.languageConfidence);
}

export interface LanguageVerdict {
  language: Lang;
  /** "high" when the text is decisive, "medium" when it leans, "low" when guessed. */
  confidence: "high" | "medium" | "low";
  /** Machine-readable account of which signal decided it. */
  reason: string;
  scores: { hu: number; en: number; chars: number };
}

/** Letters that are effectively Hungarian-only in Latin script. */
const HU_ONLY_LETTERS = /[őű]/gi;
/** Diacritics Hungarian shares with several other languages. */
const HU_SHARED_LETTERS = /[áéíóöúü]/gi;

/**
 * Function words. Short lists on purpose: the top few carry almost all of the
 * signal, and a long list starts including words that exist in both languages.
 */
const HU_STOPWORDS = [
  "a", "az", "és", "hogy", "nem", "egy", "van", "meg", "de", "ha", "is",
  "csak", "még", "már", "vagy", "mint", "ezt", "ami", "aki", "ahol", "minden",
  "nagyon", "lehet", "kell", "volt", "lesz", "ezért", "mert", "után", "előtt",
  "szerint", "között", "való", "saját", "több", "olyan", "ilyen",
];
const EN_STOPWORDS = [
  "the", "and", "of", "to", "in", "that", "is", "for", "with", "on", "as",
  "are", "was", "at", "by", "it", "from", "this", "be", "have", "has", "we",
  "our", "you", "your", "their", "they", "not", "but", "which", "who", "what",
  "about", "into", "over", "after", "before", "more", "most", "some",
];

const HU_SET = new Set(HU_STOPWORDS);
const EN_SET = new Set(EN_STOPWORDS);

/** Countries whose presence leans one way. Secondary signal only. */
const HU_COUNTRIES = ["hungary", "magyarorszag", "magyarország"];
const EN_COUNTRIES = [
  "united states", "united states of america", "usa", "united kingdom",
  "england", "scotland", "wales", "ireland", "canada", "australia",
  "new zealand", "singapore",
];

function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Words, with punctuation and URLs removed — a link is not evidence of a language. */
function words(text: string): string[] {
  return text
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

export interface DetectInput {
  bio?: string | null;
  headline?: string | null;
  posts?: string[] | null;
  /** The location line, raw. Only its country part is consulted. */
  location?: string | null;
  /** The workspace's language, used only when the text cannot decide. */
  fallback: Lang;
}

/** The minimum text worth judging. Below this, a guess is worse than the default. */
export const MIN_TEXT_FOR_DETECTION = 40;

export function detectLanguage(input: DetectInput): LanguageVerdict {
  const text = [input.headline, input.bio, ...(input.posts ?? [])]
    .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
    .join("\n")
    .trim();

  const ws = words(text);
  const chars = text.replace(/\s+/g, " ").trim().length;

  if (chars < MIN_TEXT_FOR_DETECTION || ws.length < 5) {
    return {
      language: input.fallback,
      confidence: "low",
      reason: "text_too_short_used_workspace_default",
      scores: { hu: 0, en: 0, chars },
    };
  }

  // ---- letter evidence ----------------------------------------------------
  const huOnly = (text.match(HU_ONLY_LETTERS) ?? []).length;
  const huShared = (text.match(HU_SHARED_LETTERS) ?? []).length;

  // ---- stopword rates -----------------------------------------------------
  let huHits = 0;
  let enHits = 0;
  for (const w of ws) {
    const f = fold(w);
    if (HU_SET.has(w.toLowerCase()) || HU_SET.has(f)) huHits += 1;
    if (EN_SET.has(f)) enHits += 1;
  }
  const huRate = huHits / ws.length;
  const enRate = enHits / ws.length;

  /**
   * Weights, and why they are what they are.
   *
   * Stopword rate dominates, because in text of any length it is the strongest
   * signal. `ő`/`ű` are worth a lot per occurrence but saturate — five of them say
   * no more than three do. The shared diacritics are worth little: an English
   * headline naming "Zürich" or "José" must not become Hungarian.
   */
  const huScore =
    huRate * 100 +
    Math.min(huOnly, 4) * 8 +
    Math.min(huShared / Math.max(ws.length, 1), 0.25) * 20;
  const enScore = enRate * 100;

  const country = fold(input.location ?? "");
  const leansHu = HU_COUNTRIES.some((c) => country.includes(fold(c)));
  const leansEn = EN_COUNTRIES.some((c) => country.includes(fold(c)));

  const margin = Math.abs(huScore - enScore);
  const textual: Lang = huScore >= enScore ? "HU" : "EN";

  // A clear textual winner decides it, and the country cannot override the
  // person's own words — only break a tie.
  if (margin >= 8) {
    return {
      language: textual,
      confidence: margin >= 20 ? "high" : "medium",
      reason: huOnly > 0 && textual === "HU" ? "hungarian_only_letters_and_stopwords" : "stopword_rates",
      scores: { hu: round(huScore), en: round(enScore), chars },
    };
  }

  if (leansHu !== leansEn) {
    return {
      language: leansHu ? "HU" : "EN",
      confidence: "medium",
      reason: "text_inconclusive_country_decided",
      scores: { hu: round(huScore), en: round(enScore), chars },
    };
  }

  return {
    language: textual,
    confidence: "low",
    reason: "text_inconclusive_no_country_signal",
    scores: { hu: round(huScore), en: round(enScore), chars },
  };
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}
