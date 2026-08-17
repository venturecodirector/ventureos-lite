/**
 * Does this name belong to this profile? Injected alongside selectors.js.
 *
 * ── WHY A WHOLE FILE FOR COMPARING TWO STRINGS ──────────────────────────────
 *
 * Because the comparison is the gate every name has to pass, and getting it
 * wrong is silent in both directions. Too strict and a correct Hungarian name is
 * discarded, leaving a lead called by whatever the page title happened to say.
 * Too loose and a stranger's name — there are 28 to 38 other people on a real
 * profile page — is filed as the lead's own.
 *
 * The three things that make this harder than `a === b`:
 *
 *   ACCENTS. The slug is always accent-folded ASCII: "Tamás Dániel Vezér" lives
 *   at /in/tamas-daniel-vezer. Comparing the two without folding rejects every
 *   name with a diacritic, which in Hungarian is most of them.
 *
 *   ORDER. Hungarian writes the family name first, and LinkedIn's slug does not
 *   preserve whichever order the profile used. "Vezér Tamás Dániel" and
 *   "tamas-daniel-vezer" are the same person. So tokens are compared as SETS.
 *
 *   TRUNCATION AND SUFFIXES. LinkedIn shortens long names in the slug and appends
 *   a disambiguator when the vanity name is taken: /in/tamas-vezer-1a2b3c4. So the
 *   slug's tokens are a SUBSET of the name's, not equal to them.
 *
 * ── THE DISAMBIGUATOR RULE IS DELIBERATELY NARROW ───────────────────────────
 *
 * "Strip the final hyphen-delimited token of 4-12 alphanumerics" would strip
 * `vezer` from `tamas-daniel-vezer` and `fixture` from `anna-kovacs-fixture` —
 * both real tokens — and every surname of 4 to 12 letters along with them. A
 * disambiguator is ID-SHAPED: it carries a digit, or it is a long run of hex.
 * That is what is required here, so a surname is never mistaken for one.
 * (`sharedRatio` then makes the `-fixture` case pass on its own merits: both of
 * the name's tokens appear in the slug.)
 */
