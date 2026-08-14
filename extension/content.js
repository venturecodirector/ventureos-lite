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
 * search results and link previews, so they change far more slowly:
 *
 *   1. JSON-LD   — the Person graph LinkedIn embeds for search engines
 *   2. meta tags — og:title / og:description / og:image, for link previews
 *   3. <title>   — "Name - Headline | LinkedIn"
 *   4. CSS       — best-effort, last resort
 *
 * It also reports WHICH layer supplied each field, so the next layout change
 * reports itself in the popup instead of looking like a silent success.
 */
(() => {
  const clean = (v) => {
    if (typeof v !== "string") return null;
    const t = v.replace(/\s+/g, " ").trim();
    return t.length === 0 ? null : t;
  };
  const text = (el) => (el ? clean(el.textContent) : null);

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
  const ld = (() => {
    const out = { name: null, headline: null, company: null, location: null, bio: null, photo: null };
    for (const tag of document.querySelectorAll('script[type="application/ld+json"]')) {
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
  })();

  // ---- layer 2: meta tags -------------------------------------------------
  const meta = (prop) => {
    const el =
      document.querySelector(`meta[property="${prop}"]`) ||
      document.querySelector(`meta[name="${prop}"]`);
    return el ? clean(el.getAttribute("content")) : null;
  };

  // og:title is usually "Nagy Anna - Ügyvezető - Danubia Kft | LinkedIn".
  const splitTitle = (s) =>
    clean(s)
      ? s.replace(/\s*\|\s*LinkedIn\s*$/i, "").split(/\s+[-–—|]\s+/).map(clean).filter(Boolean)
      : [];
  const ogParts = splitTitle(meta("og:title"));
  const titleParts = splitTitle(document.title);

  // Recent posts the person published or shared. Read from whatever the profile
  // already rendered — no scrolling and no "show more", so this is the first few
  // visible items or nothing.
  const posts = [
    ...document.querySelectorAll(
      ".feed-shared-update-v2 .update-components-text, .profile-creator-shared-feed-update__container .update-components-text",
    ),
  ]
    .slice(0, 3)
    .map((el) => text(el))
    .filter(Boolean);

  // ---- layer 4: CSS (last resort) ----------------------------------------
  const pick = (selectors) => {
    for (const sel of selectors) {
      const v = text(document.querySelector(sel));
      if (v) return v;
    }
    return null;
  };

  const name =
    take("name", "json-ld", ld.name) ||
    take("name", "og:title", ogParts[0]) ||
    take("name", "title", titleParts[0]) ||
    take("name", "css", pick(["h1.text-heading-xlarge", "main h1", "h1"]));

  const headline =
    take("headline", "json-ld", ld.headline) ||
    take("headline", "og:title", ogParts[1]) ||
    take("headline", "title", titleParts[1]) ||
    take(
      "headline",
      "css",
      pick([".text-body-medium.break-words", "main .text-body-medium"]),
    );

  const companyName =
    take("companyName", "json-ld", ld.company) ||
    take("companyName", "og:title", ogParts[2]) ||
    take("companyName", "title", titleParts[2]) ||
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
    take("bio", "json-ld", ld.bio) || take("bio", "og:description", meta("og:description"));
  if (!bio) {
    for (const section of document.querySelectorAll("section")) {
      const heading = text(section.querySelector("h2"));
      if (heading && /^(about|névjegy|info)/i.test(heading)) {
        const found = text(
          section.querySelector(
            ".display-flex.ph5 span[aria-hidden='true'], .inline-show-more-text, span[aria-hidden='true']",
          ),
        );
        if (found) {
          bio = take("bio", "css", found);
          break;
        }
      }
    }
  }

  // ---- job title ---------------------------------------------------------
  // Distinct from the headline on purpose. A headline is free text and is very
  // often a slogan ("helping brands grow ↗"), while the experience block states
  // an actual role. JSON-LD's jobTitle is the same idea, so it is reused as the
  // first layer.
  let jobTitle = take("jobTitle", "json-ld", ld.headline);
  if (!jobTitle) {
    for (const section of document.querySelectorAll("section")) {
      const heading = text(section.querySelector("h2"));
      if (!heading || !/^(experience|tapasztalat|munkatapasztalat)/i.test(heading)) continue;
      // The first entry is the current role; its bold line is the title.
      const first = section.querySelector("li");
      const found = text(
        (first || section).querySelector(
          ".t-bold span[aria-hidden='true'], .mr1.t-bold span, .t-bold",
        ),
      );
      if (found) {
        jobTitle = take("jobTitle", "css", found);
        break;
      }
    }
  }

  // ---- contact details ---------------------------------------------------
  // ONLY from text the person published on the page we already read — their
  // About section, headline and posts. LinkedIn keeps real contact details
  // behind a "Contact info" overlay that requires a click, and clicking is
  // automation this file does not do (see the boundary note at the top). So an
  // address appears here exactly when its owner chose to publish it in prose.
  const published = [headline, bio, ...posts].filter(Boolean).join("\n");

  const emailMatch = published.match(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/);
  // Ignore LinkedIn's own addresses, which appear in boilerplate rather than
  // being anybody's contact address.
  const email =
    emailMatch && !/@(linkedin|licdn)\.com$/i.test(emailMatch[0])
      ? take("email", "published-text", emailMatch[0])
      : null;

  // Hungarian and international forms: +36 1 234 5678, 06-1-234-5678,
  // +44 20 1234 5678. Requires a leading + or 0 so years and figures quoted in
  // a post are not read as phone numbers.
  const phoneMatch = published.match(/(?:\+|\b0)[\d][\d\s\-().]{7,17}\d/);
  const phone = phoneMatch ? take("phone", "published-text", phoneMatch[0]) : null;

  const photoEl =
    document.querySelector("img.pv-top-card-profile-picture__image--show") ||
    document.querySelector("main img.presence-entity__image") ||
    document.querySelector("main img[width='200']") ||
    document.querySelector('img[alt*="profile" i]');
  const photoUrl =
    take("photoUrl", "json-ld", ld.photo) ||
    take("photoUrl", "og:image", meta("og:image")) ||
    take("photoUrl", "css", photoEl && photoEl.src);


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
    bio: absent(bio),
    photoUrl: absent(photoUrl),
    posts,
    // Never sent to the server. The popup reads it to say what it managed to
    // read, so a layout change announces itself.
    _from: from,
  };

  function profileUrl() {
    // Strip tracking parameters so the same profile dedupes to one lead.
    const u = new URL(window.location.href);
    return `${u.origin}${u.pathname}`.replace(/\/$/, "");
  }
})();
