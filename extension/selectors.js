/**
 * The only place in this extension that knows how to find things on a LinkedIn
 * page. Injected before content.js, in the same isolated world.
 *
 * ── WHY A SEPARATE LAYER, AND WHY THREE TIERS ───────────────────────────────
 *
 * LinkedIn now renders server-driven UI. Every class name is a hash
 * (`_36cbea85`), there is no <h1>, and there are no id anchors — so the only
 * stable handles left are the ones the framework itself needs:
 *
 *   TIER 1  componentkey / data-testid. The framework's own identifiers, which
 *           it uses to reconcile its component tree. Semantic and stable —
 *           `topcard-logo-image-referencekey` says what it is.
 *   TIER 2  role and structure. The bounded top card, established by the
 *           single-identity boundary test: exactly one /in/ slug inside it.
 *   TIER 3  visible text labels. Only for overlay entries, where the label IS
 *           the contract ("Email", "Phone") and cannot be dropped without
 *           breaking screen readers.
 *
 * Tried in that order, and WHICH ONE ANSWERED IS RECORDED. That matters more
 * than it sounds: a field silently falling from tier 1 to tier 3 is the early
 * warning that LinkedIn has changed something, and without the record the first
 * symptom is a wrong value in somebody's pipeline.
 *
 * NO CSS CLASS MAY APPEAR IN THIS FILE OR IN content.js. A test greps both for
 * hashed-class patterns and fails. Class-based selection is what broke this
 * extension twice.
 */
