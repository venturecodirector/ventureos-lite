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
 */
(() => {
  const text = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : null);

  const pick = (selectors) => {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      const v = text(el);
      if (v) return v;
    }
    return null;
  };

  // Selectors are best-effort and will rot when LinkedIn reshuffles its DOM.
  // Everything degrades to null rather than throwing — a partial capture is
  // useful, a broken popup is not.
  const name = pick(["h1.text-heading-xlarge", "main h1", "h1"]);
  const headline = pick([".text-body-medium.break-words", "main .text-body-medium"]);
  const location = pick([".text-body-small.inline.t-black--light", "main .pv-text-details__left-panel .text-body-small"]);

  let bio = null;
  for (const section of document.querySelectorAll("section")) {
    const heading = text(section.querySelector("h2"));
    if (heading && /^(about|névjegy|info)/i.test(heading)) {
      bio = text(section.querySelector(".display-flex.ph5 span[aria-hidden='true'], .inline-show-more-text"));
      if (bio) break;
    }
  }

  const photo =
    document.querySelector("img.pv-top-card-profile-picture__image--show") ||
    document.querySelector("main img.presence-entity__image") ||
    document.querySelector("main img[width='200']");

  const posts = [...document.querySelectorAll(".feed-shared-update-v2 .update-components-text")]
    .slice(0, 3)
    .map((el) => text(el))
    .filter(Boolean);

  const companyName = pick([
    "button[aria-label^='Current company'] span",
    ".pv-text-details__right-panel-item-text",
  ]);

  // undefined, not null, for anything that was not found. JSON.stringify drops
  // undefined keys entirely, which is what "absent" should look like on the
  // wire — and null is what silently failed server validation for every profile
  // whose DOM had moved, surfacing to the user as a bare "Capture failed."
  const absent = (v) => (v === null || v === "" ? undefined : v);

  return {
    url: location_url(),
    name: absent(name),
    headline: absent(headline),
    companyName: absent(companyName),
    location: absent(location),
    bio: absent(bio),
    photoUrl: photo && photo.src ? photo.src : undefined,
    posts,
  };

  function location_url() {
    // Strip tracking parameters so the same profile dedupes to one lead.
    const u = new URL(window.location.href);
    return `${u.origin}${u.pathname}`.replace(/\/$/, "");
  }
})();
