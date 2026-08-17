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
    const t = v.replace(/\s+/g, " ").trim();
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

  // ---- who this page is about --------------------------------------------
  const slugFromUrl = attempt(null, () => {
    const m = /^\/in\/([^/]+)/.exec(window.location.pathname);
    return m ? decodeURIComponent(m[1]).toLowerCase() : null;
  });

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

  /** Does this value contain, or sit inside, somebody else's name? */
  const isSomeoneElse = (value) => {
    const k = norm(value);
    if (!k) return false;
    return otherPeopleKeys.some((other) => k === other || k.includes(other) || other.includes(k));
  };

  // ---- the bounded top card ----------------------------------------------
  /** Should this subtree be pruned before reading? */
  const isNegativeSpace = (el, keep) => {
    if (!el || !el.tagName) return false;
    // Never prune a subtree containing the owner's own anchor.
    if (keep && el.contains(keep)) return false;
    if (el.tagName === "ASIDE") return true;
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
    return {
      lines: meaningful.filter(
        (l) => !meaningful.some((o) => o !== l && o.length >= 4 && l.includes(o)),
      ),
      excluded,
    };
  };

  /** Identities reachable inside a pruned container. */
  const prunedIdentities = (root, keep) => {
    const { elements } = walkPruned(root, keep);
    const set = new Set(elements);
    const ids = new Set();
    for (const { el, slug } of profileAnchors) if (set.has(el)) ids.add(slug);
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
    const withImg = ownerAnchors.filter((a) => $("img", a.el));
    const starts = [...withImg, ...ownerAnchors];

    for (const start of starts) {
      let node = start.el.parentElement;
      for (let depth = 0; node && depth < 10; depth += 1) {
        if (node === scope || node === document.body || node === document.documentElement) break;
        const { lines, excluded } = prunedLines(node, start.el);
        // A card is a name, a headline and at least one more line.
        if (lines.length >= 3) {
          const ids = prunedIdentities(node, start.el);
          if (ids.size === 1 && ids.has(ownerSlug)) {
            return { el: node, ok: true, reason: null, lines, excluded, anchor: start.el, depth };
          }
          return {
            el: null,
            ok: false,
            reason: "card_contains_more_than_one_identity",
            identities: ids.size,
            excluded,
          };
        }
        node = node.parentElement;
      }
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
    fields[field] = { value, source, confidence };
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
  const slugTokens = attempt(new Set(), () => tokens((ownerSlug ?? "").replace(/-/g, " ")));

  /**
   * A name must agree with the title AND the slug.
   *
   * Compared as token SETS, not strings: Hungarian puts the family name first,
   * so a card reading "Tóth-Szűcs Örs Ábel" against a title of "Örs Ábel
   * Tóth-Szűcs" is the same person and a string comparison would reject it.
   */
  const validateName = (value) => {
    if (value.length < 2 || value.length > 120) return "name_length_implausible";
    if (isSomeoneElse(value)) return "name_matches_another_person_on_page";
    const v = tokens(value);
    if (v.size === 0) return "name_has_no_comparable_tokens";
    const t = tokens(titleName ?? "");
    if (t.size > 0) {
      const shared = [...v].filter((x) => t.has(x)).length;
      if (shared === 0) return "name_disagrees_with_page_title";
    }
    if (slugTokens.size > 0) {
      const shared = [...v].filter((x) => slugTokens.has(x)).length;
      // A slug can be "anna-kovacs-8a72b1"; one shared token is agreement.
      if (shared === 0) return "name_disagrees_with_profile_url";
    }
    return null;
  };

  const cardNameEl = card.ok ? card.anchor : null;
  offer("name", "topcard", "high", cardNameEl ? label(cardNameEl) : null, validateName);
  // The anchor holding the photo has no text; the sibling anchor to the same
  // slug does.
  if (!fields.name && card.ok) {
    for (const a of ownerAnchors) {
      if (!card.el.contains(a.el)) continue;
      if (offer("name", "topcard", "high", label(a.el), validateName)) break;
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
    /^·?\s*\d+(st|nd|rd|th)\b/i.test(l) ||
    /^[·•|,\s]+$/.test(l) ||
    l.length <= 1;

  const cardLines = card.ok
    ? card.lines.filter((l) => l !== fields.name?.value && !isChrome(l) && !isSomeoneElse(l))
    : [];

  // ---- headline -----------------------------------------------------------
  const LOCATION_SHAPE = /^[\p{L}\s.'’-]+(,\s*[\p{L}\s.'’-]+){1,2}$/u;

  const validateHeadline = (value) => {
    if (value.length < 3 || value.length > 220) return "headline_length_implausible";
    if (isSomeoneElse(value)) return "headline_matches_another_person_on_page";
    if (fields.name && norm(value) === norm(fields.name.value)) return "headline_is_the_name";
    // A bare "City, Country" is a location that drifted into the wrong slot.
    if (LOCATION_SHAPE.test(value) && value.split(",").length <= 3 && !/[@|·]/.test(value)) {
      return "headline_reads_as_a_location";
    }
    if (isNegativeHeading(value)) return "headline_is_a_section_heading";
    return null;
  };

  offer("headline", "topcard", "high", cardLines[0], validateHeadline);

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

  const aboutEl = sectionMatching(/^(about|nevjegy|info)/);
  if (aboutEl) {
    const { lines } = prunedLines(aboutEl, null);
    const longest = lines
      .filter((l) => !/^(about|nevjegy|info)\b/i.test(norm(l)))
      .sort((a, b) => b.length - a.length)[0];
    offer("bio", "topcard", "medium", longest, (v) =>
      isSomeoneElse(v) ? "bio_matches_another_person_on_page" : v.length < 20 ? "bio_too_short" : null,
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
      .filter((t) => t && t.length > 20 && !isChrome(t) && !isSomeoneElse(t))
      .slice(0, 3);
  });

  const expEl = sectionMatching(/(experience|tapasztalat)/);
  if (expEl) {
    const first = $("li", expEl) ?? expEl;
    const { lines } = prunedLines(first, null);
    const usable = lines.filter((l) => !isChrome(l) && !isSomeoneElse(l));
    offer("jobTitle", "topcard", "medium", usable[0], (v) =>
      v.length > 200 ? "job_title_too_long" : null,
    );
    offer("companyName", "topcard", "medium", usable[1]?.split(" · ")[0], (v) =>
      v.length > 200 ? "company_name_too_long" : null,
    );
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

  // ---- the photo ----------------------------------------------------------
  // The <img> inside the bounded card's own profile anchor, largest srcset
  // candidate. The BYTES are fetched separately (photo.js) in page context,
  // because these URLs are signed and time-limited and refuse an
  // unauthenticated server-side fetch — which is why every captured avatar
  // failed with "the photo could not be fetched".
  const photo = attempt({ url: null, reason: "photo_lookup_threw" }, () => {
    if (!card.ok) return { url: null, reason: "no_bounded_card" };
    const anchor = ownerAnchors.map((a) => a.el).find((el) => card.el.contains(el) && $("img", el));
    const img = anchor ? $("img", anchor) : $("img", card.el);
    if (!img) return { url: null, reason: "no_image_in_card" };

    const candidates = [];
    const srcset = img.getAttribute("srcset");
    if (srcset) {
      for (const part of srcset.split(",")) {
        const [url, size] = part.trim().split(/\s+/);
        if (url) candidates.push({ url, width: Number.parseInt(size ?? "0", 10) || 0 });
      }
      candidates.sort((a, b) => b.width - a.width);
    }
    const delayed = img.getAttribute("data-delayed-url");
    if (delayed) candidates.push({ url: delayed, width: 0 });
    const src = img.getAttribute("src");
    if (src) candidates.push({ url: src, width: 0 });

    for (const c of candidates) {
      const u = clean(c.url);
      // data: and blob: are lazy-load placeholders, not photographs.
      if (u && /^https?:\/\//i.test(u)) return { url: u, reason: null };
    }
    return { url: null, reason: "only_placeholder_sources" };
  });
  if (photo.url) {
    fields.photoUrl = { value: photo.url, source: "topcard", confidence: "high" };
    note("photoUrl", "topcard", "accepted");
  } else {
    skipped.photoUrl = photo.reason;
    note("photoUrl", "topcard", `rejected(${photo.reason})`);
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

  const flat = (f) => fields[f]?.value ?? undefined;

  return {
    url: profileUrl(),
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
      Object.entries(fields).map(([k, v]) => [k, { source: v.source, confidence: v.confidence }]),
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