(() => {
  const clean = (v) => {
    if (typeof v !== "string") return null;
    const t = v.replace(/\s+/g, " ").trim();
    return t.length === 0 ? null : t;
  };

  const attempt = (fallback, fn) => {
    try {
      const v = fn();
      return v === undefined || v === null ? fallback : v;
    } catch {
      return fallback;
    }
  };

  const q = (sel, root) => attempt(null, () => (root ?? document).querySelector(sel));
  const qa = (sel, root) => attempt([], () => [...(root ?? document).querySelectorAll(sel)]);

  const norm = (s) =>
    (s ?? "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();

  /** Text said once — LinkedIn doubles many labels for screen readers. */
  const once = (raw) => {
    const t = clean(raw);
    if (!t) return null;
    const half = t.slice(0, t.length / 2);
    return half.length > 0 && half + half === t ? half : t;
  };

  /**
   * Run an ordered list of strategies and report which tier answered.
   *
   * Each strategy is { tier, name, find }. `find` returns a value or null. The
   * trail records every attempt and why it failed, which is what the diagnostics
   * panel prints.
   */
  function resolve(strategies) {
    const trail = [];
    for (const s of strategies) {
      let value = null;
      try {
        value = s.find();
      } catch (e) {
        trail.push(`${s.tier}/${s.name}: threw(${String(e?.name ?? "Error")})`);
        continue;
      }
      if (value === null || value === undefined || value === "") {
        trail.push(`${s.tier}/${s.name}: absent`);
        continue;
      }
      trail.push(`${s.tier}/${s.name}: found`);
      return { value, tier: s.tier, strategy: s.name, trail };
    }
    return { value: null, tier: null, strategy: null, trail };
  }

  // ---- tier 1: the framework's own identifiers ---------------------------

  /**
   * The top-card photo anchor.
   *
   * On the real page this ONE element carries both the profile photo and the
   * href for the contact-info route — `componentkey="topcard-logo-image-
   * referencekey"`. It is the single most useful landmark on the page.
   */
  const topcardPhotoAnchor = (doc = document) =>
    q('a[componentkey*="topcard-logo-image"]', doc) ??
    q('[componentkey*="topcard-logo-image"]', doc);

  /**
   * The contact-info trigger.
   *
   * NOT selectable by href: forty anchors on the real page carry the identical
   * `/overlay/contact-info/` href, including a Send button and two reaction
   * counters. So: the componentkey'd photo anchor first, then the anchor whose
   * visible text is literally "Contact info".
   */
  function contactRouteAnchor(doc = document, ownerSlug = null) {
    const byKey = topcardPhotoAnchor(doc);
    if (byKey && /overlay\/contact-info/i.test(byKey.getAttribute("href") ?? "")) return byKey;

    for (const a of qa('a[href*="overlay/contact-info"]', doc)) {
      const t = norm(once(a.textContent));
      if (t === "contact info" || t === "kapcsolati adatok") {
        if (!ownerSlug) return a;
        if ((a.getAttribute("href") ?? "").includes(ownerSlug)) return a;
      }
    }
    return null;
  }

  /** The contact-info route's content container, once the route has loaded. */
  const dialogContent = (doc = document) => q('[data-testid="dialog-content"]', doc);

  /**
   * Popovers this page has in the native popover state.
   *
   * `popover="manual"` is the important one: a manual popover does NOT close on
   * Escape and does NOT close on an outside click. Only `hidePopover()` closes
   * it. Waiting for either of the usual dismissals is a wait that can never end,
   * which is exactly how the capture hung.
   *
   * `popover="auto"` is excluded because those we may not have opened and they
   * dismiss themselves.
   */
  const manualPopovers = (doc = document) => qa('[popover]:not([popover="auto"])', doc);

  // ---- tier 2: role and structure ----------------------------------------

  /** Every /in/ anchor with the slug it points at. */
  function profileAnchors(doc = document) {
    return qa('a[href*="/in/"]', doc)
      .map((a) => {
        let slug = null;
        try {
          const u = new URL(a.getAttribute("href"), doc.location?.href ?? "https://www.linkedin.com/");
          if (!/(^|\.)linkedin\.com$/i.test(u.hostname)) return null;
          const m = /^\/in\/([^/]+)/.exec(u.pathname);
          slug = m ? decodeURIComponent(m[1]).toLowerCase() : null;
        } catch {
          return null;
        }
        return slug ? { el: a, slug } : null;
      })
      .filter(Boolean);
  }

  /**
   * The name element.
   *
   * There is no <h1> on the real page — the name sits in an <h2>. But section
   * headings are h2s too ("About", "Featured", "Activity"), so an h2 alone is
   * not the name: it has to be the h2 inside the bounded card.
   */
  function nameHeading(card, doc = document) {
    if (card) {
      const h = q("h2, h3", card);
      if (h && once(h.textContent)) return h;
    }
    return q('[role="heading"][aria-level="1"]', doc) ?? q("h1", doc);
  }

  /**
   * The location line.
   *
   * On the real page it is the first <p> inside the container that also holds the
   * "Contact info" anchor — the two live in the same little row, separated by a
   * <p>·</p>. Anchoring on the contact anchor rather than on position means the
   * degree badges ("· 1st") and the headline cannot be mistaken for it.
   */
  function contactInfoTextAnchor(doc = document) {
    for (const a of qa('a[href*="overlay/contact-info"]', doc)) {
      const t = norm(once(a.textContent));
      if (t === "contact info" || t === "kapcsolati adatok") return a;
    }
    return null;
  }

  function locationParagraph(doc = document, _ownerSlug = null) {
    // Deliberately the TEXT anchor, not contactRouteAnchor(). That one prefers
    // the componentkey'd photo anchor — correct for activating the route, wrong
    // here: the photo's closest div is the photo wrapper, and the location lives
    // in the little row beside the "Contact info" LINK. Verified against the
    // real fixture, where anchoring on the photo returned nothing.
    const anchor = contactInfoTextAnchor(doc);
    const row = anchor?.closest("div");
    if (!row) return null;
    for (const p of qa("p", row)) {
      const t = once(p.textContent);
      if (!t || t.length < 3) continue;
      if (/^·/.test(t)) continue;
      if (norm(t) === "contact info" || norm(t) === "kapcsolati adatok") continue;
      return p;
    }
    return null;
  }

  // ---- tier 3: visible text labels (overlay only) ------------------------

  /** The overlay's label vocabulary, English and Hungarian. */
  const OVERLAY_LABELS = {
    email: ["email", "e-mail", "email address", "e-mail cim"],
    phone: ["phone", "phone number", "telefon", "telefonszam"],
    website: ["website", "websites", "weboldal", "webhely"],
    address: ["address", "cim"],
    birthday: ["birthday", "szuletesnap"],
    connected: ["connected", "connected since", "kapcsolat letrejotte"],
    im: ["im", "instant messaging"],
    profile: ["profile", "profil"],
  };

  function labelKind(heading) {
    const k = norm(heading).replace(/[’']s\b/g, "").trim();
    for (const [kind, names] of Object.entries(OVERLAY_LABELS)) {
      if (names.some((n) => k === n || k.startsWith(`${n} `) || k.endsWith(` ${n}`))) return kind;
    }
    if (/\bprofile$|\bprofil$/.test(k)) return "profile";
    return null;
  }

  /** The photo's largest srcset candidate. */
  function largestSrcsetCandidate(img) {
    if (!img) return null;
    const srcset = img.getAttribute("srcset");
    if (srcset) {
      const best = srcset
        .split(",")
        .map((part) => {
          const [url, size] = part.trim().split(/\s+/);
          return { url, width: Number.parseInt(size ?? "0", 10) || 0 };
        })
        .filter((c) => c.url && /^https?:\/\//i.test(c.url))
        .sort((a, b) => b.width - a.width)[0];
      if (best) return best.url;
    }
    for (const attr of ["data-delayed-url", "src"]) {
      const v = clean(img.getAttribute(attr));
      // data: and blob: are lazy-load placeholders, not photographs.
      if (v && /^https?:\/\//i.test(v)) return v;
    }
    return null;
  }

  globalThis.VentureSelectors = {
    clean,
    once,
    norm,
    q,
    qa,
    attempt,
    resolve,
    // tier 1
    topcardPhotoAnchor,
    contactRouteAnchor,
    contactInfoTextAnchor,
    dialogContent,
    manualPopovers,
    // tier 2
    profileAnchors,
    nameHeading,
    locationParagraph,
    // tier 3
    labelKind,
    OVERLAY_LABELS,
    // shared
    largestSrcsetCandidate,
  };
})();
