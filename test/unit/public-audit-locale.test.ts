import { describe, it, expect } from "vitest";
import {
  detectLocale,
  localeFromAcceptLanguage,
  otherLocale,
  isLocale,
  DEFAULT_LOCALE,
  LOCALES,
} from "@/lib/locale";
import { LANDING_COPY, copyFor, type LandingCopy } from "@/modules/public-audit/copy";
import { consentSnapshot, CONSENT_TEXT_VERSION } from "@/modules/public-audit/consent-text";

/**
 * P12 landing — language selection and the bilingual dictionary.
 *
 * The completeness test at the bottom is the one that earns its keep: the
 * failure mode of hand-rolled i18n is a blank space on a live page in the
 * language you do not read.
 */
describe("localeFromAcceptLanguage", () => {
  it("takes the first supported language", () => {
    expect(localeFromAcceptLanguage("hu-HU,hu;q=0.9,en;q=0.8")).toBe("hu");
    expect(localeFromAcceptLanguage("en-GB,en;q=0.9")).toBe("en");
  });

  it("honours quality weights over document order", () => {
    // Written hu-first, but English is what they actually asked for.
    expect(localeFromAcceptLanguage("hu;q=0.5, en;q=1.0")).toBe("en");
  });

  it("ignores region subtags", () => {
    expect(localeFromAcceptLanguage("en-AU")).toBe("en");
    expect(localeFromAcceptLanguage("hu-HU")).toBe("hu");
  });

  it("skips languages we do not serve and takes the next one", () => {
    expect(localeFromAcceptLanguage("de-DE,de;q=0.9,en;q=0.4")).toBe("en");
  });

  it("returns null when nothing is on offer that we speak", () => {
    expect(localeFromAcceptLanguage("de-DE,fr;q=0.8")).toBeNull();
    expect(localeFromAcceptLanguage("")).toBeNull();
    expect(localeFromAcceptLanguage(null)).toBeNull();
  });

  it("does not treat a wildcard as a preference", () => {
    expect(localeFromAcceptLanguage("*")).toBeNull();
  });

  it("survives a malformed header instead of throwing", () => {
    expect(localeFromAcceptLanguage(";;;q=")).toBeNull();
    expect(localeFromAcceptLanguage("en;q=notanumber")).toBeNull();
  });

  it("ignores a language explicitly rejected with q=0", () => {
    expect(localeFromAcceptLanguage("en;q=0, hu;q=1")).toBe("hu");
  });
});

describe("detectLocale precedence", () => {
  it("puts an explicit choice above the browser hint", () => {
    expect(detectLocale({ cookie: "en", acceptLanguage: "hu-HU,hu;q=0.9" })).toBe("en");
    expect(detectLocale({ cookie: "hu", acceptLanguage: "en-US" })).toBe("hu");
  });

  it("falls back to the browser hint with no cookie", () => {
    expect(detectLocale({ acceptLanguage: "en-US,en;q=0.9" })).toBe("en");
  });

  it("falls back to Hungarian when nobody expresses an opinion", () => {
    expect(detectLocale({})).toBe(DEFAULT_LOCALE);
    expect(detectLocale({ cookie: "de", acceptLanguage: "de-DE" })).toBe("hu");
  });

  it("ignores a junk cookie rather than trusting it", () => {
    expect(detectLocale({ cookie: "'; DROP TABLE", acceptLanguage: "en" })).toBe("en");
  });
});

describe("otherLocale", () => {
  it("is the switcher's target", () => {
    expect(otherLocale("hu")).toBe("en");
    expect(otherLocale("en")).toBe("hu");
  });
});

