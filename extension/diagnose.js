/**
 * Why did the capture read so little?
 *
 * The popup names the LAYER behind each field it read, which is enough to tell
 * you something broke and useless for telling you what. This answers the next
 * question: it re-runs the same probes the reader uses and reports what each
 * one SAW — was there an <h1>, which sections were found and under what
 * heading, how many lines the top card yielded, what the images look like.
 *
 * That difference matters because the alternative is guessing. LinkedIn's
 * markup cannot be checked from outside — it needs a signed-in session on a
 * real profile — so a fix written without this is a fix written blind, and a
 * fixture invented to match a guess passes while the real page stays broken.
 *
 * WHAT IT REPORTS: shapes, never content. Text is replaced by a signature —
 * `«text 24, words 3»` — so the report says where a headline LIVES without
 * saying whose it is. Section headings ("About", "Tapasztalat") come through,
 * because matching them by name is exactly the mechanism under test and a
 * section name is not personal data. URLs are reduced to scheme, host and a
 * path with the identifiers masked.
 *
 * It reads. It does not click, scroll, expand or fetch anything, and it runs
 * only when the button is pressed — the same boundary as content.js.
 */
(() => {
  const clean = (v) => {
    if (typeof v !== "string") return null;
    const t = v.replace(/\s+/g, " ").trim();
    return t.length === 0 ? null : t;
  };

  /** What a string is made of, without saying what it says. */
  const sig = (raw) => {
    const t = clean(raw);
    if (!t) return null;
    const kinds = [];
    if (/[a-zA-Z]/.test(t)) kinds.push("latin");
    if (/[áéíóöőúüűÁÉÍÓÖŐÚÜŰ]/.test(t)) kinds.push("hu");
    if (/\d/.test(t)) kinds.push("digits");
    if (/@/.test(t)) kinds.push("at");
    return `«${t.length}c ${t.split(" ").length}w${kinds.length ? " " + kinds.join("+") : ""}»`;
  };

  /**
   * A heading, de-doubled. LinkedIn renders many labels twice — once for sight,
   * once for screen readers — so raw textContent gives "AboutAbout", and a
   * heading match anchored with ^ would still work while one testing equality
   * would not. Reported in its real form so the ambiguity is visible.
   */
  const headingText = (el) => {
    if (!el) return null;
    const raw = clean(el.textContent);
    if (!raw) return null;
    const half = raw.slice(0, raw.length / 2);
    return half.length > 0 && half + half === raw ? half : raw;
  };

  const urlShape = (raw) => {
    if (!raw) return null;
    if (/^data:/i.test(raw)) return `data: (${raw.length}c)`;
    if (/^blob:/i.test(raw)) return "blob:";
    try {
      const u = new URL(raw, location.href);
      const path = u.pathname.replace(/[A-Za-z0-9_-]{10,}/g, "<id>").replace(/\d{4,}/g, "<n>");
      const params = [...u.searchParams.keys()].join(",");
      return `${u.protocol}//${u.hostname}${path}${params ? `?${params}` : ""}`;
    } catch {
      return `<unparseable, ${raw.length}c>`;
    }
  };

  const q = (sel, root) => {
    try {
      return (root ?? document).querySelector(sel);
    } catch {
      return null;
    }
  };
  const qa = (sel, root) => {
    try {
      return [...(root ?? document).querySelectorAll(sel)];
    } catch {
      return [];
    }
  };

  const main = q("main") || q('[role="main"]') || document.body;

  // -- probe 1: the heading the whole top card hangs off -------------------
  const h1InMain = q("h1", main);
  const h1Anywhere = q("h1");
  const roleHeading = q('[role="heading"][aria-level="1"]');

  // -- probe 2: the top card, walked up from whatever names the person -----
  const anchor = h1InMain || h1Anywhere || roleHeading;
  const cardTrail = [];
  if (anchor) {
    let node = anchor.parentElement;
    for (let depth = 0; node && depth < 8 && node !== main && node !== document.body; depth += 1) {
      const lines = [];
      const seen = new Set();
      for (const n of qa("p, span, div, li, h1, h2, h3, a", node)) {
        const t = clean(n.textContent);
        if (!t || seen.has(t)) continue;
        seen.add(t);
        lines.push(t);
      }
      const distinct = lines.filter((l) => !lines.some((o) => o !== l && l.includes(o)));
      cardTrail.push({
        depth,
        tag: node.tagName.toLowerCase(),
        distinctLines: distinct.length,
        sample: distinct.slice(0, 6).map(sig),
      });
      node = node.parentElement;
    }
  }

  // -- probe 3: sections, as the reader looks for them ---------------------
  const sections = [];
  for (const el of qa("section, article", main)) {
    const h = headingText(q("h2, h3", el));
    sections.push({
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      heading: h ? h.slice(0, 40) : null,
      liCount: qa("li", el).length,
      nested: qa("section, article", el).length,
    });
  }
  const idAnchors = ["about", "experience", "education", "skills"].map((id) => ({
    id,
    present: !!q(`#${id}`, main),
  }));

  // -- probe 4: the aria contract the employer is read from ----------------
  const ariaLabels = qa("[aria-label]")
    .map((el) => clean(el.getAttribute("aria-label")))
    .filter(Boolean)
    .map((l) => {
      const m = /^([^:]{1,40}):/.exec(l);
      return m ? `${m[1]}: …` : sig(l);
    })
    .slice(0, 30);

  // -- probe 5: images, and which source actually holds a real address -----
  const images = qa("img")
    .slice(0, 20)
    .map((img) => ({
      cls: (img.getAttribute("class") || "").split(/\s+/).filter(Boolean).slice(0, 2).join(" ") || null,
      w: img.getAttribute("width"),
      src: urlShape(img.getAttribute("src")),
      delayed: urlShape(img.getAttribute("data-delayed-url")),
      srcsetParts: img.getAttribute("srcset") ? img.getAttribute("srcset").split(",").length : 0,
      alt: sig(img.getAttribute("alt")),
    }))
    .filter((i) => i.src || i.delayed || i.srcsetParts);

  // -- probe 6: contact links already on the page --------------------------
  const contact = {
    mailto: qa('a[href^="mailto:"]').length,
    tel: qa('a[href^="tel:"]').length,
    outboundHosts: [
      ...new Set(
        qa('a[href^="http"]')
          .map((a) => {
            try {
              return new URL(a.getAttribute("href"), location.href).hostname;
            } catch {
              return null;
            }
          })
          .filter((h) => h && !/(^|\.)(linkedin\.com|licdn\.com)$/i.test(h)),
      ),
    ].slice(0, 10),
  };

  return {
    diagnoseVersion: 2,
    pageKind: /\/sales\//.test(location.pathname)
      ? "sales-navigator"
      : /\/in\//.test(location.pathname)
        ? "public-profile"
        : "other",
    url: urlShape(location.href),
    lang: document.documentElement.getAttribute("lang"),
    title: sig(document.title),
    hasMain: !!q("main"),
    hasRoleMain: !!q('[role="main"]'),
    jsonLd: qa('script[type="application/ld+json"]').length,
    ogTags: qa("meta[property^='og:']").map((m) => m.getAttribute("property")),
    heading: {
      h1InMain: !!h1InMain,
      h1Anywhere: !!h1Anywhere,
      h1Text: sig(h1Anywhere && h1Anywhere.textContent),
      roleHeadingLevel1: !!roleHeading,
      totalH1: qa("h1").length,
    },
    cardTrail,
    sections,
    idAnchors,
    ariaLabels,
    images,
    contact,
  };
})();
