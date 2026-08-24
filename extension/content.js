/**
 * Venture OS capture — content script.
 *
 * READS the page the user is already viewing and returns what it finds. It is
 * injected on demand, never persistently, and it does one thing: read. No
 * network call, no scrolling, no pagination, and nothing runs unless a human
 * pressed a button.
 *
 * On clicking: THIS FILE never clicks. Opening the contact-info overlay is a
 * separate, separately-injected script (contact.js) that runs only on an
 * explicit capture, one profile at a time. Keeping the two apart is what makes
 * "this file cannot act" a structural fact rather than a promise in a comment.
 *
 * ── WHY THIS IS SHAPED THE WAY IT IS ────────────────────────────────────────
 *
 * The page it has to read has no <h1>, no id anchors (#about, #experience), and
 * hashed class names that change without notice. So there is nothing to select
 * BY. Everything below follows from that:
 *
 *   IDENTITY, NOT POSITION. The one reliable fact on a profile is the owner's
 *   own slug in the URL. Their name, their photo and their card are all reachable
 *   from the anchors that point at it, and — the important half — every anchor
 *   pointing at a DIFFERENT slug is a different human.
 *
 *   A BOUNDED CARD, ASSERTED. The reader used to pick the top card by walking up
 *   until an ancestor "looked big enough", and on the real page that ancestor had
 *   swallowed the right-hand rail: 36 list items, 11 nested sections, thirty
 *   strangers. It captured a connection's name as the lead's headline and another
 *   stranger — "Keletso Thophego, CFP" — as the lead's city. The card is now
 *   chosen by a test it must PASS: after negative space is pruned, the container
 *   may contain exactly one profile identity, the owner's. If no container
 *   passes, extraction returns the name and nothing else. It never widens.
 *
 *   EMPTY BEATS WRONG. Every field is validated before it is offered, every
 *   field carries where it came from, and every rejection carries a reason the
 *   UI shows. A blank headline costs five seconds of typing; a stranger's name in
 *   the headline looks like data, gets filtered on, reaches a quote, and nobody
 *   re-checks a field that is already filled in.
 */
