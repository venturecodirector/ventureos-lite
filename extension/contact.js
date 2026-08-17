/**
 * The contact-info overlay: email, phone, website.
 *
 * ── THE ONE FILE IN THIS EXTENSION THAT CLICKS ──────────────────────────────
 *
 * Everything else here reads a page and returns. This presses one button, and
 * that difference is deliberately confined to one file so the boundary is a fact
 * about the code rather than a promise in a comment.
 *
 * What makes it defensible, and the constraints that keep it so:
 *
 *   - It runs ONLY on an explicit capture the operator initiated. There is no
 *     path from a timer, an alarm, a navigation listener or a batch to here.
 *   - ONE profile at a time. Nothing in the extension iterates profiles, and
 *     nothing may be added that does.
 *   - It presses the button the operator would press, on the page they already
 *     have open, to see data LinkedIn is already showing THEM. It is not
 *     crawling: nothing is enumerated, discovered or followed.
 *   - It restores what it disturbed — scroll position and focus — and closes the
 *     overlay it opened.
 *
 * That is a narrower thing than automation, and it is the whole reason the
 * fields exist: the diagnostics measured zero mailto: links, zero tel: links and
 * no outbound hosts on the profile page. Contact details are not there to be
 * read. They are behind this overlay or they are nowhere.
 *
 * PARSED BY LABEL, NEVER BY POSITION. Each entry is a heading — "Email",
 * "Phone", "Website", "Birthday", "Connected" — followed by its value. A profile
 * has any subset in any order, so counting siblings would silently map a
 * birthday into a phone field the first time LinkedIn reorders anything.
 */
(async () => {
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

  // ---- if the overlay is already open, just read it -----------------------
  const already = findModal();
  if (already) {
    return { ok: true, opened: false, entries: parseModal(already), trail: ["already_open"] };
  }

  // ---- otherwise: open it, read it, put the page back --------------------
  const trail = [];
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;
  const previouslyFocused = document.activeElement;

  const trigger = (() => {
    for (const el of document.querySelectorAll("a, button")) {
      const href = el.getAttribute("href") ?? "";
      if (/\/overlay\/contact-info/i.test(href)) return el;
      const t = norm(once(el.textContent));
      if (t === "contact info" || t === "see contact info" || t === "kapcsolati adatok") return el;
    }
    return null;
  })();

  if (!trigger) return { ok: false, reason: "no_contact_info_trigger", trail };

  try {
    trigger.click();
    trail.push("clicked");
  } catch {
    return { ok: false, reason: "trigger_click_failed", trail };
  }

  // Wait for the overlay, polling rather than guessing a delay: LinkedIn fetches
  // this content, and a fixed sleep either reads too early or wastes a second.
  let modal = null;
  for (let i = 0; i < 40 && !modal; i += 1) {
    await sleep(50);
    modal = findModal();
  }
  if (!modal) {
    trail.push("modal_never_appeared");
    window.scrollTo(scrollX, scrollY);
    return { ok: false, reason: "overlay_did_not_open", trail };
  }
  trail.push("modal_open");

  const entries = parseModal(modal);

  // Close what we opened, and put the page back the way we found it. Leaving a
  // modal open over the page the operator is reading would be its own small
  // betrayal of "this only reads".
  try {
    const dismiss =
      modal.querySelector('button[aria-label*="Dismiss" i]') ||
      modal.querySelector('button[aria-label*="Close" i]') ||
      modal.querySelector('button[aria-label*="Bezár" i]');
    if (dismiss) {
      dismiss.click();
      trail.push("dismissed");
    } else {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      trail.push("escaped");
    }
  } catch {
    trail.push("dismiss_failed");
  }

  window.scrollTo(scrollX, scrollY);
  if (previouslyFocused && typeof previouslyFocused.focus === "function") {
    try {
      previouslyFocused.focus();
      trail.push("focus_restored");
    } catch {
      /* a detached element; nothing to restore to */
    }
  }

  return { ok: true, opened: true, entries, trail };
})();
