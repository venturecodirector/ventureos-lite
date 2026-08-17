/**
 * Developer action: serialize the current page as a scrubbed test fixture.
 *
 * WHY THIS EXISTS
 *
 * Extraction has now been fixed twice against invented fixtures, and both times
 * the invented page was tidier than the page LinkedIn ships — so the tests
 * passed while the real thing stayed broken. Guessing is the expensive part, and
 * this is what ends it: a real DOM, committed once, iterated against for ever in
 * jsdom instead of by re-capturing a live profile.
 *
 * WHAT IT SENDS: structure, not people.
 *
 * The page is serialized FIRST and scrubbed as a string — the live DOM is never
 * mutated, because this runs on a page the user is reading and must not alter
 * it. Then:
 *
 *   - <script> and <code> bodies are emptied. LinkedIn ships the entire profile
 *     — every field, every connection, addresses, sometimes contact details — as
 *     JSON inside hidden <code> elements. Those are megabytes of personal data
 *     and none of it is what we are testing.
 *   - Every OTHER person's name is replaced with a placeholder. Their names are
 *     discoverable structurally: the text of every /in/<other-slug>/ anchor is a
 *     person, which is exactly the blocklist the cross-contamination validator
 *     is built on, so the fixture keeps the SHAPE of the bug while losing the
 *     humans in it.
 *   - The profile owner is replaced too, consistently across the title, the URL
 *     slug and the card. The brief said to keep the owner's real name; a
 *     committed fixture is a file in version control, CLAUDE.md hard rule #9
 *     keeps personal data on the EU server and out of places like this, and the
 *     name-consistency validator only needs title, slug and card to AGREE — not
 *     to be anyone real. Accents are preserved in the placeholder so the
 *     normalization tests still mean something.
 *   - URL query strings are dropped (licdn signatures, tracking tokens), and
 *     long opaque tokens are masked.
 *
 * Hashed class names, DOM order, nesting depth, aria attributes and the right
 * rail are all left exactly as they are. Those ARE the test.
 */