describe("isLocale", () => {
  it("accepts only what we serve", () => {
    expect(isLocale("hu")).toBe(true);
    expect(isLocale("en")).toBe(true);
    expect(isLocale("de")).toBe(false);
    expect(isLocale(null)).toBe(false);
    expect(isLocale(42)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The dictionary
// ---------------------------------------------------------------------------

/** Every leaf string in a copy object, with the path that led to it. */
function leaves(value: unknown, path: string[] = []): Array<{ path: string; value: unknown }> {
  if (typeof value === "function") return [{ path: path.join("."), value: "fn" }];
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => leaves(v, [...path, String(i)]));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => leaves(v, [...path, k]));
  }
  return [{ path: path.join("."), value }];
}

describe("bilingual copy", () => {
  it("has the same shape in both languages", () => {
    const huPaths = leaves(LANDING_COPY.hu).map((l) => l.path).sort();
    const enPaths = leaves(LANDING_COPY.en).map((l) => l.path).sort();
    expect(enPaths).toEqual(huPaths);
  });

  it("has no empty or placeholder strings anywhere", () => {
    for (const locale of LOCALES) {
      for (const leaf of leaves(LANDING_COPY[locale])) {
        if (leaf.value === "fn") continue;
        expect(typeof leaf.value, `${locale}.${leaf.path}`).toBe("string");
        const text = String(leaf.value).trim();
        expect(text.length, `${locale}.${leaf.path} is empty`).toBeGreaterThan(0);
        expect(text, `${locale}.${leaf.path} looks unfinished`).not.toMatch(/TODO|TBD|LOREM/i);
      }
    }
  });

  it("does not leave a string identical in both languages where it should differ", () => {
    // The headline is the one line that would most obviously betray a missed
    // translation, and it is short enough to be worth pinning.
    expect(LANDING_COPY.hu.hero.headline).not.toBe(LANDING_COPY.en.hero.headline);
    expect(LANDING_COPY.hu.unlock.serviceConsent).not.toBe(
      LANDING_COPY.en.unlock.serviceConsent,
    );
  });

  it("formats the queue position in both languages", () => {
    expect(LANDING_COPY.hu.progress.queuePosition(3)).toContain("3");
    expect(LANDING_COPY.en.progress.queuePosition(3)).toContain("3");
  });

  it("offers the other language as the switch label", () => {
    expect(LANDING_COPY.hu.footer.switchLabel).toBe("English");
    expect(LANDING_COPY.en.footer.switchLabel).toBe("Magyar");
  });

  it("keeps the FAQ answering the same questions in both languages", () => {
    expect(LANDING_COPY.hu.faq.items).toHaveLength(LANDING_COPY.en.faq.items.length);
  });

  it("copyFor returns the right dictionary", () => {
    expect(copyFor("hu")).toBe(LANDING_COPY.hu);
    expect(copyFor("en")).toBe(LANDING_COPY.en);
  });
});

describe("consent snapshot", () => {
  it("versions the wording per language", () => {
    expect(consentSnapshot("hu").version).toBe(`hu-${CONSENT_TEXT_VERSION}`);
    expect(consentSnapshot("en").version).toBe(`en-${CONSENT_TEXT_VERSION}`);
  });

  it("captures the exact text the person was shown", () => {
    const snap = consentSnapshot("hu");
    expect(snap.serviceText).toBe(LANDING_COPY.hu.unlock.serviceConsent);
    expect(snap.marketingText).toBe(LANDING_COPY.hu.unlock.marketingConsent);
  });

  it("keeps marketing wording distinct from service wording", () => {
    // If these ever collapsed into one string, the two-consent construction
    // would be decorative.
    for (const locale of LOCALES) {
      const snap = consentSnapshot(locale);
      expect(snap.serviceText).not.toBe(snap.marketingText);
    }
  });
});

/** Guards the shape the page reads, so a rename cannot silently blank a section. */
describe("copy structure", () => {
  it("keeps the three steps and at least three FAQ entries", () => {
    for (const locale of LOCALES) {
      const copy: LandingCopy = LANDING_COPY[locale];
      expect(copy.steps.items).toHaveLength(3);
      expect(copy.faq.items.length).toBeGreaterThanOrEqual(3);
      expect(copy.privacy.bullets).toHaveLength(3);
    }
  });
});