(() => {
  /** NFD, drop combining marks, lowercase. The accent fix, in one place. */
  function fold(s) {
    return String(s ?? "")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase();
  }

  /** Folded, with every run of non-alphanumerics collapsed to one hyphen. */
  function slugify(s) {
    return fold(s)
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  /**
   * Is this final slug token LinkedIn's disambiguator rather than part of a name?
   *
   * ID-shaped only: 4-12 characters that either include a digit ("1a2b3c4",
   * "3802a22b0", "8a72b1") or are a long pure-hex run ("abcdef12"). A run of
   * letters that could be a surname is left alone — see the note above.
   */
  function isDisambiguator(token) {
    if (!token || token.length < 4 || token.length > 12) return false;
    if (!/^[a-z0-9]+$/.test(token)) return false;
    if (/\d/.test(token)) return true;
    return token.length >= 6 && /^[a-f]+$/.test(token);
  }

  /** A slug's meaningful tokens, disambiguator removed. */
  function slugTokens(slug) {
    const parts = slugify(slug).split("-").filter(Boolean);
    if (parts.length > 1 && isDisambiguator(parts[parts.length - 1])) parts.pop();
    return parts.filter((t) => t.length >= 2);
  }

  /**
   * A name's meaningful tokens.
   *
   * Apostrophes and quotes are separators, so a nickname in quotes — Tom 'Vechy'
   * Vecsernyes — contributes `vechy` as its own token, which is exactly how it
   * appears in the slug.
   */
  function nameTokens(name) {
    return slugify(name).split("-").filter((t) => t.length >= 2);
  }

  /** The person's name as written in a LinkedIn page title, or null. */
  function nameFromTitle(title) {
    const raw = String(title ?? "").replace(/\s+/g, " ").trim();
    if (!raw) return null;
    // "(3) Tamás Dániel Vezér | LinkedIn" — the count is an unread-message badge.
    const withoutBadge = raw.replace(/^\(\d+\)\s*/, "");
    const m = /^(.*?)\s*\|\s*LinkedIn\s*$/i.exec(withoutBadge);
    const name = (m ? m[1] : withoutBadge).trim();
    return name.length > 0 ? name : null;
  }

  /** Does the title read exactly "<name> | LinkedIn"? */
  function titleNamesExactly(title, name) {
    const fromTitle = nameFromTitle(title);
    if (!fromTitle || !name) return false;
    return slugify(fromTitle) === slugify(name);
  }

  /**
   * Connection-degree and headline noise LinkedIn glues onto the name.
   *
   * The top-card anchor's textContent on the real page is
   * "Anonimizált Ödön• 1st • CEO at Seyu" — one anchor, three facts, no
   * separators the DOM exposes. Everything from the degree marker on is dropped.
   */
  function stripNoise(value) {
    return String(value ?? "")
      .replace(/\s*[·•]\s*\d+(st|nd|rd|th)\b.*$/i, "")
      .replace(/\s*[·•]\s*\d+\.\s*fokú.*$/i, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  /**
   * Trim a candidate down to the name the title states, when it merely has extra
   * text glued on.
   *
   * This is the fix for the concatenated name the fixtures produce: the top-card
   * anchor reads "Anonimizált ÖdönCEO at Seyu" with no separator between the name
   * and the headline, so there is nothing to split on — but the title says where
   * the name ends. Only ever SHORTENS, and only when the candidate starts with
   * the title's name, so it cannot invent a value.
   */
  function trimToTitleName(candidate, title) {
    const value = stripNoise(candidate);
    const fromTitle = nameFromTitle(title);
    if (!value || !fromTitle) return value || null;
    if (slugify(value) === slugify(fromTitle)) return value;
    // Compare on the folded slug so accents and spacing cannot prevent the match.
    const vs = slugify(value);
    const ts = slugify(fromTitle);
    if (ts.length > 0 && vs.startsWith(ts) && vs.length > ts.length) return fromTitle;
    return value;
  }

  /**
   * Two words shoved together with no space — "ÖdönCEO".
   *
   * Only used when there is no title to trim against. A lowercase letter followed
   * immediately by two or more uppercase letters is not a name; a single
   * capital after a lowercase is ordinary CamelCase in some real names
   * (McDonald, DeLuca), so it is not enough on its own.
   */
  function looksGlued(value) {
    return /\p{Ll}\p{Lu}{2,}/u.test(String(value ?? ""));
  }

  /**
   * Fraction of the name's tokens that appear in the slug.
   *
   * The forgiving half of the rule: LinkedIn truncates long names, so the slug
   * may hold only some of them. 0.6 is the specified floor.
   */
  function sharedRatio(name, slug) {
    const n = nameTokens(name);
    if (n.length === 0) return 0;
    const s = new Set(slugTokens(slug));
    return n.filter((t) => s.has(t)).length / n.length;
  }

  const SUBSET_MIN_RATIO = 0.6;

  /**
   * Does this name belong to this slug?
   *
   * Accepts on either rule: the slug's tokens are all present in the name (the
   * usual case, including truncation and suffixes), or enough of the name's
   * tokens appear in the slug. Rejects only when there is no overlap worth the
   * name — which is the one case where the value really is somebody else's.
   */
  function nameAgreesWithSlug(name, slug) {
    const n = new Set(nameTokens(name));
    const s = slugTokens(slug);
    if (n.size === 0) return { ok: false, why: "name_has_no_comparable_tokens", rule: null };
    if (s.length === 0) return { ok: true, why: null, rule: "slug_has_no_tokens_to_disagree_with" };

    const slugSubsetOfName = s.every((t) => n.has(t));
    if (slugSubsetOfName) return { ok: true, why: null, rule: "slug_tokens_subset_of_name" };

    const ratio = sharedRatio(name, slug);
    if (ratio >= SUBSET_MIN_RATIO) {
      return { ok: true, why: null, rule: `shared_ratio_${ratio.toFixed(2)}` };
    }
    // Any overlap at all is still agreement when the slug is a single token: a
    // one-word slug cannot carry a whole name.
    if (s.length === 1 && n.has(s[0])) {
      return { ok: true, why: null, rule: "single_slug_token_present_in_name" };
    }
    return { ok: false, why: "name_disagrees_with_profile_url", rule: null, ratio };
  }

  /**
   * The same question against the page title.
   *
   * An exact "<Name> | LinkedIn" is the strongest possible agreement and short
   * circuits everything. Otherwise any shared token is enough: the title and the
   * card can legitimately differ in order and completeness.
   */
  function nameAgreesWithTitle(name, title) {
    if (titleNamesExactly(title, name)) {
      return { ok: true, why: null, rule: "title_names_exactly" };
    }
    const fromTitle = nameFromTitle(title);
    if (!fromTitle) return { ok: true, why: null, rule: "no_title_to_disagree_with" };
    const t = new Set(nameTokens(fromTitle));
    const n = nameTokens(name);
    if (t.size === 0 || n.length === 0) return { ok: true, why: null, rule: "no_comparable_tokens" };
    return n.some((x) => t.has(x))
      ? { ok: true, why: null, rule: "shares_a_token_with_title" }
      : { ok: false, why: "name_disagrees_with_page_title", rule: null };
  }

  globalThis.VentureNames = {
    fold,
    slugify,
    isDisambiguator,
    slugTokens,
    nameTokens,
    nameFromTitle,
    titleNamesExactly,
    stripNoise,
    trimToTitleName,
    looksGlued,
    sharedRatio,
    nameAgreesWithSlug,
    nameAgreesWithTitle,
    SUBSET_MIN_RATIO,
  };
})();