(() => {
  /**
   * The owner's replacement name.
   *
   * Deliberately NOT a plausible real name. An earlier version used "Kovács
   * Anna", and the first person to read a fixture reasonably concluded the
   * capture had grabbed the wrong profile — a recommended contact instead of the
   * subject. A placeholder has to be self-evidently a placeholder. Accents are
   * kept so the accent-normalization tests still mean something.
   */
  const OWNER = {
    first: "Ödön",
    last: "Anonimizált",
    slug: "anonimizalt-odon-scrubbed",
  };

  const clean = (s) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "");

  /** Escape a string for use inside a RegExp. */
  const rx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const ownerSlug = (() => {
    const m = /^\/in\/([^/]+)/.exec(location.pathname);
    return m ? decodeURIComponent(m[1]) : null;
  })();

  const fold = (s) =>
    String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");

  /**
   * A placeholder slug that MIRRORS THE SHAPE of the real one.
   *
   * A flat `anonimizalt-odon-scrubbed` for every profile made a whole class of bug
   * unreproducible, and this is not hypothetical: /in/mgoldberger — one token,
   * first-initial plus surname — broke the name validator, and a snapshot of that
   * page came back with a three-token hyphenated slug that the validator handles
   * perfectly. The reproducer was scrubbed away along with the identity.
   *
   * The IDENTITY is still fully replaced. What survives is only structure: how
   * many tokens, whether the first is an initial, whether there is a trailing
   * disambiguator and how long it is. None of that is personal data, and all of it
   * is what the validator is tested against.
   */
  const shapedSlug = (real) => {
    const first = fold(OWNER.first);
    const last = fold(OWNER.last);
    if (!real) return OWNER.slug;

    const parts = String(real).toLowerCase().split("-").filter(Boolean);
    // A trailing ID-shaped token is LinkedIn's disambiguator; keep its length.
    const tail = parts.length > 1 ? parts[parts.length - 1] : null;
    const hasId = !!tail && /^[a-z0-9]{4,12}$/.test(tail) && /\d/.test(tail);
    const body = hasId ? parts.slice(0, -1) : parts;
    const idFor = (len) => "1a2b3c4d5e6f".slice(0, Math.max(4, Math.min(12, len)));

    let base;
    if (body.length === 1) {
      const one = body[0];
      // Initial + surname, e.g. "mgoldberger" — the shape that broke the
      // validator. Detected as "one token whose tail is much longer than its head".
      if (one.length >= 5 && one.length <= 24) {
        base = `${first.slice(0, 1)}${last}`;
      } else {
        base = `${first}${last}`;
      }
    } else if (body.length === 2) {
      base = `${first}-${last}`;
    } else {
      // Three or more: keep the count with a stable middle filler.
      const middle = Array.from({ length: body.length - 2 }, (_, i) => `kozepso${i > 0 ? i + 1 : ""}`);
      base = [first, ...middle, last].join("-");
    }
    return hasId ? `${base}-${idFor(tail.length)}` : base;
  };

  /** The slug this snapshot will use — same shape as the real one, no identity. */
  const placeholderSlug = shapedSlug(ownerSlug);

  // ---- who is on this page ------------------------------------------------
  // Every /in/ anchor is a person. The owner's own slug identifies them; every
  // other slug is somebody else, and the anchor's text is their name.
  const others = new Map(); // name -> placeholder
  const otherSlugs = new Map(); // slug -> placeholder-slug
  let n = 0;

  for (const a of document.querySelectorAll('a[href*="/in/"]')) {
    let slug = null;
    try {
      const u = new URL(a.getAttribute("href"), location.href);
      if (!/(^|\.)linkedin\.com$/i.test(u.hostname)) continue;
      const m = /^\/in\/([^/]+)/.exec(u.pathname);
      if (!m) continue;
      slug = decodeURIComponent(m[1]);
    } catch {
      continue;
    }
    if (!slug || (ownerSlug && slug === ownerSlug)) continue;

    if (!otherSlugs.has(slug)) {
      n += 1;
      otherSlugs.set(slug, `person-${n}-fixture`);
    }
    const placeholder = `Person ${otherSlugs.get(slug).match(/person-(\d+)/)[1]}`;

    // The anchor's visible text is the person's name — sometimes with a
    // credential suffix ("Keletso Thophego, CFP") and sometimes doubled for
    // screen readers. Take every distinct line inside it.
    for (const node of [a, ...a.querySelectorAll("span, div, p")]) {
      const t = clean(node.textContent);
      // Two words minimum, not a sentence, not chrome.
      if (!t || t.length < 4 || t.length > 80) continue;
      if (!/^[^\d]{4,80}$/.test(t)) continue;
      if (!/\s/.test(t)) continue;
      if (!others.has(t)) others.set(t, placeholder);
    }
  }

  // ---- the owner, from the title and the card ----------------------------
  const ownerNames = new Set();
  const titleName = clean(document.title).replace(/\s*[|(].*$/, "").replace(/\s*[-–—]\s*LinkedIn.*$/i, "");
  if (titleName && titleName.length >= 3) ownerNames.add(titleName);
  if (ownerSlug) {
    // "anna-kovacs-1a2b3c" -> "Anna Kovacs", to catch the card rendering.
    const fromSlug = ownerSlug
      .split("-")
      .filter((p) => p.length > 1 && !/^[0-9a-f]{4,}$/i.test(p))
      .map((p) => p[0].toUpperCase() + p.slice(1))
      .join(" ");
    if (fromSlug.length >= 3) ownerNames.add(fromSlug);
  }

  // ---- serialize, then scrub the STRING ----------------------------------
  let html = document.documentElement.outerHTML;

  // 1. Empty every script/code/noscript body. LinkedIn's hidden <code> blocks
  //    hold the whole profile as JSON — the single largest privacy leak and the
  //    single largest size win.
  html = html
    .replace(/(<script\b[^>]*>)[\s\S]*?(<\/script>)/gi, "$1$2")
    .replace(/(<code\b[^>]*>)[\s\S]*?(<\/code>)/gi, "$1$2")
    .replace(/(<noscript\b[^>]*>)[\s\S]*?(<\/noscript>)/gi, "$1$2")
    .replace(/(<style\b[^>]*>)[\s\S]*?(<\/style>)/gi, "$1$2");

  // 2. Other people: longest names first, so "Keletso Thophego, CFP" is
  //    replaced before "Keletso Thophego" leaves a dangling ", CFP".
  for (const [name, placeholder] of [...others.entries()].sort((a, b) => b[0].length - a[0].length)) {
    html = html.replace(new RegExp(rx(name), "g"), placeholder);
  }
  for (const [slug, placeholder] of otherSlugs) {
    html = html.replace(new RegExp(rx(slug), "g"), placeholder);
  }

  // 3. The owner — consistently, so title/slug/card still agree.
  for (const name of [...ownerNames].sort((a, b) => b.length - a.length)) {
    const parts = name.split(/\s+/);
    html = html.replace(new RegExp(rx(name), "g"), `${OWNER.last} ${OWNER.first}`);
    // Also the parts alone, which appear in aria-labels ("Anna's profile").
    for (const p of parts) {
      if (p.length >= 4) html = html.replace(new RegExp(`\\b${rx(p)}\\b`, "g"), OWNER.first);
    }
  }
  if (ownerSlug) html = html.replace(new RegExp(rx(ownerSlug), "g"), placeholderSlug);

  // 4. Signed URLs and opaque tokens. The licdn query string is the signature
  //    that expires; the path shape is what the photo picker is tested against.
  html = html
    .replace(/(https:\/\/media\.licdn\.com\/[^"'\s?]+)\?[^"'\s]*/g, "$1?scrubbed=1")
    .replace(/([?&](?:trk|trackingId|miniProfileUrn|lipi|licu|csrfToken|e|v|t)=)[^"'&\s]+/g, "$1SCRUBBED")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "SCRUBBED_TOKEN");

  // 5. Any contact detail that survived in prose.
  html = html
    .replace(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, "person@example.test")
    .replace(/(?:\+|\b00)\d[\d\s\-().]{7,17}\d/g, "+36 1 234 5678");

  return {
    snapshotVersion: 1,
    // Deliberately the scrubbed slug: the fixture's URL must match its content.
    url: `https://www.linkedin.com/in/${placeholderSlug}/`,
    // Reported so a committed fixture records what shape it is reproducing.
    slugShape: { real: ownerSlug ? ownerSlug.split("-").length : 0, placeholder: placeholderSlug },
    scrubbed: {
      otherPeople: others.size,
      otherSlugs: otherSlugs.size,
      ownerAliases: ownerNames.size,
    },
    bytes: html.length,
    html,
  };
})();
