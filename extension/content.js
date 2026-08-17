/**
 * Venture OS capture — content script (P1/1e).
 *
 * READS the page the user is already viewing and returns what it finds. It is
 * injected on demand by the popup, not persistently, and it does exactly one
 * thing: read. There is no clicking, no scrolling, no pagination, no network
 * call, and nothing runs unless the user pressed the button.
 *
 * That boundary is deliberate. CLAUDE.md forbids LinkedIn scraping and
 * automation; an assistive reader over the page a human already opened is a
 * different thing from a crawler, and this file is where that distinction is
 * either kept or lost. Keep it.
 *
 * EXTRACTION IS LAYERED, hardest-to-break first. The first version read only CSS
 * classes, and once LinkedIn reshuffled them a capture returned nothing but the
 * URL — which is exactly what happened in practice. Class names are cosmetic and
 * change without notice; the sources below are load-bearing for LinkedIn's own
 * search results, accessibility and link previews, so they change far more
 * slowly:
 *
 *   1. JSON-LD   — the Person graph LinkedIn embeds for search engines
 *   2. meta tags — og:title / og:description / og:image, for link previews
 *   3. <title>   — "Name - Headline | LinkedIn"
 *   4. aria      — the accessibility contract: aria-label on the top card's
 *                  company and school buttons, mailto:/tel: hrefs. LinkedIn
 *                  cannot drop these without breaking screen readers, which
 *                  makes them steadier than any class name.
 *   5. structure — the SHAPE of the page: the <h1>, and sections named by their
 *                  own heading. A signed-in profile is React-rendered and
 *                  carries neither a Person graph nor a useful og:description,
 *                  so on the page that actually matters this is the layer that
 *                  does the work.
 *   6. CSS       — best-effort, last resort
 *
 * It also reports WHICH layer supplied each field, so the next layout change
 * reports itself in the popup instead of looking like a silent success.
 *
 * EVERY LAYER IS FENCED. A layer that throws must cost its own fields and
 * nothing else — the whole point of having six of them is that no single one is
 * load-bearing, and an unguarded exception would throw that away by returning
 * an empty capture from a page the other five could read.
 */
