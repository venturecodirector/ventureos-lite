/**
 * Reading the contact-info overlay: the pure half.
 *
 * Split out of contact.js so the state machine can reuse the PARSER without
 * reusing the clicking. There must be exactly one implementation of "which label
 * means phone" — two would drift, and a birthday landing in a phone field is the
 * failure this file's label-based parsing exists to prevent.
 *
 * Nothing here touches the page: no clicks, no navigation, no waiting. That is
 * what makes it safe to inject anywhere, and what lets the committed overlay
 * fixture exercise it in jsdom.
 *
 * PARSED BY LABEL, NEVER BY POSITION. Each entry is a heading — "Email", "Phone",
 * "Website", "Birthday", "Connected" — followed by its value. A profile has any
 * subset in any order, so counting siblings would silently map a birthday into a
 * phone field the first time LinkedIn reorders anything.
 */
(() => {
  const clean = (v) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
  const norm = (s) =>
    clean(s)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();

  /** A label said once — LinkedIn renders most of them twice. */
  const once = (raw) => {
    const t = clean(raw);
    if (!t) return "";
    const half = t.slice(0, t.length / 2);
    return half.length > 0 && half + half === t ? half : t;
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** The label vocabulary, English and Hungarian. */
  const LABELS = {
    email: ["email", "e-mail", "email address", "e-mail cim"],
    phone: ["phone", "phone number", "telefon", "telefonszam"],
    website: ["website", "websites", "weboldal", "webhely"],
    address: ["address", "cim"],
    birthday: ["birthday", "szuletesnap"],
    connected: ["connected", "connected since", "kapcsolat letrejotte"],
    im: ["im", "instant messaging"],
    profile: ["profile", "profil"],
  };

  const labelKind = (heading) => {
    const k = norm(heading).replace(/[’']s\b/g, "").replace(/\s+/g, " ").trim();
    for (const [kind, names] of Object.entries(LABELS)) {
      if (names.some((n) => k === n || k.startsWith(`${n} `) || k.endsWith(` ${n}`))) return kind;
    }
    // "Kovács Anna's Profile" — the owner's own link, which we already have.
    if (/\bprofile$|\bprofil$/.test(k)) return "profile";
    return null;
  };

  /** The overlay, if it is on screen. */
  const findModal = () => {
    for (const el of document.querySelectorAll('[role="dialog"], .artdeco-modal')) {
      const heading = norm(once(el.querySelector("h1, h2")?.textContent ?? ""));
      if (/contact info|kapcsolati adatok/.test(heading)) return el;
      if (el.querySelector('a[href^="mailto:"], a[href^="tel:"]')) return el;
    }
    return null;
  };

  /**
   * Read an open overlay. Separated from the clicking on purpose: this half is
   * pure DOM reading, which is what the committed fixture exercises in jsdom.
   */
  const parseModal = (modal) => {
    const out = { email: [], phone: [], website: [], other: {} };
    if (!modal) return out;

    // Each section is a heading plus whatever follows it, so walk the headings
    // and take their containing section rather than guessing at sibling counts.
    for (const h of modal.querySelectorAll("h3, h2, dt, .pv-contact-info__header")) {
      const kind = labelKind(once(h.textContent));
      if (!kind) continue;
      const section = h.closest("section, li, div") ?? h.parentElement;
      if (!section) continue;

      if (kind === "email") {
        for (const a of section.querySelectorAll('a[href^="mailto:"]')) {
          out.email.push(clean(decodeURIComponent(a.getAttribute("href").slice(7).split("?")[0])));
        }
        if (out.email.length === 0) {
          const t = once(section.textContent).replace(/^[^:]*:?\s*/, "");
          const m = /[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+/.exec(t);
          if (m) out.email.push(m[0]);
        }
      } else if (kind === "phone") {
        for (const a of section.querySelectorAll('a[href^="tel:"]')) {
          out.phone.push({ raw: clean(a.getAttribute("href").slice(4)), qualifier: null });
        }
        for (const li of section.querySelectorAll("li")) {
          const t = once(li.textContent);
          const m = /(?:\+|\b0)[\d][\d\s\-()/.]{6,17}\d/.exec(t);
          if (m) out.phone.push({ raw: m[0], qualifier: t });
        }
        if (out.phone.length === 0) {
          const t = once(section.textContent);
          const m = /(?:\+|\b0)[\d][\d\s\-()/.]{6,17}\d/.exec(t);
          if (m) out.phone.push({ raw: m[0], qualifier: t });
        }
      } else if (kind === "website") {
        for (const a of section.querySelectorAll('a[href^="http"]')) {
          const container = a.closest("li") ?? a.parentElement;
          out.website.push({
            url: clean(a.getAttribute("href")),
            qualifier: container ? once(container.textContent) : null,
          });
        }
      } else {
        out.other[kind] = once(section.textContent);
      }
    }
    return out;
  };

  const findTrigger = () => {
    for (const el of document.querySelectorAll("a, button")) {
      const href = el.getAttribute("href") ?? "";
      if (/\/overlay\/contact-info/i.test(href)) return el;
      const t = norm(once(el.textContent));
      if (t === "contact info" || t === "see contact info" || t === "kapcsolati adatok") return el;
    }
    return null;
  };

  /**
   * Published so the state machine can reuse the PARSER without reusing the
   * clicking. There must be exactly one implementation of "which label means
   * phone" — two would drift, and a birthday landing in a phone field is the
   * failure this file's label-based parsing exists to prevent.
   */
  globalThis.VentureContact = { findModal, findTrigger, parseModal, labelKind };

})();
