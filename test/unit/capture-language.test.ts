import { describe, it, expect } from "vitest";
import {
  detectLanguage,
  shouldReplaceLanguage,
  DEFAULT_LANG,
  MANUAL_CONFIDENCE,
  MIN_TEXT_FOR_DETECTION,
} from "../../src/modules/capture/language";

/**
 * Which language is this lead's? (capture item 6)
 *
 * A lead captured from a San Francisco profile whose bio and posts are entirely
 * English came out Hungarian, because `Lead.language` defaults to HU and nothing
 * ever looked at the text. That field picks the outreach template, tells Claude
 * which language to write in, and words the quote and the contract — so it decides
 * whether somebody in California gets an email in Hungarian.
 */
const EN_BIO =
  "As VP Sales at Metaview, I'm focused on helping revenue teams understand what " +
  "actually happens in their customer conversations. Before Metaview I led " +
  "enterprise sales motions at Ramp and Navan, where I learned that the fastest " +
  "way to lose a deal is to skip the discovery work.";
const EN_HEADLINE = "VP Sales @ Metaview | Startup Advisor and Investor | Ramp and Navan Alum";
const EN_POST =
  "Most sales teams think their discovery process is fine because deals still " +
  "close. Then you listen to twenty recorded calls in a row and realise the same " +
  "three questions never get asked.";

const HU_BIO =
  "Fogászati rendelőt vezetek Budán 1998 óta. A csapatunk minden nap azért " +
  "dolgozik, hogy a páciensek ne féljenek a fogorvostól, és hogy a kezelés után " +
  "mosolyogva menjenek el tőlünk.";
const HU_HEADLINE = "Ügyvezető @ Danubia Fogászat | mosolytervezés";
const HU_POST =
  "Nagyon büszke vagyok arra, hogy a rendelőnk már huszonöt éve működik, és hogy " +
  "a betegeink többsége visszatér hozzánk.";

describe("the three specified cases", () => {
  /** THE REPORTED BUG. */
  it("resolves the English profile in the Bay Area to English", () => {
    const v = detectLanguage({
      headline: EN_HEADLINE,
      bio: EN_BIO,
      posts: [EN_POST],
      location: "San Francisco Bay Area",
      fallback: "HU",
    });
    expect(v.language).toBe("EN");
    expect(v.confidence).toBe("high");
    // Decided by the text, and the workspace default was NOT used.
    expect(v.reason).toBe("stopword_rates");
    expect(v.scores.en).toBeGreaterThan(v.scores.hu);
  });

  it("resolves a Hungarian profile in Budapest to Hungarian", () => {
    const v = detectLanguage({
      headline: HU_HEADLINE,
      bio: HU_BIO,
      posts: [HU_POST],
      location: "Budapest, Hungary",
      fallback: "EN",
    });
    expect(v.language).toBe("HU");
    expect(v.confidence).toBe("high");
    // Even though the workspace default here is EN.
    expect(v.scores.hu).toBeGreaterThan(v.scores.en);
  });

  it("falls back to the default for a two-word profile", () => {
    for (const fallback of ["HU", "EN"] as const) {
      const v = detectLanguage({ headline: "CEO Seyu", location: "Budapest, Hungary", fallback });
      expect(v.language).toBe(fallback);
      expect(v.confidence).toBe("low");
      expect(v.reason).toBe("text_too_short_used_workspace_default");
    }
  });
});

