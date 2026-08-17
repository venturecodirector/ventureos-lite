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
  const C = globalThis.VentureContact;
  if (!C) return { ok: false, reason: "contact_parse_module_not_injected", trail: [] };
  const { findModal, findTrigger, parseModal } = C;
  const clean = (v) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

  const startUrl = window.location.href;
  const trigger = findTrigger();

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

  /**
   * Close what we opened — AND PUT THE URL BACK.
   *
   * This is the bug that corrupted the next capture. The trigger is an ANCHOR to
   * `/in/<slug>/overlay/contact-info/`, so clicking it NAVIGATES: the address bar
   * is now an overlay route and that is a real history entry. The old close path
   * pressed a Dismiss button if it found one and otherwise dispatched Escape —
   * and Escape is a documented no-op against `popover="manual"`, which is what
   * LinkedIn uses here. So the overlay stayed up, the URL stayed on
   * `/overlay/contact-info/`, and the extraction that ran next read a page that
   * was not a profile. That is the reported `probes.url` ending in `/overlay/`,
   * the absent top card, and the five identities counted out of dialog content.
   *
   * The order below is what actually works: hidePopover() first (the only thing
   * that closes a manual popover), then history.back() because the overlay is a
   * route rather than a widget, then the button as a courtesy for the non-popover
   * case. Verified afterwards rather than assumed.
   */
  const CU = globalThis.VentureCleanup ?? null;
  try {
    if (CU) {
      const how = CU.closePopover(modal);
      trail.push(`closed:${how ?? "no_mechanism"}`);
    } else if (typeof modal.hidePopover === "function") {
      modal.hidePopover();
      trail.push("closed:hidePopover");
    }
  } catch {
    trail.push("close_failed");
  }

  // The URL, which the click changed. Only ever back to where we started.
  try {
    if (window.location.href !== startUrl) {
      if (/\/overlay\//.test(window.location.pathname ?? "") && window.history?.back) {
        window.history.back();
        trail.push("url:history.back");
      } else if (window.history?.replaceState) {
        window.history.replaceState({}, "", startUrl);
        trail.push("url:replaceState");
      }
      for (let i = 0; i < 20 && window.location.href !== startUrl; i += 1) await sleep(50);
    }
    trail.push(window.location.href === startUrl ? "url:restored" : "url:NOT_restored");
  } catch {
    trail.push("url:threw");
  }

  // The dismiss button too, for the case where the overlay is not a popover at
  // all. Harmless when it has already gone.
  try {
    const dismiss =
      modal.querySelector('button[aria-label*="Dismiss" i]') ||
      modal.querySelector('button[aria-label*="Close" i]') ||
      modal.querySelector('button[aria-label*="Bezár" i]');
    if (dismiss && modal.isConnected) {
      dismiss.click();
      trail.push("dismissed");
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

  return {
    ok: true,
    opened: true,
    entries,
    trail,
    urlRestored: window.location.href === startUrl,
  };
})();
