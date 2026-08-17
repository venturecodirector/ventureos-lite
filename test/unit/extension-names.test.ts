import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The name gate (capture item A).
 *
 * Every name a capture offers has to agree with the profile's slug and the page
 * title, and both directions of getting that wrong are silent. Too strict and a
 * correct Hungarian name is thrown away, leaving the lead named after whatever
 * the title said. Too loose and one of the 28-38 other people on a real profile
 * page is filed as the lead.
 *
 * The table below is the specified one, plus the two defects the real fixtures
 * turned up: the top-card anchor's text is the name with the headline glued
 * straight onto it ("Anonimizált ÖdönCEO at Seyu", no separator), and in the
 * other fixture with the connection degree in between ("Anonimizált Ödön• 1st •
 * CEO at Seyu"). The old validator ACCEPTED both as names.
 */
const SOURCE = readFileSync(join(process.cwd(), "extension/names.js"), "utf8");

interface Verdict {
  ok: boolean;
  why: string | null;
  rule: string | null;
  ratio?: number;
}
interface Names {
  fold(s: string): string;
  allNameTokens(s: string): string[];
  surnameToken(s: string): string;
  isConcatenationOfTokens(flat: string, tokens: string[]): boolean;
  matchesInitialsPattern(flat: string, tokens: string[]): boolean;
  slugify(s: string): string;
  isDisambiguator(t: string): boolean;
  slugTokens(s: string): string[];
  nameTokens(s: string): string[];
  nameFromTitle(t: string): string | null;
  titleNamesExactly(title: string, name: string): boolean;
  stripNoise(v: string): string;
  trimToTitleName(candidate: string, title: string): string | null;
  looksGlued(v: string): boolean;
  sharedRatio(name: string, slug: string): number;
  nameAgreesWithSlug(name: string, slug: string, opts?: { title?: string }): Verdict;
  nameAgreesWithTitle(name: string, title: string): Verdict;
  SUBSET_MIN_RATIO: number;
}

function load(): Names {
  const g: { VentureNames?: Names } = {};
  new Function("globalThis", SOURCE)(g);
  if (!g.VentureNames) throw new Error("names.js did not register VentureNames");
  return g.VentureNames;
}

const N = load();

describe("accent folding — the reason Hungarian names were rejected", () => {
  it("folds every diacritic the language uses", () => {
    expect(N.fold("Tamás Dániel Vezér")).toBe("tamas daniel vezer");
    expect(N.fold("Tóth-Szűcs Örs Ábel")).toBe("toth-szucs ors abel");
    expect(N.fold("Anonimizált Ödön")).toBe("anonimizalt odon");
  });

  it("slugifies a name into exactly the shape LinkedIn's URL uses", () => {
    expect(N.slugify("Tamás Dániel Vezér")).toBe("tamas-daniel-vezer");
    expect(N.slugify("Tom 'Vechy' Vecsernyes")).toBe("tom-vechy-vecsernyes");
    // Trailing and repeated punctuation collapses rather than leaving empties.
    expect(N.slugify("  Kovács,  Anna!  ")).toBe("kovacs-anna");
  });
});

describe("the disambiguator suffix", () => {
  it("recognises LinkedIn's ID-shaped suffixes", () => {
    for (const t of ["1a2b3c4", "3802a22b0", "8a72b1", "abcdef12"]) {
      expect(N.isDisambiguator(t), t).toBe(true);
    }
  });

  /**
   * THE REASON THE RULE IS NARROW. "Strip a final token of 4-12 alphanumerics"
   * eats `vezer`, `fixture`, and every surname of that length. A disambiguator
   * carries a digit or is a long hex run; a run of letters might be a name.
   */
  it("never mistakes a surname for one", () => {
    for (const t of ["vezer", "fixture", "kovacs", "vecsernyes", "szucs"]) {
      expect(N.isDisambiguator(t), t).toBe(false);
    }
  });

  it("drops it from the slug's tokens, keeping the name parts", () => {
    expect(N.slugTokens("tamas-vezer-1a2b3c4")).toEqual(["tamas", "vezer"]);
    expect(N.slugTokens("beata-ferenczi-3802a22b0")).toEqual(["beata", "ferenczi"]);
    // Nothing ID-shaped here, so nothing is dropped.
    expect(N.slugTokens("anna-kovacs-fixture")).toEqual(["anna", "kovacs", "fixture"]);
  });
});

/**
 * THE SPECIFIED TABLE. Each row is a real pair; the last must still be rejected,
 * because a validator that accepts everything is not a validator.
 */
describe("the name/slug agreement table", () => {
  const TABLE: { name: string; slug: string; accept: boolean; note: string }[] = [
    {
      name: "Tamás Dániel Vezér",
      slug: "tamas-daniel-vezer",
      accept: true,
      note: "accent folding, identical token order",
    },
    {
      name: "Vezér Tamás Dániel",
      slug: "tamas-vezer-1a2b3c4",
      accept: true,
      note: "family name first, truncated, ID suffix",
    },
    {
      name: "Tom 'Vechy' Vecsernyes",
      slug: "tom-vechy-vecsernyes",
      accept: true,
      note: "quoted nickname becomes its own token",
    },
    {
      name: "Kovács Anna",
      slug: "anna-kovacs-fixture",
      accept: true,
      note: "reordered, slug carries an extra word",
    },
    {
      name: "Teljesen Más Ember",
      slug: "tamas-daniel-vezer",
      accept: false,
      note: "a genuinely different person",
    },
  ];

  for (const { name, slug, accept, note } of TABLE) {
    it(`${accept ? "accepts" : "rejects"} "${name}" against /in/${slug} — ${note}`, () => {
      const v = N.nameAgreesWithSlug(name, slug);
      expect(v.ok, `${name} vs ${slug}: ${v.why ?? v.rule}`).toBe(accept);
      if (accept) {
        expect(v.why).toBeNull();
        expect(v.rule).toBeTruthy();
      } else {
        expect(v.why).toBe("name_disagrees_with_profile_url");
      }
    });
  }

  it("accepts on the subset rule where it applies, and the ratio rule otherwise", () => {
    expect(N.nameAgreesWithSlug("Tamás Dániel Vezér", "tamas-daniel-vezer").rule).toBe(
      "slug_tokens_subset_of_name",
    );
    // "fixture" is not in the name, so the subset rule cannot fire; both of the
    // name's own tokens are in the slug, so the ratio rule does.
    expect(N.nameAgreesWithSlug("Kovács Anna", "anna-kovacs-fixture").rule).toMatch(
      /^shared_ratio_1\.00$/,
    );
  });

  it("is symmetric about word order", () => {
    for (const slug of ["tamas-daniel-vezer", "vezer-tamas-daniel", "daniel-vezer-tamas"]) {
      expect(N.nameAgreesWithSlug("Tamás Dániel Vezér", slug).ok, slug).toBe(true);
    }
  });

  it("rejects a stranger even when one token coincides", () => {
    // A shared first name is not agreement: 1 of 3 tokens is 33%, under the floor.
    const v = N.nameAgreesWithSlug("Tamás Kovács Nagy", "tamas-daniel-vezer");
    expect(v.ok).toBe(false);
  });
});

describe("agreement with the page title", () => {
  it("accepts the exact '<Name> | LinkedIn' form", () => {
    const v = N.nameAgreesWithTitle("Tamás Dániel Vezér", "Tamás Dániel Vezér | LinkedIn");
    expect(v.ok).toBe(true);
    expect(v.rule).toBe("title_names_exactly");
  });

  it("reads the name out of a title carrying an unread-count badge", () => {
    expect(N.nameFromTitle("(3) Tamás Dániel Vezér | LinkedIn")).toBe("Tamás Dániel Vezér");
    expect(N.nameFromTitle("Anonimizált Ödön | LinkedIn")).toBe("Anonimizált Ödön");
  });

  it("does not reject when there is no title to disagree with", () => {
    expect(N.nameAgreesWithTitle("Tamás Dániel Vezér", "").ok).toBe(true);
  });

  /**
   * The overlay-route failure mode. On /overlay/ the title is the overlay's, not
   * the person's — which is where the reported `name_disagrees_with_page_title`
   * actually came from.
   */
  it("rejects a name that shares nothing with the title", () => {
    const v = N.nameAgreesWithTitle("Tamás Dániel Vezér", "Kapcsolati adatok | LinkedIn");
    expect(v.ok).toBe(false);
    expect(v.why).toBe("name_disagrees_with_page_title");
  });
});

/**
 * THE DEFECT THE FIXTURES EXPOSED, which the brief did not predict: the value
 * offered as the name is the name with the headline glued onto it. The old
 * validator accepted it, so the lead's name was "Anonimizált ÖdönCEO at Seyu".
 */
describe("glued-together candidates, straight from the fixtures", () => {
  const TITLE = "Anonimizált Ödön | LinkedIn";

  it("trims a name with the headline concatenated onto it", () => {
    expect(N.trimToTitleName("Anonimizált ÖdönCEO at Seyu", TITLE)).toBe("Anonimizált Ödön");
  });

  it("trims a name with the connection degree and headline after it", () => {
    expect(N.trimToTitleName("Anonimizált Ödön• 1st • CEO at Seyu", TITLE)).toBe(
      "Anonimizált Ödön",
    );
  });

  it("leaves a clean name exactly as written, accents and order intact", () => {
    expect(N.trimToTitleName("Anonimizált Ödön", TITLE)).toBe("Anonimizált Ödön");
    // The card's order wins over the title's when both name the same person.
    expect(N.trimToTitleName("Tóth-Szűcs Örs Ábel", "Örs Ábel Tóth-Szűcs | LinkedIn")).toBe(
      "Tóth-Szűcs Örs Ábel",
    );
  });

  it("never lengthens or invents — an unrelated candidate is returned untouched", () => {
    expect(N.trimToTitleName("Somebody Else", TITLE)).toBe("Somebody Else");
  });

  it("strips the degree marker even with no title available", () => {
    expect(N.stripNoise("Anonimizált Ödön • 1st • CEO at Seyu")).toBe("Anonimizált Ödön");
    expect(N.stripNoise("Kovács Anna · 2nd")).toBe("Kovács Anna");
  });

  it("spots a glued candidate on its own, for when there is no title", () => {
    expect(N.looksGlued("Anonimizált ÖdönCEO at Seyu")).toBe(true);
    expect(N.looksGlued("Tamás Dániel VezérCEO at Seyu")).toBe(true);
    // Real names that legitimately carry an internal capital must survive.
    for (const ok of ["Anna Kovács", "Ronald McDonald", "Luca DeLuca", "Tóth-Szűcs Örs Ábel"]) {
      expect(N.looksGlued(ok), ok).toBe(false);
    }
  });
});


/**
 * ── ABBREVIATED SLUGS ──────────────────────────────────────────────────────
 *
 * /in/mgoldberger. One token, formed from an initial and a surname, with no
 * separator to split on — so every word-set rule above is blind to it. Nine
 * attempts were rejected on that profile and the lead was saved with no name,
 * which then cascaded: a rejected name is not excluded from the card's own lines,
 * so the headline extractor took it and the form showed "Mark Goldberger" in the
 * job-title slot with an empty Name field.
 */
describe("the abbreviated-slug table", () => {
  const TABLE: { slug: string; name: string; accept: boolean; note: string }[] = [
    { slug: "mgoldberger", name: "Mark Goldberger", accept: true, note: "initial + surname" },
    { slug: "tamas-daniel-vezer", name: "Tamás Dániel Vezér", accept: true, note: "unchanged" },
    { slug: "tom-vechy-vecsernyes", name: "Tom 'Vechy' Vecsernyes", accept: true, note: "unchanged" },
    { slug: "jsmith", name: "John Smith", accept: true, note: "initial + surname, short" },
    { slug: "jsmith", name: "Anna Kovács", accept: false, note: "a different person" },
    { slug: "mdgoldberger", name: "Mark D Goldberger", accept: true, note: "two initials + surname" },
    { slug: "markgoldberger", name: "Mark Goldberger", accept: true, note: "concatenated, in order" },
    { slug: "goldbergermark", name: "Mark Goldberger", accept: true, note: "concatenated, reversed" },
  ];

  for (const { slug, name, accept, note } of TABLE) {
    it(`${accept ? "accepts" : "rejects"} "${name}" at /in/${slug} — ${note}`, () => {
      const v = N.nameAgreesWithSlug(name, slug, { title: `${name} | LinkedIn` });
      expect(v.ok, `${name} vs ${slug}: ${v.why ?? v.rule}`).toBe(accept);
      if (accept) expect(v.rule).toBeTruthy();
      else expect(v.why).toBe("name_disagrees_with_profile_url");
    });
  }

  it("names which rule accepted, so a dump can be read", () => {
    expect(N.nameAgreesWithSlug("Mark Goldberger", "mgoldberger").rule).toBe(
      "slug_is_initials_plus_surname",
    );
    expect(N.nameAgreesWithSlug("Mark Goldberger", "markgoldberger").rule).toBe(
      "slug_is_concatenated_name_tokens",
    );
  });

  it("accepts on surname + an exactly-naming title, as two independent agreements", () => {
    // The given name is absent from the slug entirely, so no other rule fires.
    const v = N.nameAgreesWithSlug("Mark Goldberger", "goldberger-nyc", {
      title: "Mark Goldberger | LinkedIn",
    });
    expect(v.ok).toBe(true);
    expect(v.rule).toBe("surname_in_slug_and_title_names_exactly");
  });

  it("still rejects when the surname is absent from the slug entirely", () => {
    for (const [name, slug] of [
      ["Anna Kovács", "jsmith"],
      ["Teljesen Más Ember", "tamas-daniel-vezer"],
      ["Mark Goldberger", "dwhitfield"],
    ] as const) {
      expect(N.nameAgreesWithSlug(name, slug, { title: `${name} | LinkedIn` }).ok, slug).toBe(false);
    }
  });

  describe("the pieces, on their own", () => {
    it("cuts a concatenated slug into the name's tokens, in any order", () => {
      expect(N.isConcatenationOfTokens("markgoldberger", ["mark", "goldberger"])).toBe(true);
      expect(N.isConcatenationOfTokens("goldbergermark", ["mark", "goldberger"])).toBe(true);
      // Not a cover: leftover characters.
      expect(N.isConcatenationOfTokens("markgoldbergerx", ["mark", "goldberger"])).toBe(false);
      expect(N.isConcatenationOfTokens("markjones", ["mark", "goldberger"])).toBe(false);
    });

    it("reads initials plus a later token, and refuses a coincidence", () => {
      expect(N.matchesInitialsPattern("mgoldberger", ["mark", "goldberger"])).toBe(true);
      expect(N.matchesInitialsPattern("mdgoldberger", ["mark", "d", "goldberger"])).toBe(true);
      // "g" is not Mark's initial, and "oldberger" is not a token.
      expect(N.matchesInitialsPattern("goldberge", ["mark", "goldberger"])).toBe(false);
      expect(N.matchesInitialsPattern("mjones", ["mark", "goldberger"])).toBe(false);
    });

    it("keeps single-letter tokens, which the initials rule needs", () => {
      expect(N.allNameTokens("Mark D Goldberger")).toEqual(["mark", "d", "goldberger"]);
      expect(N.nameTokens("Mark D Goldberger")).toEqual(["mark", "goldberger"]);
    });

    it("picks the longest token as the surname", () => {
      expect(N.surnameToken("Mark Goldberger")).toBe("goldberger");
      expect(N.surnameToken("Tóth-Szűcs Örs Ábel")).toBe("szucs");
    });
  });
});
