/**
 * Putting the page back. Injected alongside selectors.js.
 *
 * ── THIS FILE IS THE FIX FOR THE HANG ───────────────────────────────────────
 *
 * LinkedIn's overlays use the native popover API in `manual` state:
 *
 *     role="dialog" data-testid="popover-floating" popover="manual" inert=""
 *
 * A manual popover does NOT close on Escape and does NOT close on an outside
 * click. Those are the two dismissals every overlay-handling routine reaches for,
 * and both are no-ops here — so the capture opened something and then waited for
 * a close that could never arrive. The wait was the bug, not the opening.
 *
 * Only `element.hidePopover()` closes a manual popover. Where that is
 * unavailable (an older engine, a detached element, a jsdom test) there are two
 * fallbacks: remove the `popover` attribute, which returns the element to normal
 * flow, and failing that remove the element we opened.
 *
 * ── THE RULES ───────────────────────────────────────────────────────────────
 *
 * ONLY WHAT WE OPENED. Every close is checked against a tracked set. LinkedIn has
 * its own popovers open for its own reasons, and closing one of those would be us
 * breaking the user's page rather than tidying up after ourselves.
 *
 * IDEMPOTENT, AND RUN FROM A `finally`. Cleanup has to survive being called
 * twice, called after a throw, and called after a timeout — because those are
 * exactly the paths where the page is most likely to have been left modified.
 *
 * VERIFIED, NOT ASSUMED. `verify()` returns what is actually still open, whether
 * the URL came back, and whether focus was restored, so the diagnostics panel can
 * report the truth rather than an intention.
 */
