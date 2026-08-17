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

  /**
   * Every token INCLUDING single letters.
   *
   * `nameTokens` drops one-character tokens because they are noise when comparing
   * word sets. The initials rule needs them: "Mark D Goldberger" abbreviates to
   * `mdgoldberger`, and without the `d` that slug cannot be explained.
   */
  function allNameTokens(name) {
    return slugify(name).split("-").filter(Boolean);
  }

  /** The surname: the longest token, which is the one a slug almost always keeps. */
  function surnameToken(name) {
    return nameTokens(name).reduce((best, t) => (t.length > best.length ? t : best), "");
  }

  /**
   * Can this string be cut up entirely into the name's own tokens?
   *
   * Handles the slug that concatenates a name with no separators at all —
   * `markgoldberger`, `goldbergermark` — in any order, each token used once.
   * Depth-first because the pieces can be ambiguous: "annamaria" could start with
   * "anna" or "annamaria", and only one of the two leads to a full cover.
   */
  function isConcatenationOfTokens(flat, tokens) {
    if (!flat) return false;
    const seen = new Set();
    const walk = (rest, remaining) => {
      if (rest.length === 0) return true;
      const key = `${rest.length}|${remaining.join(",")}`;
      if (seen.has(key)) return false;
      seen.add(key);
      for (let i = 0; i < remaining.length; i += 1) {
        const t = remaining[i];
        if (t.length >= 2 && rest.startsWith(t)) {
          const next = remaining.slice(0, i).concat(remaining.slice(i + 1));
          if (walk(rest.slice(t.length), next)) return true;
        }
      }
      return false;
    };
    return walk(flat, tokens.slice());
  }

  /**
   * Does this slug read as initials plus a full later token?
   *
   * `mgoldberger` for Mark Goldberger, `mdgoldberger` for Mark D Goldberger,
   * `jsmith` for John Smith. The leading letters must be the initials of the
   * name's leading tokens IN ORDER, and the tail must be one of the tokens that
   * follows them — anything looser would accept a stranger who happens to share a
   * letter.
   */
  function matchesInitialsPattern(flat, tokens) {
    if (!flat || tokens.length < 2) return false;
    // k = how many leading tokens are reduced to their initial.
    for (let k = 1; k < tokens.length; k += 1) {
      const initials = tokens.slice(0, k).map((t) => t[0]).join("");
      if (!flat.startsWith(initials)) continue;
      const tail = flat.slice(initials.length);
      if (tail.length < 3) continue;
      // The remainder has to be a later token, or a concatenation of them.
      const later = tokens.slice(k);
      if (later.includes(tail)) return true;
      if (isConcatenationOfTokens(tail, later)) return true;
    }
    return false;
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
  function nameAgreesWithSlug(name, slug, opts = {}) {
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

    /**
     * ── ABBREVIATED SLUGS ────────────────────────────────────────────────────
     *
     * Everything above compares WORD SETS, and a word set cannot explain
     * `/in/mgoldberger`: one token, formed from an initial and a surname, with no
     * separator to split on. Nine attempts were rejected on that profile and the
     * lead was created with no name at all — which then cascaded, because a
     * rejected name is not excluded from the card's own lines and the headline
     * extractor took it instead.
     *
     * The rules below explain the shapes a slug can legitimately take. Each is
     * reported by name, so a diagnostics dump says WHICH one accepted a value.
     */
    const flat = slugTokens(slug).join("");
    const ordered = allNameTokens(name);

    // Concatenated with no separators: markgoldberger, goldbergermark.
    if (isConcatenationOfTokens(flat, ordered)) {
      return { ok: true, why: null, rule: "slug_is_concatenated_name_tokens" };
    }

    // Initials plus a full later token: mgoldberger, mdgoldberger, jsmith.
    if (matchesInitialsPattern(flat, ordered)) {
      return { ok: true, why: null, rule: "slug_is_initials_plus_surname" };
    }

    /**
     * The surname, plus a title that names this person exactly.
     *
     * Two independent agreements: the slug carries the family name, and the page
     * title — which LinkedIn writes itself — reads "<Name> | LinkedIn". Together
     * that is stronger evidence than any token ratio.
     */
    const surname = surnameToken(name);
    const hasSurname = surname.length >= 4 && flat.includes(surname);
    if (hasSurname && titleNamesExactly(opts.title ?? "", name)) {
      return { ok: true, why: null, rule: "surname_in_slug_and_title_names_exactly" };
    }

    /**
     * THE FLOOR: reject only when the surname is absent from the slug entirely.
     *
     * A slug that carries the family name is about this person, whatever else it
     * does with the given names — initials, nicknames, truncation, a middle name
     * promoted to the front. What it cannot be is somebody else, which is what
     * the rejection below is for: `jsmith` against "Anna Kovács" has no surname
     * in common and is a different human.
     */
    if (hasSurname) {
      return { ok: true, why: null, rule: "surname_present_in_slug" };
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
    allNameTokens,
    surnameToken,
    isConcatenationOfTokens,
    matchesInitialsPattern,
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