(() => {
  // ---- small helpers ------------------------------------------------------
  const clean = (v) => {
    if (typeof v !== "string") return null;
    /**
     * Zero-width characters go first.
     *
     * LinkedIn company names carry them — "'Seyu - Together for victory!'\u200b"
     * ends in a zero-width space — and they survive every trim, so the value
     * stored differs invisibly from the one a human would type. That is a
     * duplicate company waiting to happen.
     */
    const t = v
      .replace(/[\u200b-\u200f\u2060\ufeff]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    return t.length === 0 ? null : t;
  };

  /** Run a step; a broken one costs its own fields and nothing else. */
  const attempt = (fallback, fn) => {
    try {
      const v = fn();
      return v === undefined || v === null ? fallback : v;
    } catch {
      return fallback;
    }
  };
  const $ = (sel, root) => attempt(null, () => (root ?? document).querySelector(sel));
  const $$ = (sel, root) => attempt([], () => [...(root ?? document).querySelectorAll(sel)]);

  /** Accent- and case-insensitive comparison key. */
  const norm = (s) =>
    (s ?? "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();

  /** Significant word tokens, for order-insensitive name comparison. */
  const tokens = (s) =>
    new Set(
      norm(s)
        .split(/[^\p{L}\p{N}]+/u)
        .filter((t) => t.length >= 3),
    );

  /**
   * A label said once. LinkedIn renders most text twice — once for sight, once
   * for screen readers — so raw textContent gives "AboutAbout".
   */
  const once = (raw) => {
    const t = clean(raw);
    if (!t) return null;
    const half = t.slice(0, t.length / 2);
    return half.length > 0 && half + half === t ? half : t;
  };
  const label = (el) => once(el ? el.textContent : null);

  /**
   * The shared selector layer, if it was injected. Declared HERE, above every
   * use: as a `const` further down the file it sat in its own temporal dead zone
   * for the whole of the card walk, so touching it there threw a ReferenceError
   * that `attempt()` swallowed into "extraction_threw" — a total extraction
   * failure reported as a generic one.
   */
  const S = globalThis.VentureSelectors ?? null;

  // ---- negative space -----------------------------------------------------
  /**
   * Subtrees that are never about the person whose profile this is.
   *
   * LinkedIn fills the margins with other people — suggestions, "also viewed",
   * promoted content — and renders them in the SAME container as the profile,
   * often BEFORE it in source order because the column is positioned with CSS.
   * That is the entire mechanism behind the reported bug: read in DOM order
   * without excluding these, and the first thing you find is a stranger.
   *
   * Matched on the heading text because that is what LinkedIn cannot obfuscate:
   * a hashed class name is invisible to a screen reader, so the human-readable
   * heading has to stay.
   */
  const NEGATIVE_SPACE_HEADINGS = [
    "people you may know",
    "more profiles for you",
    "suggested for you",
    "who your viewers also viewed",
    "people also viewed",
    "you might like",
    "more suggestions for you",
    "analytics",
    "promoted",
    "ad",
    "advertisement",
    // Hungarian interface
    "akiket ismerhetsz",
    "további profilok",
    "hirdetés",
    "elemzések",
  ];

  const isNegativeHeading = (t) => {
    const k = norm(t);
    return !!k && NEGATIVE_SPACE_HEADINGS.some((h) => k === h || k.startsWith(`${h} `));
  };

  /**
   * Overlay and dialog subtrees — the OTHER kind of negative space.
   *
   * Measured, not guessed: in the second real fixture there are five distinct
   * /in/ slugs inside these subtrees — the owner plus `person-1-fixture`,
   * `person-2-fixture`, `dávid-bózsik`, `beáta-ferenczi-3802a22b0` — and that is
   * exactly the reported `identitiesInCard: 5`. The first fixture has none inside
   * them and passes the boundary test with one identity. So the boundary walk was
   * counting people who are in a closed dialog, not on the card.
   *
   * `inert` is here for the same reason: it marks a subtree the user cannot
   * interact with, and LinkedIn sets it on overlays that are mounted but shut. On
   * the second fixture `[popover]`, `[role="dialog"]`, `[data-testid=
   * "popover-floating"]` and `[inert]` are all the same two nodes, and those two
   * nodes hold all five identities.
   *
   * `[aria-hidden="true"]` IS DELIBERATELY NOT HERE, against the brief's list.
   * Measured across all four fixtures it contributes ZERO identities while
   * wrapping a great deal of real text — 294 nodes in one real fixture, and 1977
   * characters of the profile's own content in the synthetic one. On this page
   * aria-hidden marks the screen-reader COPY of visible content, not an overlay,
   * so excluding it buys nothing and risks deleting the page. (This codebase has
   * already been bitten from the other direction, by a reader that saw only the
   * aria-hidden copies.) A dialog that is only marked aria-hidden is still caught
   * by `[role="dialog"]`.
   */
  const OVERLAY_SUBTREE =
    '[popover],[role="dialog"],[data-testid="dialog"],[data-testid="dialog-content"],' +
    '[data-testid="popover-floating"],[inert]';

  /** Does this element sit inside a dialog/overlay subtree? */
  const isInsideOverlay = (el) =>
    attempt(false, () => !!el?.closest?.(OVERLAY_SUBTREE));

  /** Is this element itself the root of one? */
  const isOverlayRoot = (el) => attempt(false, () => !!el?.matches?.(OVERLAY_SUBTREE));

  // ---- who this page is about --------------------------------------------
  const slugFromUrl = attempt(null, () => {
    const m = /^\/in\/([^/]+)/.exec(window.location.pathname);
    return m ? decodeURIComponent(m[1]).toLowerCase() : null;
  });

  /**
   * THE PRECONDITION. Extraction may only run on a canonical profile route.
   *
   * A capture was observed running at
   * `https://www.linkedin.com/in/<id>/overlay/<id>/` — an overlay route it had
   * navigated to and never left. Reading a profile from there produces a top card
   * that is absent, a boundary walk over dialog content, and a page title that
   * names the overlay instead of the person: the reported `topcard:absent`,
   * `identitiesInCard: 5` and `name_disagrees_with_page_title` are all one bug
   * seen from three sides.
   *
   * So this refuses rather than degrades. Returning to the canonical URL is the
   * machine's job (prepare.js); this file's job is to make "extracted from the
   * wrong route" impossible even if that fails. Sales Navigator lead pages are
   * their own canonical shape and are allowed through.
   */
  const CANONICAL_PROFILE = /^\/in\/[^/]+\/?$/;
  const SALES_LEAD = /^\/sales\/(lead|people)\//i;
  const routeCheck = attempt({ ok: false, reason: "route_check_threw" }, () => {
    const path = window.location.pathname ?? "";
    if (CANONICAL_PROFILE.test(path)) return { ok: true, reason: null, kind: "profile" };
    if (SALES_LEAD.test(path)) return { ok: true, reason: null, kind: "sales" };
    if (/\/overlay\//.test(path)) {
      return { ok: false, reason: "on_an_overlay_route", kind: "overlay" };
    }
    if (/^\/in\/[^/]+\/./.test(path)) {
      return { ok: false, reason: "on_a_profile_sub_route", kind: "sub-route" };
    }
    return { ok: false, reason: "not_a_profile_route", kind: "other" };
  });

  if (!routeCheck.ok) {
    // Nothing is read. Not one field, not the name, not the photo — every one of
    // them would be sourced from a page that is not this person's profile.
    return {
      url: canonicalProfileUrl(),
      refused: true,
      route: routeCheck,
      posts: [],
      provenance: {},
      skipped: { _all: routeCheck.reason },
      flags: ["refused_non_canonical_route"],
      boundary: {
        ok: false,
        reason: routeCheck.reason,
        identitiesInCard: null,
        excludedNegativeSpaceNodes: 0,
        otherPeopleOnPage: 0,
        contactTriggerPresent: false,
      },
      _from: {},
      _attempts: {},
    };
  }

  /** Every /in/ anchor on the page, with the slug it points at. */
  const profileAnchors = attempt([], () =>
    $$('a[href*="/in/"]')
      .map((a) => {
        let slug = null;
        try {
          const u = new URL(a.getAttribute("href"), window.location.href);
          if (!/(^|\.)linkedin\.com$/i.test(u.hostname)) return null;
          const m = /^\/in\/([^/]+)/.exec(u.pathname);
          slug = m ? decodeURIComponent(m[1]).toLowerCase() : null;
        } catch {
          return null;
        }
        return slug ? { el: a, slug } : null;
      })
      .filter(Boolean),
  );

  /**
   * Whose profile this is.
   *
   * Normally the URL says so. A Sales Navigator lead page does not — its path is
   * /sales/lead/<opaque-id> — and without an owner slug the entire bounded-card
   * algorithm has nothing to anchor on, so extraction would degrade to name-only
   * on every Sales Navigator page.
   *
   * The fallback is the same single-identity principle used everywhere else: if
   * every /in/ anchor on the page points at ONE slug, that is unambiguously
   * whose page this is. Two or more distinct slugs and we decline to guess,
   * because guessing which of several people a page is about is exactly the
   * class of mistake that put a stranger's name in a lead's city.
   */
  const distinctSlugs = [...new Set(profileAnchors.map((a) => a.slug))];
  const ownerSlug = slugFromUrl ?? (distinctSlugs.length === 1 ? distinctSlugs[0] : null);

  const ownerAnchors = profileAnchors.filter((a) => a.slug === ownerSlug);

  /**
   * Every other person's name on the page — the cross-contamination blocklist.
   *
   * No field may equal or contain one of these. It is the check that would have
   * caught both halves of the reported bug on its own, before any reasoning
   * about layout.
   */
  const otherPeople = attempt([], () => {
    const names = new Set();
    for (const { el, slug } of profileAnchors) {
      if (slug === ownerSlug) continue;
      for (const node of [el, ...$$("span, div, p", el)]) {
        const t = once(node.textContent);
        if (!t || t.length < 4 || t.length > 80) continue;
        if (!/\s/.test(t)) continue; // a single word is not a full name
        names.add(t);
      }
    }
    return [...names];
  });

  const otherPeopleKeys = otherPeople.map(norm).filter((k) => k.length >= 4);

  /**
   * Does this value contain, or sit inside, somebody else's name?
   *
   * For IDENTITY fields — name, headline, location, company, job title — where any
   * appearance of a stranger's name means the value is contaminated.
   */
  const isSomeoneElse = (value) => {
    const k = norm(value);
    if (!k) return false;
    return otherPeopleKeys.some((other) => k === other || k.includes(other) || other.includes(k));
  };

  /**
   * The same question for FREE TEXT — a bio, a post.
   *
   * Equality only, and this distinction is load-bearing. A LinkedIn post mentions
   * other people; that is most of what posts are for. The containment test
   * therefore rejected every post on the real fixture — 1668 characters of the
   * person's own writing discarded because a commenter's name appeared somewhere
   * inside it — and `postsRead: 0` looked like the activity section being
   * unreadable rather than the guard being too wide.
   *
   * The guard's purpose is to stop a stranger's name becoming this lead's OWN
   * field. A bio that mentions a colleague is still the bio.
   */
  const isEntirelySomeoneElse = (value) => {
    const k = norm(value);
    if (!k) return false;
    return otherPeopleKeys.some((other) => k === other);
  };

  // ---- the bounded top card ----------------------------------------------
  /** Should this subtree be pruned before reading? */
  const isNegativeSpace = (el, keep) => {
    if (!el || !el.tagName) return false;
    // Never prune a subtree containing the owner's own anchor.
    if (keep && el.contains(keep)) return false;
    if (el.tagName === "ASIDE") return true;
    // A dialog or overlay subtree. Checked before the heading scan because an
    // overlay has its own headings and none of them are this page's sections.
    if (isOverlayRoot(el)) return true;
    for (const h of $$("h1, h2, h3", el)) {
      if (isNegativeHeading(label(h))) return true;
    }
    return false;
  };

  /** Walk a container, skipping negative space; report what was skipped. */
  const walkPruned = (root, keep) => {
    const out = { elements: [], excluded: 0 };
    if (!root) return out;
    const visit = (el) => {
      if (isNegativeSpace(el, keep)) {
        out.excluded += 1;
        return;
      }
      out.elements.push(el);
      for (const child of el.children) visit(child);
    };
    visit(root);
    return out;
  };

  /** Distinct visible lines of a pruned container, in document order. */
  const prunedLines = (root, keep) => {
    const { elements, excluded } = walkPruned(root, keep);
    const seen = new Set();
    const lines = [];
    for (const el of elements) {
      if (!/^(P|SPAN|DIV|LI|H1|H2|H3|A|BUTTON)$/.test(el.tagName)) continue;
      const t = once(el.textContent);
      if (!t || seen.has(t)) continue;
      seen.add(t);
      lines.push(t);
    }
    // A container's text is its children's concatenated, so drop any line that
    // merely contains another — otherwise the whole card reads as one line.
    //
    // Punctuation goes FIRST, and only substantial lines can eliminate another.
    // LinkedIn renders the separator between the location and the Contact-info
    // link as its own element, so "·" is a line — and "·" is a substring of
    // "Gyártásvezető · Kecskemét", which is how the containment pass silently
    // deleted a perfectly good headline. A one-character line cannot be evidence
    // that a longer line is an aggregate of its children.
    const meaningful = lines.filter((l) => l.length > 1 && !/^[·•|,;:\-–—\s]+$/.test(l));
    /**
     * An aggregate contains TWO other lines. One is a coincidence.
     *
     * The rule used to drop any line containing any other, and that is what
     * silently deleted the headline on the post-RSC page. The card renders the
     * current company as its own chip, so
     *
     *     "Partner & Head of Business Development at JeansDay Marketing"
     *
     * contains "JeansDay Marketing" — and every headline of the form
     * "<role> at <company>" does, whenever the company is also a chip. The line
     * was thrown away as though it were a container's concatenated text, the top
     * card was left with three chips and no headline, and the validator then
     * rejected each chip in turn: the location for reading as a location, the
     * company and the school for having no headline signal. That is the whole of
     * the reported "the headline could not be read".
     *
     * A container's text really is its children's, so it contains SEVERAL of
     * them — the glued name+degree+headline line here contains five. Counting
     * rather than testing keeps the aggregates out and lets the headline
     * through, and every line in the recorded fixture lands on the correct side.
     */
    const containsOthers = (l) =>
      meaningful.filter((o) => o !== l && o.length >= 4 && l.includes(o)).length;
    return {
      lines: meaningful.filter((l) => containsOthers(l) < 2),
      excluded,
    };
  };

  /**
   * Identities reachable inside a pruned container.
   *
   * Overlay anchors are excluded a second time here, independently of the walk.
   * Belt and braces on purpose: this count is what decides whether extraction is
   * allowed to proceed at all, and a single missed exclusion turns into fields
   * read off a stranger in a dialog.
   */
  const prunedIdentities = (root, keep) => {
    const { elements } = walkPruned(root, keep);
    const set = new Set(elements);
    const ids = new Set();
    for (const { el, slug } of profileAnchors) {
      if (!set.has(el)) continue;
      if (isInsideOverlay(el)) continue;
      ids.add(slug);
    }
    return ids;
  };

  /**
   * Find the container that is the person's own card, or fail.
   *
   * Starts from an anchor pointing at the owner's slug that also holds an <img>
   * — the profile photo, the most reliable landmark on the page — and walks up
   * to the first ancestor that, after pruning, holds enough lines to be a card.
   * That ancestor then has to PASS the boundary test: exactly one identity, the
   * owner's. Walking further up can only add identities, so a failure is final.
   */
  const card = attempt({ el: null, ok: false, reason: "extraction_threw" }, () => {
    if (!ownerSlug) return { el: null, ok: false, reason: "no_profile_slug_in_url" };
    if (ownerAnchors.length === 0) return { el: null, ok: false, reason: "no_anchor_to_this_profile" };

    const scope = $("main") || $('[role="main"]') || document.body;
    /**
     * Never START from an anchor inside a dialog.
     *
     * `keep` deliberately protects the subtree holding the start anchor from
     * pruning — otherwise the walk would delete the card it is trying to read. So
     * an anchor inside an overlay would protect that overlay from being pruned
     * and reintroduce every identity in it. The owner has 74-76 anchors on a real
     * page; excluding the ones in dialogs costs nothing.
     */
    const onPage = ownerAnchors.filter((a) => !isInsideOverlay(a.el));
    const usable = onPage.length > 0 ? onPage : ownerAnchors;
    const withImg = usable.filter((a) => $("img", a.el));

    /**
     * THE COMPONENTKEY'D TOP-CARD ANCHOR GOES FIRST.
     *
     * Document order is not card order. The owner has 90 anchors to their own
     * slug and 16 of them hold an image, and the first in document order is in the
     * sticky header — a four-line container reading "Anonimizált Ödön / CEO at
     * Seyu / More / Message". It passes the boundary test perfectly well, so the
     * walk accepted it and stopped, and `location` reported `topcard:absent` while
     * "Budapest, Hungary" sat in the real top card further down the document.
     *
     * `topcard-logo-image-referencekey` is LinkedIn's own identifier for the real
     * one — the same tier-1 selector the photo already uses — so it is tried
     * before anything found by position.
     */
    const keyed = attempt(null, () => (S ? S.topcardPhotoAnchor(document) : null));
    const keyedFirst = keyed ? usable.filter((a) => a.el === keyed || keyed.contains(a.el)) : [];
    const starts = [
      ...keyedFirst,
      ...(keyed ? [{ el: keyed, slug: ownerSlug }] : []),
      ...withImg,
      ...usable,
    ];

    /**
     * Headings that mean we have walked out of the top card and into the page.
     *
     * The expansion below needs a ceiling, and this is it: the top card is
     * everything above the first real section. Growing past About or Activity
     * would also break `sections`, which excludes anything the card contains.
     */
    const SECTION_HEADINGS =
      /^(about|nevjegy|info|featured|kiemelt|activity|aktivitas|experience|tapasztalat|education|tanulmany|skills|kepessegek|recommendations|interests)/;
    const reachesIntoSections = (el) =>
      $$("h1, h2, h3", el).some((h) => SECTION_HEADINGS.test(norm(label(h))));

    for (const start of starts) {
      let node = start.el.parentElement;
      /**
       * TAKE THE LARGEST CONTAINER THAT STILL PASSES, not the first.
       *
       * Stopping at the first container with three lines was measurably too
       * eager: on the real fixture that container held the name, the connection
       * degree and the headline, so `location` reported `topcard:absent` while
       * "Budapest, Hungary" sat one level up. Expanding costs nothing in safety —
       * every candidate has to pass the SAME boundary test, and the walk stops the
       * moment a second identity appears or a page section comes into view. Which
       * is also why widening can never reach the right-hand rail: the rail is full
       * of other people, so the identity count rises and the walk stops.
       */
      let best = null;
      for (let depth = 0; node && depth < 10; depth += 1) {
        if (node === scope || node === document.body || node === document.documentElement) break;
        const { lines, excluded } = prunedLines(node, start.el);
        // A card is a name, a headline and at least one more line.
        if (lines.length >= 3) {
          const ids = prunedIdentities(node, start.el);
          if (ids.size !== 1 || !ids.has(ownerSlug)) {
            // A second identity. If a smaller container already passed, that one
            // stands; otherwise this is a genuine boundary failure.
            if (best) break;
            return {
              el: null,
              ok: false,
              reason: "card_contains_more_than_one_identity",
              identities: ids.size,
              excluded,
            };
          }
          if (reachesIntoSections(node)) break;
          best = { el: node, ok: true, reason: null, lines, excluded, anchor: start.el, depth };
        }
        node = node.parentElement;
      }
      if (best) return best;
    }
    return { el: null, ok: false, reason: "no_container_passed_the_boundary_test" };
  });

  // ---- provenance ---------------------------------------------------------
  /** field -> {value, source, confidence}; rejections -> field -> reason. */
  const fields = {};
  const skipped = {};
  const attempts = {};

  const note = (field, strategy, outcome) => {
    (attempts[field] ??= []).push(`${strategy}:${outcome}`);
  };

  /**
   * Offer a value for a field. `validate` returns null to accept or a reason
   * code to reject. Nothing reaches `fields` without passing.
   */
  const offer = (field, source, confidence, raw, validate) => {
    if (fields[field]) return false;
    const value = clean(raw);
    if (!value) {
      note(field, source, "absent");
      return false;
    }
    const reason = validate ? validate(value) : null;
    if (reason) {
      note(field, source, `rejected(${reason})`);
      skipped[field] = reason;
      return false;
    }
    note(field, source, "accepted");
    /**
     * `via: "dom"` on EVERY field this file produces.
     *
     * The DOM extractor is now the FALLBACK, not the primary path. It runs when
     * passive observation produced nothing for a field, and the lead has to show
     * which of the two answered — a field read off the rendering is a weaker fact
     * than the same field read out of the response the page was rendered from, and
     * an operator deciding whether to trust a value deserves to know which they
     * are looking at.
     *
     * This file is deliberately KEPT rather than deleted: when LinkedIn changes
     * its response schema, this is what keeps the feature alive while the
     * snapshots are re-recorded.
     */
    fields[field] = { value, source, confidence, via: "dom" };
    delete skipped[field];
    return true;
  };

  // ---- name ---------------------------------------------------------------
  // No <h1> exists, so the name comes from the page title, cross-checked against
  // the URL slug and the card. The slug is the only part of a profile page that
  // cannot be wrong about whose profile it is.
  const titleName = attempt(null, () =>
    clean(
      (document.title ?? "")
        .replace(/\s*\|\s*LinkedIn\s*$/i, "")
        .replace(/\s*\(\d+\)\s*/, " ")
        .split(/\s+[|]\s+/)[0],
    ),
  );
  /**
   * Name agreement lives in names.js, which is injected alongside this file.
   *
   * It is a separate module because the comparison is subtle enough to need its
   * own test table — accent folding, Hungarian name order, LinkedIn's truncation
   * and its ID suffixes — and because getting it wrong is silent in both
   * directions. The fallback below keeps this file working if that injection ever
   * fails, at the cost of the accent handling.
   */
  const NM = globalThis.VentureNames ?? null;

  /**
   * Clean a raw candidate before it is judged.
   *
   * MEASURED ON THE FIXTURES: the top-card anchor's textContent is the name with
   * the headline glued straight onto it — "Anonimizált ÖdönCEO at Seyu", no
   * separator anywhere in the DOM — and in the other fixture with the connection
   * degree wedged in the middle: "Anonimizált Ödön• 1st • CEO at Seyu". The old
   * validator accepted both, so the lead's NAME was the name plus the headline.
   * There is nothing to split on, but the page title says where the name ends.
   */
  const nameCandidate = (raw) => {
    const value = clean(raw);
    if (!value) return null;
    if (NM) return NM.trimToTitleName(value, document.title ?? "");
    return value;
  };

  /**
   * A name must agree with the title AND the slug.
   *
   * Compared as token SETS, accent-folded: Hungarian puts the family name first,
   * so a card reading "Tóth-Szűcs Örs Ábel" against a title of "Örs Ábel
   * Tóth-Szűcs" is the same person, and the slug is always the folded ASCII form.
   */
  const validateName = (value) => {
    if (value.length < 2 || value.length > 120) return "name_length_implausible";
    if (isSomeoneElse(value)) return "name_matches_another_person_on_page";

    if (NM) {
      if (NM.nameTokens(value).length === 0) return "name_has_no_comparable_tokens";
      // Only when there is no title to trim against — with one, the candidate has
      // already been shortened to it, and a real name may carry a capital inside.
      if (!NM.nameFromTitle(document.title ?? "") && NM.looksGlued(value)) {
        return "name_has_text_glued_onto_it";
      }
      const byTitle = NM.nameAgreesWithTitle(value, document.title ?? "");
      if (!byTitle.ok) return byTitle.why;
      if (ownerSlug) {
        // The title travels with it: one of the acceptance rules is "the slug
        // carries the surname AND the title names this person exactly", which is
        // two independent agreements rather than a looser single one.
        const bySlug = NM.nameAgreesWithSlug(value, ownerSlug, { title: document.title ?? "" });
        if (!bySlug.ok) return bySlug.why;
      }
      return null;
    }

    // FALLBACK — names.js failed to inject. Token overlap without the accent
    // folding or the suffix handling, which is worse but not nothing.
    const v = tokens(value);
    if (v.size === 0) return "name_has_no_comparable_tokens";
    const t = tokens(titleName ?? "");
    if (t.size > 0 && [...v].every((x) => !t.has(x))) return "name_disagrees_with_page_title";
    const st = tokens((ownerSlug ?? "").replace(/-/g, " "));
    if (st.size > 0 && [...v].every((x) => !st.has(x))) return "name_disagrees_with_profile_url";
    return null;
  };

  const cardNameEl = card.ok ? card.anchor : null;
  offer("name", "topcard", "high", nameCandidate(cardNameEl ? label(cardNameEl) : null), validateName);
  // The anchor holding the photo has no text; the sibling anchor to the same
  // slug does.
  if (!fields.name && card.ok) {
    for (const a of ownerAnchors) {
      if (!card.el.contains(a.el)) continue;
      if (offer("name", "topcard", "high", nameCandidate(label(a.el)), validateName)) break;
    }
  }
  /**
   * The bounded card's FIRST LINE.
   *
   * On the real page the name is not in an anchor at all — it is a `<p>` — so the
   * anchor attempts all come back absent and the name used to fall through to the
   * page title at medium confidence. The card's first line is the name by
   * construction (the card is ordered name, headline, location), and it still has
   * to pass the same validator, so this costs nothing in safety and keeps a
   * correct name at the confidence it deserves.
   */
  if (!fields.name && card.ok) {
    for (const line of (card.lines ?? []).slice(0, 3)) {
      if (offer("name", "topcard", "high", nameCandidate(line), validateName)) break;
    }
  }
  offer("name", "title", "medium", titleName, validateName);

  // ---- the card's own lines ----------------------------------------------
  // Read by DOM ORDER inside the bounded card: the name, then the headline,
  // then the location, then the connection count. Chrome is dropped by role
  // rather than by class.
  const CHROME =
    /^(contact info|kapcsolati adatok|kapcsolatfelvétel|message|üzenet|connect|kapcsolódás|follow|követés|following|more|továbbiak|show all|see all|összes|pending|invitation sent|open to|nyitott|add profile section|enhance profile|premium|talks about|mutual connection|see contact info)/i;
  const isChrome = (l) =>
    CHROME.test(l) ||
    /\b[\d\s,.]+\+?\s*(connections?|followers?|követő|kapcsolat|ismerős)\b/i.test(l) ||
    /^[·•]?\s*\d+(st|nd|rd|th)\b/i.test(l) ||
    /^[·•]\s*\d/.test(l) ||
    /^[·•|,\s]+$/.test(l) ||
    l.length <= 1;

  const cardLines = card.ok
    ? card.lines.filter((l) => l !== fields.name?.value && !isChrome(l) && !isSomeoneElse(l))
    : [];

  // ---- location, validator first -----------------------------------------
  // Declared ABOVE the headline because the headline validator CALLS it: a line
  // with no headline signal that reads as a place is a place, and that is the
  // check "San Francisco Bay Area" needed. As a `const` below, it sat in its own
  // temporal dead zone at the moment the headline was offered.
  // ---- location -----------------------------------------------------------
  // Shape and page-context checks happen here; whether the place RESOLVES is
  // decided server-side against the one authoritative gazetteer, which would
  // drift if it were copied into an injected script.
  const anchorTexts = attempt(new Set(), () => {
    const s = new Set();
    for (const { el } of profileAnchors) {
      const t = once(el.textContent);
      if (t) s.add(norm(t));
    }
    return s;
  });

  const validateLocation = (value) => {
    if (value.length < 2 || value.length > 120) return "location_length_implausible";
    if (isSomeoneElse(value)) return "location_matches_another_person_on_page";
    if (anchorTexts.has(norm(value))) return "location_is_a_profile_link_text";
    if (/[@]/.test(value)) return "location_contains_an_at_sign";
    if (!LOCATION_SHAPE.test(value) && !/^[\p{L}\s.'’-]{2,60}$/u.test(value)) {
      return "location_does_not_read_as_a_place";
    }
    // "Keletso Thophego, CFP": a short capitalised tail is a credential, not a
    // country. This is the check whose absence put a stranger in the city field.
    const parts = value.split(",").map((p) => p.trim());
    if (parts.length >= 2) {
      const tail = parts[parts.length - 1];
      if (tail.length <= 6 && /^[\p{Lu}][\p{L}.]*$/u.test(tail) && tail === tail.toUpperCase()) {
        return "location_tail_reads_as_a_credential";
      }
    }
    return null;
  };


  // ---- headline -----------------------------------------------------------
  const LOCATION_SHAPE = /^[\p{L}\s.'’-]+(,\s*[\p{L}\s.'’-]+){1,2}$/u;

  /**
   * What makes a line read as a headline rather than as some other fact.
   *
   * A LinkedIn headline is nearly always either punctuated — "VP Sales @ Metaview
   * | Startup Advisor" — or names a role. A line with neither is something else
   * that happens to sit in the same card.
   */
  const HEADLINE_SEPARATOR = /[|@·•]|\s+at\s+|\s+@\s+/i;
  /**
   * Two halves, and the split matters.
   *
   * English role words are matched on WORD boundaries. Hungarian ones are matched
   * as SUFFIXES, because the language compounds them: "Gyártásvezető" is a role and
   * `\bvezető\b` cannot see it — the character before "vezető" is "s", so there is
   * no boundary there at all.
   */
  const ROLE_VOCABULARY_EN =
    /\b(ceo|cto|coo|cfo|cmo|cro|vp|svp|evp|head|director|manager|lead|leader|founder|co-?founder|owner|partner|president|chief|principal|engineer|developer|designer|consultant|advisor|adviser|specialist|analyst|architect|scientist|recruiter|marketer|strategist|investor)\b/i;
  const ROLE_VOCABULARY_HU =
    /(ügyvezető|vezető|igazgató|tanácsadó|fejlesztő|mérnök|tervező|értékesítő|szakértő|elemző|alapító|tulajdonos|munkatárs)/i;
  const ROLE_VOCABULARY = {
    test: (v) => ROLE_VOCABULARY_EN.test(v) || ROLE_VOCABULARY_HU.test(v),
  };
  const hasHeadlineSignal = (v) => HEADLINE_SEPARATOR.test(v) || ROLE_VOCABULARY.test(v);

  const validateHeadline = (value) => {
    if (value.length < 3 || value.length > 220) return "headline_length_implausible";
    if (isSomeoneElse(value)) return "headline_matches_another_person_on_page";

    /**
     * THE NAME MUST NEVER BECOME THE HEADLINE.
     *
     * On /in/mgoldberger it did, at confidence "high", and the form then rendered
     * that headline in the job-title slot — so the screenshot showed an empty Name
     * field with "Mark Goldberger" beside it. The mechanism was a cascade: the
     * name was rejected (item 1), so it was never excluded from the card's own
     * lines, so the first remaining line was the name.
     *
     * Checked three ways, because the name can reach here from three places: the
     * resolved field, the page title's name portion, and a fragment of either.
     */
    const nameValue = fields.name?.value ?? null;
    if (nameValue) {
      const n = norm(nameValue);
      const v = norm(value);
      if (v === n) return "headline_is_the_name";
      // A FRAGMENT of the name — "Mark" out of "Mark Goldberger" — is still the
      // name, not a headline. The other direction is fine: a headline may well
      // mention the person.
      if (n.includes(v)) return "headline_is_part_of_the_name";
    }
    if (NM && titleName && norm(value) === norm(titleName)) return "headline_is_the_page_title_name";

    // A bare "City, Country" is a location that drifted into the wrong slot.
    if (LOCATION_SHAPE.test(value) && value.split(",").length <= 3 && !/[@|·]/.test(value)) {
      return "headline_reads_as_a_location";
    }
    /**
     * "San Francisco Bay Area" — four capitalised words, no comma, so the shape
     * test above never fired and it was accepted as a headline. A line with no
     * headline signal at all that reads as a PLACE is a place.
     */
    if (!hasHeadlineSignal(value) && !validateLocation(value)) {
      return "headline_reads_as_a_location";
    }
    // "Metaview" on its own is a company, a school, or a word — not a headline.
    if (!hasHeadlineSignal(value) && value.trim().split(/\s+/).length <= 3) {
      return "headline_has_no_headline_signal";
    }
    if (isNegativeHeading(value)) return "headline_is_a_section_heading";
    return null;
  };

  /**
   * Offered in card order until one passes, rather than only the first line.
   *
   * The old code offered `cardLines[0]` alone, so a rejected first line left the
   * headline permanently empty even when the real one was directly below it.
   */
  for (const line of cardLines.slice(0, 6)) {
    if (offer("headline", "topcard", "high", line, validateHeadline)) break;
  }

  const locationLine = cardLines.find(
    (l) => l !== fields.headline?.value && !validateLocation(l),
  );
  offer("location", "topcard", "high", locationLine, validateLocation);

  // ---- the sections below the card ---------------------------------------
  // Located by what their heading SAYS — the only stable handle left once ids
  // and classes are gone. Negative space is excluded here too: "People you may
  // know" is a section with a heading like any other.
  const sections = attempt([], () => {
    const scope = $("main") || $('[role="main"]') || document.body;
    const out = [];
    for (const el of $$("section, article", scope)) {
      if (el.tagName === "ASIDE") continue;
      const heading = label($("h1, h2, h3", el));
      if (!heading || isNegativeHeading(heading)) continue;
      if (card.el && (el.contains(card.el) || card.el.contains(el))) continue;
      out.push({ el, heading: norm(heading) });
    }
    return out;
  });
  const sectionMatching = (re) => sections.find((s) => re.test(s.heading))?.el ?? null;

  /**
   * The About text.
   *
   * READ THE BOX, NOT THE LINES. The About body lives in a
   * `data-testid="expandable-text-box"` and is line-clamped by CSS with a
   * `data-testid="expandable-text-button"` to reveal the rest. Going through
   * `prunedLines` was the bug behind the permanent `bio_too_short`: the
   * containment filter drops any line that contains another, and the full
   * paragraph contains its own children, so the whole 995-character About was
   * discarded and a fragment was measured instead.
   *
   * The floor is 20 characters and truncation is a FLAG, not a rejection. A
   * short-but-real bio is data; an empty bio because we refused to expand is a
   * bug. The machine's EXPAND_BIO step presses the button before this runs.
   */
  const flags = [];
  const aboutEl = sectionMatching(/^(about|nevjegy|névjegy|info)/);
  if (aboutEl) {
    const box = $('[data-testid="expandable-text-box"]', aboutEl);
    /**
     * The box's text WITHOUT the reveal button's own label.
     *
     * The button lives inside the box, so a plain textContent read appends "see
     * more" / "…tovább" to every clamped bio — eight characters of LinkedIn's
     * chrome filed as the last words of the person's own description.
     */
    const boxText = (el) => {
      if (!el) return null;
      const parts = [];
      for (const node of el.childNodes) {
        if (node.nodeType === 1 && node.closest?.('[data-testid="expandable-text-button"]')) continue;
        if (node.nodeType === 1 && node.matches?.('[data-testid="expandable-text-button"]')) continue;
        if (node.nodeType === 1 && node.querySelector?.('[data-testid="expandable-text-button"]')) {
          // A wrapper holding both text and the button: recurse so the text
          // survives and only the button is dropped.
          parts.push(boxText(node) ?? "");
          continue;
        }
        parts.push(node.textContent ?? "");
      }
      return once(parts.join(" "));
    };
    let text = boxText(box);
    if (box && $('[data-testid="expandable-text-button"]', box)) {
      // The reveal button is still there, so the text may be clamped. Recorded
      // rather than acted on — this file never clicks.
      flags.push("bio_truncated");
    }
    if (!text) {
      // No box: fall back to the section's longest line, minus its heading.
      const { lines } = prunedLines(aboutEl, null);
      text = lines
        .filter((l) => !/^(about|nevjegy|info)\b/i.test(norm(l)))
        .sort((a, b) => b.length - a.length)[0];
    }
    offer("bio", box ? "about-box" : "topcard", "medium", text, (v) =>
      isEntirelySomeoneElse(v)
        ? "bio_matches_another_person_on_page"
        : v.length < 20
          ? "bio_too_short"
          : null,
    );
  } else {
    note("bio", "section:about", "absent");
  }

  // Recent posts, from whatever the profile already rendered — no scrolling and
  // no "show more". They feed the person brief, so losing them quietly would
  // degrade every brief without anything reporting it.
  const posts = attempt([], () => {
    const activity = sectionMatching(/(activity|aktivitas|posts|bejegyzes)/);
    if (!activity) return [];
    return $$("li", activity)
      .map((li) => label(li))
      .filter((t) => t && t.length > 20 && !isChrome(t) && !isEntirelySomeoneElse(t))
      .slice(0, 3);
  });

  /**
   * Current role and employer.
   *
   * TWO PATHS, BECAUSE THE SECTION USUALLY IS NOT THERE. The Experience section is
   * lazy-mounted — the page ships one `data-testid="lazy-column"` and renders the
   * section only once it scrolls into view. Measured on both real fixtures: the
   * section headings present are About, Featured, Activity and the three
   * suggestion rails. No Experience, no Education. So a reader that only knows how
   * to read the Experience section reports `section:experience:absent` forever,
   * which is exactly what the diagnostics showed.
   *
   * The machine's LOAD_SECTIONS step scrolls to mount it, and when that works this
   * reads the first entry at HIGH confidence. When it does not, the headline is
   * parsed instead — "CEO at Seyu" is a role and an employer stated by the person
   * themselves — and labelled `derived` at MEDIUM confidence, because a headline
   * is prose and "Building the future of X" is not a job title.
   */
  const jobLimit = (v) => (v.length > 200 ? "job_title_too_long" : null);
  /**
   * A DATE RANGE IS NOT AN EMPLOYER.
   *
   * The experience reader used to take the entry's second line as the employer,
   * and on the recorded post-RSC page that entry has no employer line at all:
   *
   *     0  "PR & Marketing Consultant"
   *     1  "Jan 2015 - Jul 2020 · 5 yrs 7 mos"
   *     2  "… more"
   *
   * So `companyName` came back as "Jan 2015 - Jul 2020", with `experience:
   * accepted` and high confidence, and went into a lead that way. The length
   * check was the only thing this validator did, and a date range is short.
   *
   * Matched by shape in both languages, because a Hungarian profile renders
   * "2015. jan. – 2020. júl. · 5 év 7 hónap".
   */
  const DATE_RANGE =
    /\b(19|20)\d{2}\b[\s.]*[-–—]|\b(present|jelenleg)\b|\b\d+\s*(yrs?|years?|mos?|months?|év|évek|hónap)\b/i;
  const companyLimit = (v) => {
    if (v.length > 200) return "company_name_too_long";
    if (DATE_RANGE.test(v)) return "company_reads_as_a_date_range";
    return null;
  };

  /**
   * The author byline on this person's own posts.
   *
   * On /in/mgoldberger the real headline — "VP Sales @ Metaview | Startup Advisor
   * and Investor | Ramp and Navan Alum" — appears NOWHERE in the top card. It is
   * in the byline above each post, which LinkedIn renders because a reader
   * scrolling past needs to know who is talking. So it is a legitimate source for
   * the headline and for role/employer, and it is attributable: it is the byline of
   * a post authored by the profile's owner.
   *
   * The post BODY is excluded — an expandable-text-box is prose, not a byline.
   */
  const bylineLines = attempt([], () => {
    const activity = sectionMatching(/(activity|aktivitas|posts|bejegyzes)/);
    if (!activity) return [];
    const out = [];
    for (const li of $$("li", activity)) {
      // Only the owner's own posts.
      const author = $$('a[href*="/in/"]', li).some((a) =>
        (a.getAttribute("href") ?? "").toLowerCase().includes(`/in/${ownerSlug}`),
      );
      if (!author) continue;
      for (const el of $$("span, div, p", li)) {
        if (el.closest('[data-testid="expandable-text-box"]')) continue;
        const t = clean(label(el));
        if (!t || t.length < 5 || t.length > 200) continue;
        if (isChrome(t) || isSomeoneElse(t)) continue;
        if (!out.includes(t)) out.push(t);
      }
    }
    return out;
  });

  /**
   * THE HEADLINE, FROM THE BYLINE — when the top card did not carry one.
   *
   * On /in/mgoldberger the top card has no headline line at all. The real one is
   * above each of the person's posts, and it is the multi-part string the brief
   * quotes: "VP Sales @ Metaview | Startup Advisor and Investor | Ramp and Navan
   * Alum". `derived` at MEDIUM confidence, because it comes from a byline rather
   * than from the card's own headline slot — and it still has to pass the same
   * validator, so it can never be the name or a location.
   */
  if (!fields.headline) {
    for (const line of bylineLines) {
      if (offer("headline", "derived", "medium", line, validateHeadline)) break;
    }
  }

  const expEl = sectionMatching(/(experience|tapasztalat|munkatapasztalat)/);
  if (expEl) {
    const first = $("li", expEl) ?? expEl;
    const { lines } = prunedLines(first, null);
    const usable = lines.filter((l) => !isChrome(l) && !isSomeoneElse(l));
    // Bounded to the Experience subtree: the entry's own lines, in order — role,
    // then employer, then the date range.
    /**
     * Role and employer are read TOGETHER, or neither is.
     *
     * They are one fact — "X at Y" — and a lead that pairs a role from one
     * source with an employer from another states something that was never true.
     * On the recorded page the first experience entry is a role that ended in
     * 2020 and names no employer, so taking its title while the company came
     * from the current headline produced "PR & Marketing Consultant" at
     * "JeansDay Marketing": two real facts, one false pairing.
     *
     * So the title is offered only when this entry also identifies the employer.
     * Otherwise the derived headline pattern supplies both, consistently.
     */

    /**
     * The employer BY SHAPE, not by position.
     *
     * `usable[1]` assumed every entry reads role / employer / dates. The recorded
     * page has entries with no employer line at all, so position handed the date
     * range to `companyName`. Skipping the role, the dates and the expander
     * leaves either the employer or nothing — and nothing is the right answer
     * when the entry does not name one. The top card's company chip is still
     * tried afterwards, and on that page it holds the CURRENT employer, which is
     * the more useful one anyway.
     */
    const isNoise = (l) =>
      !l || DATE_RANGE.test(l) || /^(…\s*)?(more|show more|továbbiak)$/i.test(l);
    /**
     * POSITIVE identification, or nothing.
     *
     * Skipping the noise is not enough: on the recorded page the entry has no
     * employer at all, and "skip what it is not" then handed over "External
     * Communications" — a skill listed further down. Wrong with high confidence,
     * which is the outcome this extractor exists to avoid.
     *
     * So an employer must be corroborated: either the entry names a `/company/`
     * link whose TEXT is that line, or the line is the one the headline gives
     * after "at". Otherwise the field is absent here and the derived sources —
     * the headline pattern, the card's company chip — get their turn. On this
     * page that is what supplies the CURRENT employer, which is the more useful
     * one anyway: the first experience entry is a role that ended in 2020.
     */
    /**
     * Company-link texts from the WHOLE page, not just this entry.
     *
     * Entry-scoped was too narrow: on the older recorded profiles the employer
     * is named in the entry as plain text while its `/company/` link sits in the
     * card or the right rail, so requiring the anchor inside the entry rejected
     * six employers that were perfectly readable. Page-wide is the same
     * cross-reference `topcard-company` already uses — two independent places
     * naming the same string — and the line still has to come from this entry,
     * so no stranger's employer can arrive through it.
     */
    const companyTexts = new Set(
      $$('a[href*="/company/"]').map((a) => norm(label(a))).filter((t) => t && t.length >= 2),
    );
    /**
     * THE EMPLOYER IS THE LINE BETWEEN THE ROLE AND THE DATES.
     *
     * That is the entry's shape, and it is what separates the two recorded
     * pages: an older profile reads role / "Danubia Fogászat Kft." / dates, while
     * the post-RSC one reads role / dates — no employer at all. So if the line
     * after the role is ALREADY a date, this entry does not name one, and
     * scanning further down finds a skill ("External Communications") and files
     * it as the employer with high confidence. Bounded to that one position, the
     * question answers itself.
     *
     * A line further down is still accepted if a `/company/` link somewhere on
     * the page carries the same text — corroboration from two independent places,
     * for entries that put the employer somewhere else.
     */
    const afterRole = usable[1]?.split(" · ")[0];
    const employerLine = !isNoise(afterRole)
      ? afterRole
      : usable
          .slice(2)
          .map((l) => l.split(" · ")[0])
          .find((l) => !isNoise(l) && companyTexts.has(norm(l)));
    if (employerLine) {
      offer("jobTitle", "experience", "high", usable[0], jobLimit);
      offer("companyName", "experience", "high", employerLine, companyLimit);
    } else {
      note("companyName", "experience", "no_employer_named_in_the_entry");
      note("jobTitle", "experience", "not_read_without_its_employer");
    }
    // Whether this is the CURRENT role, which is the only one worth filing.
    const dates = usable.find((l) => /\b(present|jelenleg|current)\b/i.test(l));
    if (dates) note("jobTitle", "experience", "marked_present");
  } else {
    note("jobTitle", "section:experience", "absent");
    note("companyName", "section:experience", "absent");
  }

  // ---- the logged-out view still ships a Person graph --------------------
  // Kept because it is strictly better than anything scraped when present, and
  // it costs nothing when absent. It feeds the same validators.
  const ld = attempt(null, () => {
    for (const tag of $$('script[type="application/ld+json"]')) {
      let parsed;
      try {
        parsed = JSON.parse(tag.textContent || "");
      } catch {
        continue;
      }
      const nodes = [];
      const walk = (n) => {
        if (!n || typeof n !== "object") return;
        if (Array.isArray(n)) return n.forEach(walk);
        nodes.push(n);
        if (n["@graph"]) walk(n["@graph"]);
      };
      walk(parsed);
      const person = nodes.find((n) => {
        const t = n["@type"];
        return t === "Person" || (Array.isArray(t) && t.includes("Person"));
      });
      if (person) return person;
    }
    return null;
  });

  if (ld) {
    offer("name", "derived", "high", ld.name, validateName);
    offer("headline", "derived", "high", Array.isArray(ld.jobTitle) ? ld.jobTitle[0] : ld.jobTitle, validateHeadline);
    offer("bio", "derived", "high", ld.description, () => null);
    const worksFor = Array.isArray(ld.worksFor) ? ld.worksFor[0] : ld.worksFor;
    offer("companyName", "derived", "high", worksFor && worksFor.name, () => null);
    const addr = ld.address;
    offer(
      "location",
      "derived",
      "high",
      addr &&
        (addr.addressLocality
          ? [addr.addressLocality, addr.addressRegion, addr.addressCountry].filter(Boolean).join(", ")
          : addr.name),
      validateLocation,
    );
  }

  /**
   * The fallbacks run AFTER the Person graph, not before it.
   *
   * `offer()` is first-wins, so ordering IS precedence. Placed before the graph,
   * the headline's "Danubia Fogászat" beat the graph's "Danubia Fogászat Kft." —
   * a worse value at a lower confidence winning because it was offered first. The
   * order now reads: the Experience section (high), the Person graph (high), the
   * headline pattern (medium), the top card's company link (medium).
   */
  /**
   * The headline fallback: "Role at Company", "Role @ Company", "Role | Company".
   *
   * Deliberately conservative. Only the three explicit separators are read, and
   * only when both halves look like a role and a company rather than a sentence —
   * a headline is marketing copy as often as it is a job title, and a wrong
   * company name propagates into a quote.
   */
  /**
   * "Role at Company" in any of its written forms.
   *
   * Deliberately conservative. Only explicit separators are read, and both halves
   * have to look like a role and a company rather than a sentence — a headline is
   * marketing copy as often as it is a job title, and a wrong company name
   * propagates into a quote.
   */
  const parseRoleAndCompany = (text) => {
    const t = clean(text);
    if (!t) return null;
    const patterns = [
      // "As VP Sales at Metaview, I'm focused on…" — the About opening clause.
      // `of` is deliberately NOT a separator here: "Head of Growth",
      // "Director of Sales" and "VP of Engineering" are single role titles, and
      // treating `of` as the split point turned "Head of Growth at Acme" into the
      // role "Head" at the company "Growth".
      /^\s*(?:as|mint)\s+(?:the\s+)?(.{2,60}?)\s+(?:at|@|-nál|-nél)\s+(.{2,60}?)\s*(?:[,.;:]|$)/i,
      // "I'm VP Sales at Metaview" / "I am VP Sales at Metaview".
      // Written without a group straight after `i`, which the extension's static
      // "calls-nothing-it-has-not-defined" check would read as a call to `i`.
      /^\s*(?:i'm|i am)\s+(?:the\s+|a\s+|an\s+)?(.{2,60}?)\s+(?:at|@)\s+(.{2,60}?)\s*(?:[,.;:]|$)/i,
      // "VP Sales @ Metaview | Startup Advisor" — the plain headline form. The
      // first separator wins; anything after a second one is a tagline.
      /^\s*(.{2,80}?)\s+(?:at|@|\||·|—|–)\s+(.{2,80}?)\s*(?:[|·—–].*)?$/i,
    ];
    for (const re of patterns) {
      const m = re.exec(t);
      if (!m) continue;
      const role = clean(m[1]);
      const company = clean(m[2]);
      if (!role || !company) continue;
      if (role.split(/\s+/).length > 6 || company.split(/\s+/).length > 6) continue;
      // A clause, not a role.
      if (/\b(is|are|was|were|helping|building|making|we|our|focused|working)\b/i.test(role)) continue;
      if (!ROLE_VOCABULARY.test(role)) continue;
      return { role, company };
    }
    return null;
  };

  /**
   * THE FALLBACK CHAIN for role and employer, in order, recording which answered.
   *
   * The Experience section is lazy-mounted and frequently never arrives, so a
   * reader that only knows how to read it reports `section:experience:absent` for
   * ever. Four more sources, each of which the person wrote about themselves:
   *
   *   (ii)  the headline           "VP Sales @ Metaview | …"
   *   (iii) the top card's company link or current-position line
   *   (iv)  the About text's opening clause  "As VP Sales at Metaview, I'm…"
   *   (v)   the author byline on their own posts
   *
   * All four are `derived` at MEDIUM confidence — inference from prose, not a
   * field LinkedIn labelled.
   */
  const roleSources = [
    ["headline-pattern", () => parseRoleAndCompany(fields.headline?.value)],
    [
      "topcard-company",
      /**
       * The current employer, named in the top card as PLAIN TEXT.
       *
       * Measured on a real profile: the bounded card's twelve lines are the name,
       * the connection degree, the headline, the location, "Contact info", then
       * the company, then the school, then the connection count. The company is
       * not a link there — the page's 45 `/company/` anchors all sit OUTSIDE the
       * card, which is why looking for one inside it found nothing on every
       * profile.
       *
       * So the card line is cross-referenced against those anchors: a line that is
       * also the text of a `/company/` link somewhere on the page IS a company.
       * That is positive identification from two independent places rather than a
       * guess about position, and it separates the employer from the school beside
       * it — "Corvinus University of Budapest" matches no company anchor, while
       * "'Seyu - Together for victory!'" matches one exactly.
       *
       * Bounded either way: the line has to come from inside the card, so no
       * stranger's employer can arrive through this.
       */
      () => {
        if (!card.ok) return null;
        const companyLinkTexts = new Set(
          $$('a[href*="/company/"]')
            .map((a) => norm(label(a)))
            .filter((t) => t && t.length >= 2),
        );
        if (companyLinkTexts.size === 0) return null;
        const match = (card.lines ?? []).find(
          (line) =>
            companyLinkTexts.has(norm(line)) &&
            !isChrome(line) &&
            !isSomeoneElse(line) &&
            norm(line) !== norm(fields.name?.value ?? "") &&
            norm(line) !== norm(fields.headline?.value ?? ""),
        );
        return match ? { role: null, company: match } : null;
      },
    ],
    ["about-opening", () => parseRoleAndCompany(fields.bio?.value?.slice(0, 240))],
    [
      "post-byline",
      () => {
        for (const line of bylineLines) {
          const parsed = parseRoleAndCompany(line);
          if (parsed) return parsed;
        }
        return null;
      },
    ],
  ];

  for (const [source, read] of roleSources) {
    if (fields.jobTitle && fields.companyName) break;
    const found = attempt(null, read);
    if (!found) {
      note("jobTitle", source, "absent");
      note("companyName", source, "absent");
      continue;
    }
    const hadRole = !!fields.jobTitle;
    const hadCompany = !!fields.companyName;
    if (found.role) offer("jobTitle", "derived", "medium", found.role, jobLimit);
    offer("companyName", "derived", "medium", found.company, (v) =>
      companyLimit(v) ?? (isSomeoneElse(v) ? "company_matches_another_person_on_page" : null),
    );
    /**
     * WHICH LINK OF THE CHAIN ANSWERED, for both fields.
     *
     * `offer()` records the provenance SOURCE — "derived" — which says the value
     * was inferred but not from what. With five sources in the chain that is the
     * one thing a reader of the diagnostics actually needs: "derived:accepted"
     * cannot be told apart from "derived:accepted", and when a field starts
     * arriving wrong there is no way to know which link to look at.
     */
    note("jobTitle", source, !hadRole && fields.jobTitle ? "accepted" : "rejected(no_role_in_source)");
    if (!hadCompany && fields.companyName) note("companyName", source, "accepted");
  }



  // ---- the photo ----------------------------------------------------------
  // The <img> inside the bounded card's own profile anchor, largest srcset
  // candidate. The BYTES are fetched separately (photo.js) in page context,
  // because these URLs are signed and time-limited and refuse an
  // unauthenticated server-side fetch — which is why every captured avatar
  // failed with "the photo could not be fetched".
  // ---- the photo ----------------------------------------------------------
  // NO POPUP. The image is already in the DOM: the top-card anchor identified by
  // componentkey="topcard-logo-image-referencekey" contains an <img> whose srcset
  // lists the candidates, and the largest is 800w.
  //
  // Two traps the real fixtures exposed. The 1400w candidate on the page belongs
  // to the COVER photo — a landscape banner in the same top card — so "largest
  // srcset in the card" picks a banner as somebody's avatar. And that same anchor's
  // href is the CONTACT-INFO route, so "click the photo to open it" navigates to
  // contact info and then waits for a photo viewer that does not exist. There is
  // no /overlay/photo/ route on the page at all.
  //
  // Selection goes through the shared selector layer, so the tier that answered is
  // recorded. The BYTES are fetched separately by photo.js in page context, because
  // licdn URLs are signed and refuse an unauthenticated server-side fetch.
  const photo = attempt({ url: null, reason: "photo_lookup_threw", tier: null }, () => {
    if (S) {
      const anchor = S.topcardPhotoAnchor(document);
      if (anchor) {
        const url = S.largestSrcsetCandidate($("img", anchor));
        if (url) return { url, reason: null, tier: "componentkey" };
        return { url: null, reason: "no_usable_image_in_topcard_anchor", tier: "componentkey" };
      }
    }
    // STRUCTURE FALLBACK — only reached if selectors.js failed to inject, which
    // every call site now prevents by loading it first.
    //
    // Known limitation, measured rather than assumed: on the real page this
    // returns the correct person's avatar at 100w rather than 800w. Of the
    // owner's 74 anchors, 16 hold an avatar image and only the componentkey'd
    // top-card anchor carries the full srcset; the bounded card is a text subtree
    // that does not contain it. A smaller image of the right face is a fair
    // degradation for a path that should never run, and chasing it further would
    // buy nothing the primary tier does not already give.
    if (!card.ok) return { url: null, reason: "no_bounded_card", tier: null };
    const anchor = ownerAnchors.map((a) => a.el).find((el) => card.el.contains(el) && $("img", el));
    // Content-based preference, because the cover photo is ALSO inside the top
    // card and offers a bigger srcset (1400w) than the avatar (800w). LinkedIn
    // serves avatars from a "profile-displayphoto" path, which is what tells the
    // two apart without a class name.
    const looksLikeAvatar = (el) =>
      /profile-displayphoto|profile-framedphoto/i.test(
        `${el.getAttribute("srcset") ?? ""} ${el.getAttribute("src") ?? ""}`,
      );
    // Prefer a candidate that carries a srcset. Measured on the real page: 16 of
    // the owner's 74 anchors hold an avatar image, and only ONE — the
    // componentkey'd top-card anchor — offers the full srcset; the rest give a
    // bare 100w src. Taking the first avatar found yields a thumbnail, which is
    // the right person at the wrong size.
    // Scoped to the bounded CARD, not to the first owner anchor that happens to
    // hold an image — that anchor is one image wide, and on the real page it is
    // the wrong one. The boundary test guarantees a single identity inside the
    // card, so every avatar in here is this person's.
    const inScope = $$("img", card.el).filter(looksLikeAvatar);
    const img =
      inScope.find((el) => (el.getAttribute("srcset") ?? "").includes("w")) ??
      inScope[0] ??
      (anchor ? $("img", anchor) : null);
    if (!img) return { url: null, reason: "no_avatar_image_in_card", tier: "structure" };
    const srcset = img.getAttribute("srcset");
    let best = null;
    if (srcset) {
      best = srcset
        .split(",")
        .map((part) => {
          const [u, size] = part.trim().split(/\s+/);
          return { u, w: Number.parseInt(size ?? "0", 10) || 0 };
        })
        .filter((c) => c.u && /^https?:\/\//i.test(c.u))
        .sort((a, b) => b.w - a.w)[0]?.u ?? null;
    }
    for (const attr of ["data-delayed-url", "src"]) {
      if (best) break;
      const v = clean(img.getAttribute(attr));
      // data: and blob: are lazy-load placeholders, not photographs.
      if (v && /^https?:\/\//i.test(v)) best = v;
    }
    return best
      ? { url: best, reason: null, tier: "structure" }
      : { url: null, reason: "only_placeholder_sources", tier: "structure" };
  });

  if (photo.url) {
    fields.photoUrl = { value: photo.url, source: "topcard", confidence: "high" };
    note("photoUrl", photo.tier ?? "topcard", "accepted");
  } else {
    skipped.photoUrl = photo.reason;
    note("photoUrl", photo.tier ?? "topcard", `rejected(${photo.reason})`);
  }

  // ---- the contact-info trigger ------------------------------------------
  // Located but NOT pressed. Contact details are not on the profile page at all
  // (the diagnostics measured mailto: 0, tel: 0, no outbound hosts) — they exist
  // only behind this overlay, which contact.js opens on an explicit capture.
  const contactTrigger = attempt(null, () => {
    const scope = card.el ?? $("main") ?? document.body;
    for (const a of $$("a, button", scope)) {
      const href = a.getAttribute("href") ?? "";
      if (/\/overlay\/contact-info/i.test(href)) return true;
      const t = norm(label(a));
      if (t === "contact info" || t === "kapcsolati adatok" || t === "see contact info") return true;
    }
    return false;
  });

  /**
   * THE CROSS-FIELD INVARIANT, ENFORCED RATHER THAN TESTED.
   *
   * No other field may be the person's name. This is a last line of defence and
   * it is here because the failure it prevents is not hypothetical: the headline
   * came back as "Mark Goldberger" at confidence "high", the form put the headline
   * in the job-title slot, and the operator saw an empty Name field with the name
   * sitting next to it. Each validator already refuses this, but they refuse it
   * one field at a time and a new field added later would not inherit the rule.
   *
   * A violation is REMOVED and recorded, never corrected — a field that turned out
   * to be the name has no other value to fall back to, and an empty field with a
   * reason code is the honest outcome.
   */
  if (fields.name) {
    const nameKey = norm(fields.name.value);
    for (const field of ["headline", "jobTitle", "location", "companyName", "bio"]) {
      const current = fields[field];
      if (!current) continue;
      const v = norm(current.value);
      if (v === nameKey || nameKey.includes(v)) {
        delete fields[field];
        skipped[field] = `${field}_was_the_name`;
        note(field, current.source, `rejected(${field}_was_the_name)`);
      }
    }
  }

  const flat = (f) => fields[f]?.value ?? undefined;

  return {
    url: profileUrl(),
    refused: false,
    route: routeCheck,
    /** Non-fatal observations — e.g. the About text may still be clamped. */
    flags,
    // Flat values, so an older server keeps working unchanged.
    name: flat("name"),
    headline: flat("headline"),
    companyName: flat("companyName"),
    location: flat("location"),
    jobTitle: flat("jobTitle"),
    bio: flat("bio"),
    photoUrl: flat("photoUrl"),
    // Email, phone and website are NOT on this page. contact.js supplies them.
    posts,

    // {value, source, confidence} per field, and why each rejection happened.
    provenance: Object.fromEntries(
      Object.entries(fields).map(([k, v]) => [
        k,
        { source: v.source, confidence: v.confidence, via: v.via ?? "dom" },
      ]),
    ),
    skipped,
    boundary: {
      ok: card.ok,
      reason: card.reason,
      identitiesInCard: card.ok ? 1 : (card.identities ?? null),
      excludedNegativeSpaceNodes: card.excluded ?? 0,
      otherPeopleOnPage: otherPeople.length,
      contactTriggerPresent: !!contactTrigger,
    },
    _from: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.source])),
    _attempts: attempts,
  };

  /**
   * The canonical profile URL from the address bar alone.
   *
   * Separate from `profileUrl()` below, which consults `ownerSlug` — a `const`
   * declared further down, so calling it from the route guard above would hit its
   * temporal dead zone and throw. This one only needs the URL, which is the point:
   * it has to work on the very routes where nothing else does.
   */
  function canonicalProfileUrl() {
    try {
      const u = new URL(window.location.href);
      const m = /^\/in\/([^/]+)/.exec(u.pathname);
      if (m) return `https://www.linkedin.com/in/${decodeURIComponent(m[1]).toLowerCase()}`;
      return `${u.origin}${u.pathname}`.replace(/\/$/, "");
    } catch {
      return String(window.location.href ?? "").split("?")[0];
    }
  }

  function profileUrl() {
    try {
      const u = new URL(window.location.href);
      if (!/^\/sales\//i.test(u.pathname)) {
        return `${u.origin}${u.pathname}`.replace(/\/$/, "");
      }
      // Sales Navigator: key on the public profile when the page names it
      // unambiguously, so one human is not two leads. Otherwise the sales URL
      // minus its search context, which changes with how you arrived.
      if (ownerSlug) return `https://www.linkedin.com/in/${ownerSlug}`;
      return `${u.origin}${u.pathname.split(",")[0]}`.replace(/\/$/, "");
    } catch {
      return String(window.location.href ?? "").split("?")[0];
    }
  }
})();