(() => {
  /**
   * A capture session's record of what it disturbed.
   *
   * Created at the start of a capture and handed to cleanup at the end. Keeping
   * the state here rather than in module scope means two captures cannot corrupt
   * each other's idea of what to undo.
   */
  function createSession(win = window) {
    return {
      win,
      /** Popovers WE called showPopover() on. Nothing else is ever closed. */
      openedPopovers: new Set(),
      /** Elements we set `inert` on, so we remove only our own. */
      inertedByUs: new Set(),
      /** Where the page was before we touched it. */
      originalUrl: win.location.href,
      originalScrollX: win.scrollX,
      originalScrollY: win.scrollY,
      originalFocus: win.document.activeElement,
      /** True once cleanup has run to completion, so a second call is cheap. */
      cleanedUp: false,
      log: [],
    };
  }

  const note = (session, message) => {
    session.log.push(message);
  };

  /** Record that we opened a popover, so cleanup is allowed to close it. */
  function trackOpened(session, el) {
    if (el) session.openedPopovers.add(el);
    return el;
  }

  /** Open a popover the way the native API requires, and track it. */
  function openPopover(session, el) {
    if (!el) return false;
    try {
      if (typeof el.showPopover === "function") {
        el.showPopover();
        trackOpened(session, el);
        note(session, "openPopover: showPopover");
        return true;
      }
    } catch (e) {
      note(session, `openPopover: threw(${String(e?.name ?? "Error")})`);
    }
    return false;
  }

  /**
   * Close one popover, trying the three mechanisms in order of politeness.
   *
   * Returns the mechanism that worked, or null. Never throws: cleanup that can
   * throw is cleanup that does not run.
   */
  function closePopover(el) {
    if (!el) return null;
    try {
      if (typeof el.hidePopover === "function") {
        el.hidePopover();
        // hidePopover on an already-closed popover is a no-op, not an error, so
        // this is safe to call twice.
        return "hidePopover";
      }
    } catch {
      /* fall through to the attribute removal */
    }
    try {
      if (el.hasAttribute?.("popover")) {
        el.removeAttribute("popover");
        return "removeAttribute";
      }
    } catch {
      /* fall through to removal */
    }
    try {
      el.remove?.();
      return "remove";
    } catch {
      return null;
    }
  }

  /** Is this popover still showing? */
  function isOpen(el) {
    try {
      if (typeof el.matches === "function" && el.matches(":popover-open")) return true;
    } catch {
      /* :popover-open is unsupported here; fall back to the attribute */
    }
    // Without :popover-open support, treat "still has a popover attribute and is
    // in the document" as open. Conservative: it can over-report, never under.
    try {
      return !!el.isConnected && el.hasAttribute?.("popover");
    } catch {
      return false;
    }
  }

  /**
   * Undo everything, in the reverse order it was done.
   *
   * Safe to call any number of times, from a `finally`, after a throw, after a
   * timeout. Each step is independently guarded so one failure cannot prevent the
   * rest — a stuck popover must not also cost the scroll position.
   */
  async function cleanup(session, opts = {}) {
    if (!session) return { ok: true, steps: [] };
    const steps = [];
    const win = session.win;

    // 1. Popovers — ours only.
    for (const el of session.openedPopovers) {
      const how = closePopover(el);
      steps.push(`popover:${how ?? "failed"}`);
    }

    // 2. inert — only attributes we added.
    for (const el of session.inertedByUs) {
      try {
        el.removeAttribute("inert");
        steps.push("inert:removed");
      } catch {
        steps.push("inert:failed");
      }
    }

    // 3. The URL. An /overlay/ route is a real history entry, so the way back is
    //    history.back() — not clicking an X that does not exist.
    try {
      const changed = win.location.href !== session.originalUrl;
      if (changed) {
        const isOverlay = /\/overlay\//.test(win.location.pathname ?? "");
        if (isOverlay && typeof win.history?.back === "function") {
          win.history.back();
          steps.push("url:history.back");
        } else if (typeof win.history?.pushState === "function") {
          // Not an overlay route, or no back available: put the address bar back
          // where it was without a reload.
          win.history.pushState({}, "", session.originalUrl);
          steps.push("url:pushState");
        }
        // Give the SPA a moment to react, then confirm rather than assume.
        await waitFor(() => win.location.href === session.originalUrl, opts.urlTimeoutMs ?? 1500, win);
      }
      steps.push(win.location.href === session.originalUrl ? "url:restored" : "url:NOT_restored");
    } catch (e) {
      steps.push(`url:threw(${String(e?.name ?? "Error")})`);
    }

    // 4. Scroll.
    try {
      win.scrollTo(session.originalScrollX, session.originalScrollY);
      steps.push("scroll:restored");
    } catch {
      steps.push("scroll:failed");
    }

    // 5. Focus. A detached element cannot take it back, and that is not a failure
    //    worth reporting as one.
    try {
      const el = session.originalFocus;
      if (el && typeof el.focus === "function" && el.isConnected) {
        el.focus();
        steps.push("focus:restored");
      } else {
        steps.push("focus:element_gone");
      }
    } catch {
      steps.push("focus:failed");
    }

    session.cleanedUp = true;
    note(session, `cleanup: ${steps.join(" ")}`);
    return { ok: true, steps };
  }

  /**
   * What is actually true after cleanup.
   *
   * Reported rather than asserted, because "we called hidePopover" and "the
   * popover is closed" are different claims and only the second one matters.
   */
  function verify(session) {
    if (!session) return null;
    const stillOpen = [...session.openedPopovers].filter((el) => isOpen(el));
    return {
      popoversWeOpened: session.openedPopovers.size,
      stillOpen: stillOpen.length,
      inertRemaining: [...session.inertedByUs].filter((el) => {
        try {
          return el.hasAttribute?.("inert");
        } catch {
          return false;
        }
      }).length,
      urlRestored: session.win.location.href === session.originalUrl,
      scrollRestored:
        session.win.scrollX === session.originalScrollX &&
        session.win.scrollY === session.originalScrollY,
      focusRestored:
        !session.originalFocus ||
        session.win.document.activeElement === session.originalFocus ||
        !session.originalFocus.isConnected,
      cleanedUp: session.cleanedUp,
    };
  }

  /** Poll until a condition holds or the budget runs out. Never rejects. */
  function waitFor(predicate, timeoutMs, win = window) {
    return new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        let ok = false;
        try {
          ok = !!predicate();
        } catch {
          ok = false;
        }
        if (ok) return resolve(true);
        if (Date.now() - started >= timeoutMs) return resolve(false);
        win.setTimeout(tick, 50);
      };
      tick();
    });
  }

  globalThis.VentureCleanup = {
    createSession,
    trackOpened,
    openPopover,
    closePopover,
    isOpen,
    cleanup,
    verify,
    waitFor,
  };
})();