(() => {
  const clean = (v) => {
    if (typeof v !== "string") return null;
    const t = v.replace(/\s+/g, " ").trim();
    return t.length === 0 ? null : t;
  };
  const text = (el) => (el ? clean(el.textContent) : null);

  /** Run a layer; a broken one yields its fallback instead of the whole read. */
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

  /** Which layer each field came from, for the popup's diagnostic line. */
  const from = {};
  const take = (field, layer, value) => {
    const v = clean(value);
    if (v && !from[field]) {
      from[field] = layer;
      return v;
    }
    return null;
  };

  // ---- layer 1: JSON-LD ---------------------------------------------------
  // LinkedIn ships a schema.org graph for search engines. It is the most stable
  // thing on the page precisely because it is not styling.
  const ld = attempt(
    { name: null, headline: null, company: null, location: null, bio: null, photo: null },
    () => {
      const out = { name: null, headline: null, company: null, location: null, bio: null, photo: null };
      for (const tag of $$('script[type="application/ld+json"]')) {
        let parsed;
        try {
          parsed = JSON.parse(tag.textContent || "");
        } catch {
          continue; // a malformed block is not a reason to stop reading
        }

        // The graph may be an object, an array, or wrapped in @graph.
        const nodes = [];
        const walk = (n) => {
          if (!n || typeof n !== "object") return;
          if (Array.isArray(n)) {
            n.forEach(walk);
            return;
          }
          nodes.push(n);
          if (n["@graph"]) walk(n["@graph"]);
        };
        walk(parsed);

        const person = nodes.find((n) => {
          const t = n["@type"];
          return t === "Person" || (Array.isArray(t) && t.includes("Person"));
        });
        if (!person) continue;

        out.name = out.name || clean(person.name);
        out.bio = out.bio || clean(person.description);
        // jobTitle is a string on some profiles and an array on others.
        const title = Array.isArray(person.jobTitle) ? person.jobTitle[0] : person.jobTitle;
        out.headline = out.headline || clean(title);

        const worksFor = Array.isArray(person.worksFor) ? person.worksFor[0] : person.worksFor;
        out.company = out.company || clean(worksFor && worksFor.name);

        const addr = person.address;
        out.location =
          out.location ||
          clean(
            addr &&
              (addr.addressLocality
                ? [addr.addressLocality, addr.addressRegion, addr.addressCountry]
                    .filter(Boolean)
                    .join(", ")
                : addr.name),
          );

        const image = Array.isArray(person.image) ? person.image[0] : person.image;
        out.photo = out.photo || clean(typeof image === "string" ? image : image && image.contentUrl);
        break;
      }
      return out;
    },
  );

  // ---- layer 2: meta tags -------------------------------------------------
  const meta = (prop) =>
    attempt(null, () => {
      const el =
        document.querySelector(`meta[property="${prop}"]`) ||
        document.querySelector(`meta[name="${prop}"]`);
      return el ? clean(el.getAttribute("content")) : null;
    });

  // og:title is usually "Nagy Anna - Ügyvezető - Danubia Kft | LinkedIn".
  const splitTitle = (s) =>
    clean(s)
      ? s.replace(/\s*\|\s*LinkedIn\s*$/i, "").split(/\s+[-–—|]\s+/).map(clean).filter(Boolean)
      : [];
  const ogParts = attempt([], () => splitTitle(meta("og:title")));
  const titleParts = attempt([], () => splitTitle(document.title));

  // ---- shared vocabulary --------------------------------------------------
  // Chrome, not content. Everything here is a line LinkedIn puts on every
  // profile, so it says nothing about the person.
  const NOISE =
    /^(contact info|kapcsolatfelvétel|kapcsolati adatok|message|üzenet|connect|kapcsolódás|follow|követés|following|more|továbbiak|show all|see all|összes|open to|nyitott|add profile section|enhance profile|premium|linkedin|talks about|mutual connection)/i;
  const isNoise = (l) =>
    NOISE.test(l) ||
    /\b\d+[\d\s,.]*\+?\s*(connections?|followers?|követő|kapcsolat|ismerős)\b/i.test(l) ||
    /^·?\s*\d+(st|nd|rd|th)\b/i.test(l) ||
    /^·+$/.test(l) ||
    l.length <= 1;

  /** Reads like a place: "Budapest, Hungary". Conservative on purpose. */
  const isPlace = (l) => l.length <= 100 && l.includes(",") && !/[\d@]/.test(l);

  /**
   * Each visible line of a container, once, in document order.
   *
   * The doubled screen-reader copy is what makes this awkward: LinkedIn renders
   * many lines twice, once as `span[aria-hidden="true"]` for sight and once as
   * `.visually-hidden` for readers, so naive textContent yields
   * "BudapestBudapest".
   *
   * An earlier version handled that by reading ONLY the aria-hidden copies, and
   * falling back to ordinary nodes when there were none. That is the bug that
   * made this whole file look broken: LinkedIn doubles SOME lines in the top
   * card (the current-company and school buttons) while leaving the headline a
   * plain <div> and the location a plain <span>. One doubled line anywhere in
   * the card was enough to switch the reader into aria-hidden-only mode and
   * silently skip every line we actually wanted — the headline came back as the
   * company name and the location came back empty.
   *
   * So: read BOTH kinds and let de-duplication do the work it was always going
   * to have to do. Two copies of a line have identical text, so the `seen` set
   * collapses them, and no line can be missed for being the wrong kind of node.
   */
  const textLines = (el) => {
    if (!el || !el.querySelectorAll) return [];
    const nodes = $$("p, span, div, li, h1, h2, h3, a", el);

    const seen = new Set();
    const lines = [];
    for (const n of nodes) {
      const t = text(n);
      if (!t || seen.has(t)) continue;
      seen.add(t);
      lines.push(t);
    }
    // A container's text is the concatenation of its children's, so drop any
    // line that merely contains another — otherwise the whole card reads as one
    // enormous "line" and wins every "first line" test.
    return lines.filter((l) => !lines.some((o) => o !== l && l.includes(o)));
  };

  // ---- layer 4: aria ------------------------------------------------------
  // The top card's company and school pills carry their value in an aria-label
  // ("Current company: Danubia Kft. Click to skip to experience card"). That
  // label exists for screen readers, which means LinkedIn cannot quietly drop
  // it the way it drops class names — and it names the employer outright rather
  // than making us infer it from a position in a list.
  const ariaValue = (patterns) =>
    attempt(null, () => {
      for (const el of $$("[aria-label]")) {
        const label = clean(el.getAttribute("aria-label"));
        if (!label) continue;
        for (const re of patterns) {
          const m = re.exec(label);
          if (m && clean(m[1])) {
            // Labels are sentences: "Current company: X. Click to skip …".
            // Trim the instruction, not the name — "Kft." keeps its full stop,
            // which matters because that is how the company is spelled in the
            // records this will be matched against.
            return clean(m[1].replace(/\s+(?:click|kattint)\b.*$/i, ""));
          }
        }
      }
      return null;
    });

  const ariaCompany = ariaValue([
    /^current company:\s*(.+)$/i,
    /^jelenlegi (?:munkahely|vállalat):\s*(.+)$/i,
  ]);

  // mailto:/tel: are the same kind of contract: a link that says what it is.
  // Only ones the page ALREADY rendered are visible here — LinkedIn keeps the
  // contact overlay behind a click, and clicking is automation this file does
  // not do. If the user opened that overlay themselves before pressing Capture,
  // its links are in the DOM and we read them like any other published detail.
  const hrefValue = (scheme) =>
    attempt(null, () => {
      for (const a of $$(`a[href^="${scheme}:"]`)) {
        const raw = clean(a.getAttribute("href"));
        if (!raw) continue;
        const value = clean(decodeURIComponent(raw.slice(scheme.length + 1).split("?")[0]));
        if (value) return value;
      }
      return null;
    });

  /** A personal site the profile links to — never a LinkedIn or CDN address. */
  const ariaWebsite = attempt(null, () => {
    for (const a of $$('a[href^="http"]')) {
      const href = clean(a.getAttribute("href"));
      if (!href) continue;
      let host;
      try {
        host = new URL(href, window.location.href).hostname.toLowerCase();
      } catch {
        continue;
      }
      if (/(^|\.)(linkedin\.com|licdn\.com|lnkd\.in)$/.test(host)) continue;
      // LinkedIn wraps outbound links in its own redirector; the destination is
      // in the query string and is not worth unwrapping blind.
      if (host === "lnkd.in") continue;
      return `https://${host.replace(/^www\./, "")}`;
    }
    return null;
  });

  // ---- layer 5: page structure -------------------------------------------
  // Class names are cosmetic and rot; the shape of the page does not. A profile
  // is a heading holding the person's name, a subtitle under it, and sections
  // titled by their own heading. Where an element must be identified, this uses
  // SEMANTIC attributes — headings, list items, aria — never a class.

  /**
   * The card holding the person's name.
   *
   * Walks up from the <h1> to the nearest ancestor that reads like a card
   * rather than trusting any one tag. LinkedIn has shipped the top card as a
   * <section>, as a <div class="artdeco-card">, and as neither; anchoring on
   * "the ancestor with enough distinct lines in it" survives all three, and
   * stops one level below <main> so the card never swallows the whole page.
   */
  const topCard = attempt(null, () => {
    const main = $("main") || $('[role="main"]') || document.body;
    const h1 = $("h1", main);
    if (!h1) return null;
    let node = h1.parentElement;
    let best = h1.parentElement;
    for (let depth = 0; node && depth < 8; depth += 1) {
      if (node === main || node === document.body) break;
      best = node;
      // Three distinct lines is a card: the name, the headline, and one more.
      if (textLines(node).length >= 3) return node;
      node = node.parentElement;
    }
    return best;
  });

  /**
   * Profile sections, paired with their heading.
   *
   * A section is found by what its heading SAYS, but not every rollout wraps a
   * card in <section> — recent ones use <div id="about"> anchors followed by an
   * <article>-ish card. So candidates come from several tag shapes and from the
   * id anchors LinkedIn's own in-page navigation relies on.
   */
  const sections = attempt([], () => {
    const main = $("main") || $('[role="main"]') || document.body;
    const out = [];
    const seen = new Set();

    const add = (el, heading) => {
      const h = clean(heading);
      if (!el || !h || seen.has(el)) return;
      seen.add(el);
      out.push({ el, heading: h.toLowerCase() });
    };

    for (const el of $$("section, article", main)) {
      add(el, text($("h2, h3", el)));
    }
    // The id anchors: <div id="about"> sits immediately before its card.
    for (const id of ["about", "experience", "education", "skills", "content_collections"]) {
      const anchor = $(`#${id}`, main);
      if (!anchor) continue;
      const card = anchor.closest("section") || anchor.nextElementSibling || anchor.parentElement;
      add(card, id.replace(/_/g, " "));
    }
    return out;
  });

  const sectionMatching = (re) => sections.find((s) => re.test(s.heading))?.el ?? null;

  const structure = attempt(
    { name: null, headline: null, location: null, company: null, jobTitle: null, bio: null, posts: [] },
    () => {
      const out = {
        name: null, headline: null, location: null,
        company: null, jobTitle: null, bio: null, posts: [],
      };

      // -- the top card: name, then the subtitle under it
      const main = $("main") || $('[role="main"]') || document.body;
      out.name = text($("h1", main));
      if (topCard) {
        const lines = textLines(topCard).filter(
          (l) =>
            l !== out.name &&
            !isNoise(l) &&
            // The company and school pills live in this same card and are read
            // properly by the aria layer; letting them compete here is what
            // used to make the headline come back as the employer's name.
            l !== ariaCompany,
        );
        // The line under the name is the headline — LinkedIn has put it there
        // for as long as the profile has existed. Length-capped so a stray
        // paragraph cannot pose as one, and never a bare place name.
        out.headline = lines.find((l) => l.length <= 250 && !isPlace(l)) || null;
        out.location = lines.find((l) => l !== out.headline && isPlace(l)) || null;
      }

      // -- sections, found by what their heading SAYS rather than how it looks
      const about = sectionMatching(/^(about|névjegy|info)/);
      if (about) {
        // The About text is the longest thing in its section by a wide margin.
        const lines = textLines(about).filter((l) => !/^(about|névjegy|info)\b/i.test(l));
        out.bio = lines.slice().sort((a, b) => b.length - a.length)[0] || null;
      }

      const experience = sectionMatching(/(experience|tapasztalat)/);
      if (experience) {
        // First entry = current role. Its first line is the title, the next is
        // the employer, often suffixed "· Full-time".
        const first = $("li", experience) || experience;
        const lines = textLines(first).filter(
          (l) => !isNoise(l) && !/^(experience|tapasztalat)/i.test(l),
        );
        out.jobTitle = lines[0] || null;
        out.company = lines[1] ? clean(lines[1].split(" · ")[0]) : null;
      }

      const activity = sectionMatching(/(activity|aktivitás)/);
      if (activity) {
        out.posts = $$("li", activity)
          .map((li) => text(li))
          .filter((t) => t && !isNoise(t))
          .slice(0, 3);
      }
      return out;
    },
  );

  // Recent posts the person published or shared. Read from whatever the profile
  // already rendered — no scrolling and no "show more", so this is the first few
  // visible items or nothing.
  const posts = structure.posts.length
    ? structure.posts
    : $$(
        ".feed-shared-update-v2 .update-components-text, .profile-creator-shared-feed-update__container .update-components-text",
      )
        .slice(0, 3)
        .map((el) => text(el))
        .filter(Boolean);

  // ---- layer 6: CSS (last resort) ----------------------------------------
  const pick = (selectors) => {
    for (const sel of selectors) {
      const v = text($(sel));
      if (v) return v;
    }
    return null;
  };

  const name =
    take("name", "json-ld", ld.name) ||
    take("name", "og:title", ogParts[0]) ||
    take("name", "title", titleParts[0]) ||
    take("name", "structure", structure.name) ||
    take("name", "css", pick(["h1.text-heading-xlarge", "main h1", "h1"]));

  const headline =
    take("headline", "json-ld", ld.headline) ||
    take("headline", "og:title", ogParts[1]) ||
    take("headline", "title", titleParts[1]) ||
    take("headline", "structure", structure.headline) ||
    take(
      "headline",
      "css",
      pick([".text-body-medium.break-words", "main .text-body-medium"]),
    );

  const companyName =
    take("companyName", "json-ld", ld.company) ||
    take("companyName", "aria", ariaCompany) ||
    take("companyName", "og:title", ogParts[2]) ||
    take("companyName", "title", titleParts[2]) ||
    take("companyName", "structure", structure.company) ||
    take(
      "companyName",
      "css",
      pick([
        "button[aria-label^='Current company'] span",
        "[aria-label^='Current company']",
        ".pv-text-details__right-panel-item-text",
      ]),
    );

  const location =
    take("location", "json-ld", ld.location) ||
    take("location", "structure", structure.location) ||
    take(
      "location",
      "css",
      pick([
        ".text-body-small.inline.t-black--light",
        "main .pv-text-details__left-panel .text-body-small",
      ]),
    );

  // og:description carries the About text on most profiles, and the About text
  // is most of what makes a capture worth anything to the research call.
  let bio =
    take("bio", "json-ld", ld.bio) ||
    take("bio", "og:description", meta("og:description")) ||
    take("bio", "structure", structure.bio);
  if (!bio) {
    const about = sectionMatching(/^(about|névjegy|info)/);
    const found = about
      ? text(
          $(
            ".display-flex.ph5 span[aria-hidden='true'], .inline-show-more-text, span[aria-hidden='true']",
            about,
          ),
        )
      : null;
    if (found) bio = take("bio", "css", found);
  }

  // ---- job title ---------------------------------------------------------
  // Distinct from the headline on purpose. A headline is free text and is very
  // often a slogan ("helping brands grow ↗"), while the experience block states
  // an actual role. JSON-LD's jobTitle is the same idea, so it is reused as the
  // first layer.
  let jobTitle =
    take("jobTitle", "json-ld", ld.headline) ||
    take("jobTitle", "structure", structure.jobTitle);
  if (!jobTitle) {
    const experience = sectionMatching(/^(experience|tapasztalat|munkatapasztalat)/);
    const first = experience ? $("li", experience) || experience : null;
    const found = first
      ? text($(".t-bold span[aria-hidden='true'], .mr1.t-bold span, .t-bold", first))
      : null;
    if (found) jobTitle = take("jobTitle", "css", found);
  }

  // ---- contact details ---------------------------------------------------
  // Two sources, both of them things the person published on the page we were
  // already looking at:
  //
  //   - mailto:/tel: links the page has ALREADY rendered. LinkedIn keeps the
  //     contact overlay behind a click, and clicking is automation this file
  //     does not do (see the boundary note at the top) — but if the user opened
  //     it themselves before pressing Capture, the links are simply there.
  //   - prose: an address written into the About section, headline or a post.
  //
  // Either way it appears here exactly when its owner chose to publish it.
  const published = [headline, bio, ...posts].filter(Boolean).join("\n");

  const isOwnAddress = (e) => /@(linkedin|licdn)\.com$/i.test(e);
  const linkedEmail = hrefValue("mailto");
  const emailMatch = published.match(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/);
  const email =
    (linkedEmail && !isOwnAddress(linkedEmail) ? take("email", "contact-link", linkedEmail) : null) ||
    (emailMatch && !isOwnAddress(emailMatch[0])
      ? take("email", "published-text", emailMatch[0])
      : null);

  // Hungarian and international forms: +36 1 234 5678, 06-1-234-5678,
  // +44 20 1234 5678. Requires a leading + or 0 so years and figures quoted in
  // a post are not read as phone numbers.
  const linkedPhone = hrefValue("tel");
  const phoneMatch = published.match(/(?:\+|\b0)[\d][\d\s\-().]{7,17}\d/);
  const phone =
    (linkedPhone ? take("phone", "contact-link", linkedPhone) : null) ||
    (phoneMatch ? take("phone", "published-text", phoneMatch[0]) : null);

  const websiteUrl = take("websiteUrl", "contact-link", ariaWebsite);

  // ---- photo --------------------------------------------------------------
  // The profile picture LAZY-LOADS. Until it swaps in, `src` is a 1×1
  // transparent GIF as a data: URL and the real address sits in
  // `data-delayed-url` (and, once loaded, in `srcset`). Reading `src` alone is
  // why the app showed initials for every captured lead: a data: URL is not
  // something the server can fetch, so it was refused on arrival and the photo
  // silently became a fallback avatar.
  //
  // So: consider every plausible source per <img>, take the first that is an
  // actual https address, and prefer the largest srcset entry when there is
  // one.
  const imageUrlOf = (img) =>
    attempt(null, () => {
      if (!img) return null;
      const candidates = [];
      const delayed = img.getAttribute("data-delayed-url");
      if (delayed) candidates.push(delayed);

      const srcset = img.getAttribute("srcset");
      if (srcset) {
        // "url 100w, url 200w" — widest wins, since the avatar is stored once
        // and a bigger source costs nothing at capture time.
        const entries = srcset
          .split(",")
          .map((part) => {
            const [url, size] = part.trim().split(/\s+/);
            return { url, width: Number.parseInt(size ?? "0", 10) || 0 };
          })
          .filter((e) => e.url)
          .sort((a, b) => b.width - a.width);
        for (const e of entries) candidates.push(e.url);
      }

      const src = img.getAttribute("src");
      if (src) candidates.push(src);

      for (const candidate of candidates) {
        const c = clean(candidate);
        // data: and blob: are placeholders, not photographs.
        if (!c || !/^https?:\/\//i.test(c)) continue;
        return c;
      }
      return null;
    });

  const photoFromDom = attempt(null, () => {
    // Named selectors first, then a CONTENT-based sweep: LinkedIn serves every
    // avatar from media.licdn.com under a "profile-displayphoto" path, and that
    // path has outlived several rounds of class renaming.
    const named = [
      "img.pv-top-card-profile-picture__image--show",
      "img.pv-top-card-profile-picture__image",
      ".pv-top-card__photo img",
      "main img.presence-entity__image",
      "main img[width='200']",
      'img[alt*="profile" i]',
    ];
    for (const sel of named) {
      const url = imageUrlOf($(sel));
      if (url) return url;
    }
    if (name) {
      // The avatar's alt text is the person's own name.
      const url = imageUrlOf($(`img[alt="${name.replace(/"/g, '\\"')}"]`));
      if (url) return url;
    }
    for (const img of $$("img")) {
      const url = imageUrlOf(img);
      if (url && /profile-displayphoto|profile-framedphoto/i.test(url)) return url;
    }
    return null;
  });

  const photoUrl =
    take("photoUrl", "json-ld", ld.photo) ||
    take("photoUrl", "og:image", meta("og:image")) ||
    take("photoUrl", "img", photoFromDom);

  // undefined, not null, for anything not found. JSON.stringify drops undefined
  // keys entirely, which is what "absent" should look like on the wire — and
  // null is what silently failed server validation for every profile whose DOM
  // had moved, surfacing to the user as a bare "Capture failed."
  const absent = (v) => (v === null || v === "" ? undefined : v);

  return {
    url: profileUrl(),
    name: absent(name),
    headline: absent(headline),
    companyName: absent(companyName),
    location: absent(location),
    jobTitle: absent(jobTitle),
    email: absent(email),
    phone: absent(phone),
    websiteUrl: absent(websiteUrl),
    bio: absent(bio),
    photoUrl: absent(photoUrl),
    posts,
    // Never sent to the server. The popup reads it to say what it managed to
    // read, so a layout change announces itself.
    _from: from,
  };

  function profileUrl() {
    // Strip tracking parameters so the same profile dedupes to one lead.
    try {
      const u = new URL(window.location.href);
      if (!/^\/sales\//i.test(u.pathname)) {
        return `${u.origin}${u.pathname}`.replace(/\/$/, "");
      }

      // Sales Navigator. The lead is keyed on its LinkedIn URL, and a Sales
      // Navigator address is a different string for the same human — capture
      // someone from both views and you get two leads for one person. So when
      // the page names the public profile, that is the address we key on.
      const canonical = publicProfileLink();
      if (canonical) return canonical;

      // Otherwise the sales URL, minus the search context after the first
      // comma ("…/lead/ACwAAB1234,NAME_SEARCH,abcd"), which changes with how
      // you arrived and would otherwise make every visit a new lead.
      const stable = u.pathname.split(",")[0].replace(/\/$/, "");
      return `${u.origin}${stable}`;
    } catch {
      return String(window.location.href ?? "").split("?")[0];
    }
  }

  /**
   * The public /in/ profile this page is about.
   *
   * Deliberately not "the first /in/ link on the page": a lead page also links
   * to similar leads and to colleagues, and picking one of those would file the
   * capture under the wrong person — a quiet, expensive mistake. Only two
   * things are trusted. A link that SAYS it is this person's LinkedIn profile,
   * and a link whose slug carries a piece of the name in the heading. Anything
   * less certain than that gets nothing, and the sales URL is used instead.
   */
  function publicProfileLink() {
    const candidates = [];
    for (const a of $$('a[href*="/in/"]')) {
      const href = a.getAttribute("href");
      if (!href) continue;
      let u;
      try {
        u = new URL(href, window.location.href);
      } catch {
        continue;
      }
      if (!/(^|\.)linkedin\.com$/i.test(u.hostname)) continue;
      if (!/^\/in\/[^/]+/.test(u.pathname)) continue;

      const says = `${a.getAttribute("aria-label") ?? ""} ${text(a) ?? ""}`;
      const url = `${u.origin}${u.pathname}`.replace(/\/$/, "");
      if (/linkedin profile|view.*linkedin|full profile|teljes profil/i.test(says)) return url;
      candidates.push({ url, slug: decodeURIComponent(u.pathname.slice(4).toLowerCase()) });
    }

    // Fall back to matching the slug against the name in the heading. A single
    // shared token is not enough — "anna" appears in plenty of slugs — so this
    // wants a token of real length.
    const tokens = (name ?? "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 4);
    if (tokens.length === 0) return null;

    const matched = candidates.filter((c) => tokens.some((t) => c.slug.includes(t)));
    // Exactly one, or we do not know which person this page is about.
    return matched.length === 1 ? matched[0].url : null;
  }
})();
