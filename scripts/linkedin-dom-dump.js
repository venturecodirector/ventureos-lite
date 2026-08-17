/**
 * Structural dump of a LinkedIn page you are looking at.
 *
 * WHY THIS EXISTS
 *
 * The capture extension reads LinkedIn's markup, and LinkedIn changes that
 * markup without telling anyone. When it does, extraction degrades quietly:
 * the page title still yields a name, so a capture that has stopped working
 * still looks roughly like one that works. That is exactly how the headline
 * came back as the employer's name for months without anybody noticing.
 *
 * Guessing at the new markup does not work either — the fixtures we invent are
 * always tidier than the page LinkedIn ships, and a test built on a tidy
 * fixture passes while the real thing is broken. So: this prints the SHAPE of a
 * page you have open, and a fixture gets built from that.
 *
 * WHAT IT SENDS — and does not
 *
 * Structure only, by default. Every piece of text is replaced by a signature:
 * its length and what kind of characters it holds, never the characters
 * themselves. You get `«text 24, words 3, latin»`, not the person's name. The
 * point is to learn where a headline LIVES, and that question has nothing to do
 * with whose headline it is.
 *
 * The extractor's own verdict comes along — which field it found and WHICH
 * LAYER supplied it — because a field being read from the wrong layer is the
 * early warning that the right one has broken. Values are shown only for the
 * handful of fields where the value IS the structure (a URL's scheme, an
 * aria-label's prefix).
 *
 * Nothing is sent anywhere. It prints, and copies to your clipboard.
 *
 * HOW TO RUN IT
 *
 *   1. Open the LinkedIn page you want captured — an ordinary profile, or a
 *      Sales Navigator lead page.
 *   2. Open DevTools (⌥⌘I on a Mac) and pick the Console tab.
 *   3. Paste this whole file in and press Enter. Chrome may ask you to type
 *      "allow pasting" first; that warning is there for scripts that steal
 *      sessions, and reading it before you paste anything is the right habit.
 *   4. The dump is on your clipboard.
 *
 * To include the real text — only for a profile whose data you are entitled to
 * share, e.g. your own — run `__ventureDump({ redact: false })` afterwards.
 */