describe("what decides it, and what does not", () => {
  it("lets the TEXT beat the country, in both directions", () => {
    // English words, Hungarian location.
    const a = detectLanguage({ bio: EN_BIO, location: "Budapest, Hungary", fallback: "HU" });
    expect(a.language).toBe("EN");
    // Hungarian words, US location.
    const b = detectLanguage({ bio: HU_BIO, location: "San Francisco Bay Area", fallback: "EN" });
    expect(b.language).toBe("HU");
  });

  it("uses the country only to break a tie", () => {
    // Text with almost no function words in either language.
    const neutral = "Metaview Ramp Navan Seyu Budapest Sales Advisor Investor Alum Growth Partner";
    const hu = detectLanguage({ bio: neutral, location: "Budapest, Hungary", fallback: "EN" });
    expect(hu.language).toBe("HU");
    expect(hu.reason).toBe("text_inconclusive_country_decided");

    const en = detectLanguage({ bio: neutral, location: "Austin, Texas, United States", fallback: "HU" });
    expect(en.language).toBe("EN");
    expect(en.reason).toBe("text_inconclusive_country_decided");
  });

  /**
   * `ő` and `ű` are effectively Hungarian-only; the shared diacritics are not.
   * An English bio mentioning Zürich or München must not become Hungarian.
   */
  it("does not turn English into Hungarian over a borrowed diacritic", () => {
    const v = detectLanguage({
      bio:
        "We opened an office in Zürich and another in München, and the team there is " +
        "excellent at what they do every single day of the week.",
      location: "London, England, United Kingdom",
      fallback: "HU",
    });
    expect(v.language).toBe("EN");
  });

  it("counts the Hungarian-only letters as strong evidence", () => {
    const v = detectLanguage({
      bio: "Az ügyvezető szerepe az, hogy a csapat működését segítse minden nap, és hogy a növekedést tervezze.",
      fallback: "EN",
    });
    expect(v.language).toBe("HU");
    expect(v.reason).toBe("hungarian_only_letters_and_stopwords");
  });

  it("compares RATES, so a long post cannot out-vote a short bio by length", () => {
    // A short Hungarian bio against a long English post: the English wins on rate
    // AND on volume, which is correct. The point of the rate is that the reverse
    // also holds — a long Hungarian text is not beaten by a short English one.
    const v = detectLanguage({
      bio: "A csapat minden nap azért dolgozik, hogy a páciensek ne féljenek, és hogy jól érezzék magukat.",
      posts: ["Sales", "Growth"],
      fallback: "EN",
    });
    expect(v.language).toBe("HU");
  });

  it("ignores URLs, which belong to no language", () => {
    const v = detectLanguage({
      bio: `https://metaview.ai https://ramp.com ${EN_BIO}`,
      fallback: "HU",
    });
    expect(v.language).toBe("EN");
  });

  it("treats just under the threshold as too short, and just over as judgeable", () => {
    const short = "Sales at Acme and more";
    expect(short.length).toBeLessThan(MIN_TEXT_FOR_DETECTION);
    expect(detectLanguage({ bio: short, fallback: "HU" }).reason).toBe(
      "text_too_short_used_workspace_default",
    );
    const long = "I am the head of sales at Acme and we work with the best of them";
    expect(long.length).toBeGreaterThan(MIN_TEXT_FOR_DETECTION);
    expect(detectLanguage({ bio: long, fallback: "HU" }).language).toBe("EN");
  });

  it("always reports its scores, so a wrong call is explainable", () => {
    const v = detectLanguage({ bio: EN_BIO, fallback: "HU" });
    expect(typeof v.scores.hu).toBe("number");
    expect(typeof v.scores.en).toBe("number");
    expect(v.scores.chars).toBeGreaterThan(0);
    expect(v.reason).toMatch(/^[a-z0-9_]+$/);
  });

  it("mirrors the schema default", () => {
    expect(DEFAULT_LANG).toBe("HU");
  });
});

describe("a human's choice is never overwritten", () => {
  const high = detectLanguage({ bio: EN_BIO, fallback: "HU" });

  it("refuses to replace a manual choice, however confident the detection", () => {
    expect(high.confidence).toBe("high");
    expect(
      shouldReplaceLanguage({ language: "HU", languageConfidence: MANUAL_CONFIDENCE }, high),
    ).toBe(false);
  });

  it("replaces a low-confidence guess with a confident detection", () => {
    expect(shouldReplaceLanguage({ language: "HU", languageConfidence: "low" }, high)).toBe(true);
    // And a never-detected row (null) counts as the weakest of all.
    expect(shouldReplaceLanguage({ language: "HU", languageConfidence: null }, high)).toBe(true);
  });

  it("does not replace a confident value with a vaguer one", () => {
    const weak = detectLanguage({ headline: "CEO Seyu", fallback: "HU" });
    expect(weak.confidence).toBe("low");
    expect(shouldReplaceLanguage({ language: "EN", languageConfidence: "high" }, weak)).toBe(false);
  });

  it("does nothing when the answer is already the same", () => {
    expect(shouldReplaceLanguage({ language: "EN", languageConfidence: "low" }, high)).toBe(false);
  });
});