(() => {
  const MAX_DEPTH = 14;
  const MAX_NODES = 900;

  /** What a string is made of, without saying what it says. */
  function signature(raw) {
    const t = (raw ?? "").replace(/\s+/g, " ").trim();
    if (!t) return null;
    const kinds = [];
    if (/[a-zA-Z]/.test(t)) kinds.push("latin");
    if (/[áéíóöőúüűÁÉÍÓÖŐÚÜŰ]/.test(t)) kinds.push("hu");
    if (/\d/.test(t)) kinds.push("digits");
    if (/@/.test(t)) kinds.push("at");
    if (/[·•|]/.test(t)) kinds.push("separator");
    return `«text ${t.length}, words ${t.split(" ").length}${kinds.length ? ", " + kinds.join("+") : ""}»`;
  }

  /**
   * A URL reduced to the parts that decide whether we can use it: the scheme,
   * the host, and the shape of the path. Never the identifiers in it.
   */
  function urlShape(raw) {
    if (!raw) return null;
    if (/^data:/i.test(raw)) return `data: (${raw.length} chars)`;
    if (/^blob:/i.test(raw)) return "blob:";
    try {
      const u = new URL(raw, location.href);
      const path = u.pathname.replace(/[A-Za-z0-9_-]{12,}/g, "<id>").replace(/\d{4,}/g, "<n>");
      return `${u.protocol}//${u.hostname}${path}`;
    } catch {
      return `<unparseable ${raw.slice(0, 12)}…>`;
    }
  }

  /** The prefix of an aria-label is the contract; the rest is the value. */
  function labelShape(raw) {
    if (!raw) return null;
    const m = /^([^:]{1,40}):/.exec(raw);
    return m ? `${m[1]}: …` : signature(raw);
  }

  function describe(el, redact) {
    const out = { tag: el.tagName.toLowerCase() };
    if (el.id) out.id = el.id;

    const cls = (el.getAttribute("class") ?? "").trim();
    if (cls) {
      const names = cls.split(/\s+/);
      // Obfuscated class names are noise, but WHETHER they are obfuscated is
      // the signal — it says how much of the page is safe to select on.
      const meaningful = names.filter((n) => /^[a-z][a-z0-9-]*(--)?[a-z0-9-]*$/.test(n) && n.length <= 40);
      const hidden = names.length - meaningful.length;
      out.class =
        [meaningful.slice(0, 6).join(" "), hidden ? `<+${hidden} obfuscated>` : ""]
          .filter(Boolean)
          .join(" ") || "<none>";
    }

    const role = el.getAttribute("role");
    if (role) out.role = role;
    if (el.hasAttribute("aria-hidden")) out.ariaHidden = el.getAttribute("aria-hidden");
    const label = el.getAttribute("aria-label");
    if (label) out.ariaLabel = redact ? labelShape(label) : label;

    const data = el.getAttributeNames().filter((n) => n.startsWith("data-"));
    if (data.length) out.dataAttrs = data.slice(0, 8);

    if (out.tag === "img") {
      out.src = urlShape(el.getAttribute("src"));
      if (el.hasAttribute("data-delayed-url")) out.delayedUrl = urlShape(el.getAttribute("data-delayed-url"));
      if (el.hasAttribute("srcset")) out.srcsetEntries = el.getAttribute("srcset").split(",").length;
      const alt = el.getAttribute("alt");
      if (alt) out.alt = redact ? signature(alt) : alt;
    }
    if (out.tag === "a") out.href = urlShape(el.getAttribute("href"));

    // Text this element holds DIRECTLY, not what its children hold — that
    // distinction is the whole reason the reader had a bug.
    const own = [...el.childNodes]
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent)
      .join(" ");
    const ownText = (own ?? "").replace(/\s+/g, " ").trim();
    if (ownText) out.text = redact ? signature(ownText) : ownText;

    return out;
  }

  function walk(root, redact) {
    const nodes = [];
    let truncated = false;

    const visit = (el, depth) => {
      if (nodes.length >= MAX_NODES) {
        truncated = true;
        return;
      }
      if (depth > MAX_DEPTH) return;
      // Chrome, not content.
      if (/^(script|style|svg|path|noscript)$/i.test(el.tagName)) return;
      nodes.push({ depth, ...describe(el, redact) });
      for (const child of el.children) visit(child, depth + 1);
    };

    visit(root, 0);
    return { nodes, truncated };
  }

  window.__ventureDump = function dump(opts) {
    const redact = opts?.redact !== false;
    const main = document.querySelector("main") || document.querySelector('[role="main"]') || document.body;

    const headings = [...document.querySelectorAll("h1, h2, h3")].map((h) => {
      const raw = (h.textContent ?? "").replace(/\s+/g, " ").trim();
      // Section headings are matched by what they SAY, so "About" and
      // "Experience" come through even when redacting — a section name is not
      // personal data. The <h1> is, though: on a profile it IS the person's
      // name, and it is the one heading that must never come through in the
      // clear just because its siblings safely can.
      const personal = h.tagName.toLowerCase() === "h1";
      return {
        tag: h.tagName.toLowerCase(),
        text: redact && personal ? signature(raw) : raw.slice(0, 40),
        inMain: main.contains(h),
      };
    });

    const images = [...document.querySelectorAll("img")].slice(0, 25).map((img) => ({
      class: (img.getAttribute("class") ?? "").split(/\s+/).slice(0, 3).join(" "),
      src: urlShape(img.getAttribute("src")),
      delayedUrl: urlShape(img.getAttribute("data-delayed-url")),
      srcset: img.hasAttribute("srcset") ? img.getAttribute("srcset").split(",").length + " entries" : null,
      width: img.getAttribute("width"),
    }));

    const report = {
      dumpVersion: 1,
      pageKind: /\/sales\//.test(location.pathname)
        ? "sales-navigator"
        : /\/in\//.test(location.pathname)
          ? "public-profile"
          : "other",
      url: urlShape(location.href),
      title: redact ? signature(document.title) : document.title,
      hasMainElement: !!document.querySelector("main"),
      hasRoleMain: !!document.querySelector('[role="main"]'),
      jsonLdBlocks: document.querySelectorAll('script[type="application/ld+json"]').length,
      ogTags: [...document.querySelectorAll("meta[property^='og:']")].map((m) => m.getAttribute("property")),
      headings,
      images,
      contactLinks: {
        mailto: document.querySelectorAll('a[href^="mailto:"]').length,
        tel: document.querySelectorAll('a[href^="tel:"]').length,
      },
      ariaLabels: [...document.querySelectorAll("[aria-label]")]
        .slice(0, 40)
        .map((el) => (redact ? labelShape(el.getAttribute("aria-label")) : el.getAttribute("aria-label")))
        .filter(Boolean),
      structure: walk(main, redact),
    };

    const text = JSON.stringify(report, null, 2);
    console.log(report);
    try {
      copy(text); // DevTools' own helper
      console.log("%cCopied to the clipboard.", "color:#7427C6;font-weight:bold");
    } catch {
      console.log("Select the JSON above and copy it.");
    }
    return report;
  };

  return window.__ventureDump();
})();
