/**
 * The capture state machine. Injected with selectors.js, names.js, cleanup.js
 * and contact.js, before content.js reads the page.
 *
 * ── WHY A MACHINE AND NOT A FUNCTION THAT DOES THE STEPS ────────────────────
 *
 * Because the previous version was a function that did the steps, and when one of
 * them left the page on an overlay route, nothing noticed. The capture that ran
 * next read `/in/<id>/overlay/<id>/` as if it were a profile: no top card, five
 * identities counted out of dialog content, a page title naming the overlay
 * instead of the person. One un-undone side effect corrupted every field of the
 * following capture, and the only evidence was a diagnostics dump where every
 * value was wrong in a different way.
 *
 * So the shape here is not decoration. It buys four specific things:
 *
 *   GUARANTEED CLEANUP. Every step runs inside one try/finally. Cleanup closes
 *   only popovers WE opened, removes only inert attributes WE set, and restores
 *   the URL, scroll and focus — then VERIFIES all of it and reports what is
 *   actually true rather than what was attempted.
 *
 *   A PRECONDITION THAT CANNOT BE SKIPPED. Extraction is only ever reached from a
 *   canonical profile route. If the page is on an overlay or a sub-route, the
 *   machine navigates back and waits for the top card before anything else runs.
 *   content.js refuses independently, so this failing is survivable rather than
 *   silent.
 *
 *   A FAILING STEP COSTS ITS OWN FIELDS AND NOTHING ELSE. Each step has its own
 *   timeout and its own recorded reason. Contact info being unreadable must not
 *   cost the bio, and no step may abort the save.
 *
 *   AN ACCOUNT OF ITSELF. Transitions, per-step timings and outcomes come back as
 *   data, so a thin capture can be explained weeks later from the lead itself.
 *
 * ── WHAT IT MUST NEVER BECOME ───────────────────────────────────────────────
 *
 * It presses two things: the Contact-info link the operator would press, and the
 * About section's "see more". It scrolls the page they are already looking at. It
 * runs once, on one profile, because a human clicked. There is no path here from
 * a timer, an alarm, a navigation event or a list of profiles, and none may be
 * added: that is the line between this and a crawler.
 */
(() => {
  /** Every state, in the order they are attempted. */
  const STATES = [
    "IDLE",
    "ENSURE_ROUTE",
    // The new primary path: what the page already fetched, before the DOM is
    // consulted at all.
    "COLLECT_OBSERVED",
    "NORMALIZE",
    "READ_TOPCARD",
    "OPEN_CONTACT",
    "READ_CONTACT",
    "CLOSE_CONTACT",
    "EXPAND_BIO",
    "LOAD_SECTIONS",
    "READ_POSTS",
    "UPLOAD",
    "DONE",
    "FAILED",
  ];

  /**
   * Per-step budgets, and the one that matters most: the global watchdog.
   *
   * 20 seconds total. The hang this replaces was an unbounded wait for a manual
   * popover to close on Escape, which it never does — so the deadline is not a
   * performance tweak, it is the thing that makes "the popup froze" impossible.
   */
  const DEFAULTS = {
    globalMs: 28_000,
    routeMs: 3_000,
    topcardMs: 4_000,
    openContactMs: 4_000,
    readContactMs: 1_000,
    closeContactMs: 3_000,
    expandBioMs: 2_500,
    /**
     * 12 seconds, and the global watchdog is raised to match.
     *
     * The old 6s with two 600px steps gave up after 450ms on a page whose
     * Experience section is further down than that. Lazy columns need depth AND
     * settle time; this step is the slowest one by design.
     */
    loadSectionsMs: 12_000,
    readPostsMs: 1_000,
    collectObservedMs: 1_500,
    normalizeMs: 1_000,
    /** LOAD_SECTIONS scrolling. */
    scrollStepPx: 800,
    scrollMaxSteps: 24,
    // At least 400ms: LinkedIn fetches, THEN renders, and a shorter wait samples
    // the gap between the two and reads it as "nothing mounted".
    scrollSettleMs: 400,
  };

  const now = () => Date.now();
  const sleep = (ms, win) => new Promise((r) => (win ?? window).setTimeout(r, ms));

  const clean = (v) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
  const once = (raw) => {
    const t = clean(raw);
    if (!t) return "";
    const half = t.slice(0, t.length / 2);
    return half.length > 0 && half + half === t ? half : t;
  };
  const norm = (s) =>
    clean(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

  /**
   * Run a promise with a deadline. Resolves either way — a step that times out is
   * a recorded outcome, never a rejection that escapes the machine.
   */
  function withTimeout(promise, ms, win) {
    return new Promise((resolve) => {
      let settled = false;
      const timer = (win ?? window).setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve({ timedOut: true, value: undefined });
        }
      }, ms);
      Promise.resolve(promise).then(
        (value) => {
          if (settled) return;
          settled = true;
          (win ?? window).clearTimeout(timer);
          resolve({ timedOut: false, value });
        },
        (error) => {
          if (settled) return;
          settled = true;
          (win ?? window).clearTimeout(timer);
          resolve({ timedOut: false, error });
        },
      );
    });
  }

  /** Poll until a predicate holds. Never rejects. */
  function waitFor(predicate, timeoutMs, win) {
    const w = win ?? window;
    return new Promise((resolve) => {
      const started = now();
      const tick = () => {
        let ok = false;
        try {
          ok = !!predicate();
        } catch {
          ok = false;
        }
        if (ok) return resolve(true);
        if (now() - started >= timeoutMs) return resolve(false);
        w.setTimeout(tick, 40);
      };
      tick();
    });
  }

  const CANONICAL_PROFILE = /^\/in\/[^/]+\/?$/;
  const SALES_LEAD = /^\/sales\/(lead|people)\//i;

  const isCanonical = (win) => {
    const p = win.location.pathname ?? "";
    return CANONICAL_PROFILE.test(p) || SALES_LEAD.test(p);
  };

  /** The canonical profile URL for whatever route we are on. */
  const canonicalUrl = (win) => {
    const m = /^\/in\/([^/]+)/.exec(win.location.pathname ?? "");
    if (!m) return null;
    return `${win.location.origin}/in/${m[1]}/`;
  };

  /** Section headings currently in the document, folded. */
  function sectionHeadings(doc) {
    const out = new Set();
    for (const el of doc.querySelectorAll("section, article")) {
      const h = once(el.querySelector("h1, h2, h3")?.textContent ?? "");
      if (h) out.add(norm(h));
    }
    return out;
  }

  /**
   * Written as `/\bword\b/` rather than `/(^|\b)word(\b|$)/`: the latter puts an
   * open paren straight after the word, which the extension's static
   * "calls-nothing-it-has-not-defined" check reads as a function call. Same
   * meaning, and it keeps that check free of false positives.
   */
  const WANTED_SECTIONS = [/\bexperience\b/, /\btapasztalat/, /\beducation\b/, /\btanulmany/];
  const hasWantedSections = (doc) => {
    const heads = [...sectionHeadings(doc)];
    return WANTED_SECTIONS.some((re) => heads.some((h) => re.test(h)));
  };

  /**
   * Is the top card there?
   *
   * The componentkey'd photo anchor when the selector layer is available, and
   * otherwise any anchor to the owner's own slug that holds an image. Both are
   * landmarks rather than layout guesses.
   */
  function topcardPresent(doc, win) {
    const S = globalThis.VentureSelectors ?? null;
    if (S && typeof S.topcardPhotoAnchor === "function") {
      try {
        if (S.topcardPhotoAnchor(doc)) return true;
      } catch {
        /* fall through to the structural check */
      }
    }
    const m = /^\/in\/([^/]+)/.exec(win.location.pathname ?? "");
    if (!m) return !!doc.querySelector("main a img, [role=main] a img");
    const slug = m[1].toLowerCase();
    for (const a of doc.querySelectorAll('a[href*="/in/"]')) {
      const href = (a.getAttribute("href") ?? "").toLowerCase();
      if (href.includes(`/in/${slug}`) && a.querySelector("img")) return true;
    }
    return false;
  }

  /** The About section's expandable box and its reveal button. */
  function aboutBox(doc) {
    for (const section of doc.querySelectorAll("section, article")) {
      const h = norm(once(section.querySelector("h1, h2, h3")?.textContent ?? ""));
      if (!/^(about|nevjegy|info)/.test(h)) continue;
      const box = section.querySelector('[data-testid="expandable-text-box"]');
      if (box) return { box, button: box.querySelector('[data-testid="expandable-text-button"]') };
    }
    return { box: null, button: null };
  }

  /**
   * Run a capture.
   *
   * Returns the machine's own account of itself plus whatever the steps gathered.
   * NEVER throws and NEVER returns null: the caller must always be able to save a
   * lead with what came back, because a capture that read only half a profile is
   * still worth more than nothing, and refusing to save is how an operator loses
   * a lead they watched the extension find.
   */
  async function run(options = {}) {
    const opts = { ...DEFAULTS, ...options };
    const win = opts.window ?? window;
    const doc = opts.document ?? win.document;
    const CU = globalThis.VentureCleanup ?? null;

    const started = now();
    const deadline = started + opts.globalMs;
    const outOfTime = () => now() >= deadline;

    const record = {
      version: 3,
      startedAt: started,
      states: STATES,
      state: "IDLE",
      transitions: [],
      steps: [],
      timings: {},
      watchdogMs: opts.globalMs,
      watchdogFired: false,
      ok: false,
    };

    const goto = (state) => {
      record.transitions.push({ from: record.state, to: state, atMs: now() - started });
      record.state = state;
    };

    /**
     * One step: timed, deadlined, and unable to take the others down with it.
     *
     * `reason` is recorded on failure and the machine moves on. The only thing a
     * step can do to the run as a whole is use up the global budget.
     */
    const step = async (name, budgetMs, fn) => {
      goto(name);
      if (outOfTime()) {
        record.watchdogFired = true;
        record.steps.push({ name, ok: false, reason: "watchdog_expired_before_step", ms: 0 });
        record.timings[name] = 0;
        return { ok: false, reason: "watchdog_expired_before_step" };
      }
      const at = now();
      const budget = Math.max(1, Math.min(budgetMs, deadline - at));
      const res = await withTimeout(fn(), budget, win);
      const ms = now() - at;
      record.timings[name] = ms;
      if (res.timedOut) {
        record.steps.push({ name, ok: false, reason: "step_timed_out", ms });
        return { ok: false, reason: "step_timed_out" };
      }
      if (res.error) {
        const reason = `threw_${String(res.error?.name ?? "Error")}`;
        /**
         * The MESSAGE too, not just the constructor name.
         *
         * `threw_TypeError` alone says a step broke and nothing about where, which
         * made a genuine bug in LOAD_SECTIONS indistinguishable from a dozen other
         * possibilities. Truncated, because a stack is not diagnostics.
         */
        const message = String(res.error?.message ?? "").slice(0, 160);
        record.steps.push({ name, ok: false, reason, ms, detail: { message } });
        return { ok: false, reason };
      }
      const value = res.value ?? {};
      const ok = value.ok !== false;
      record.steps.push({ name, ok, reason: value.reason ?? null, ms, detail: value.detail ?? null });
      return { ok, reason: value.reason ?? null, detail: value.detail, value };
    };

    const session = CU ? CU.createSession(win) : null;
    const gathered = {
      contact: null,
      contactTrail: [],
      bio: null,
      sections: null,
      /** The observer's own state, for diagnostics v4. */
      observer: null,
      /** Raw observed records for this profile. */
      observed: [],
      /** What the API mapping produced, once there is a mapping. */
      api: null,
    };

    try {
      // ---- ENSURE_ROUTE ---------------------------------------------------
      /**
       * The precondition. Nothing else may run from the wrong route.
       *
       * history.back() first, because an /overlay/ URL is a real history entry
       * and going back is what actually leaves it. Then a replaceState to the
       * canonical slug for the case where there is no history to go back to (a
       * tab opened directly on an overlay link).
       */
      await step("ENSURE_ROUTE", opts.routeMs, async () => {
        if (isCanonical(win)) return { ok: true, detail: { already: true } };
        const target = canonicalUrl(win);
        const trail = [];
        if (typeof win.history?.back === "function") {
          win.history.back();
          trail.push("history.back");
          /**
           * A FRACTION of the step's budget, not all of it.
           *
           * Waiting the full `routeMs` here is a bug I wrote and this test caught:
           * the step then timed out before the replaceState fallback could run, so
           * a page with no history to go back to — a tab opened directly on an
           * overlay link, and every jsdom test — could never be recovered. The
           * fallback must always get its turn.
           */
          await waitFor(() => isCanonical(win), Math.max(60, Math.floor(opts.routeMs * 0.4)), win);
        }
        if (!isCanonical(win) && target && typeof win.history?.replaceState === "function") {
          win.history.replaceState({}, "", target);
          trail.push("replaceState");
          await waitFor(() => isCanonical(win), Math.max(60, Math.floor(opts.routeMs * 0.3)), win);
        }
        if (!isCanonical(win)) {
          return { ok: false, reason: "could_not_return_to_canonical_route", detail: { trail } };
        }
        /**
         * REBASE THE CLEANUP BASELINE.
         *
         * The session recorded the URL we arrived on, and cleanup's job is to put
         * that back. But we arrived on a broken overlay route and have just
         * corrected it — restoring the original would hand the operator back the
         * very state this step exists to escape, and leave the next capture
         * reading an overlay again. The corrected route is the new baseline.
         */
        if (session) {
          session.originalUrl = win.location.href;
          trail.push("cleanup_baseline_rebased");
        }
        return { ok: true, detail: { trail, url: win.location.href } };
      });

      // Everything past here is pointless off-route, and dangerous: it is how a
      // dialog's contents became a lead's fields.
      const onRoute = isCanonical(win);

      // ---- COLLECT_OBSERVED -----------------------------------------------
      /**
       * What did the page already fetch for this profile?
       *
       * Usually everything we need, and usually before the user pressed anything:
       * LinkedIn's own frontend requests the profile's data on load, and the
       * observer copied it. No request of ours is involved at any point.
       *
       * The one case that needs a human decision is an EMPTY buffer, which means
       * the page loaded before the observer was installed — a fresh install, an
       * extension update, or a tab that has been open since before either. That is
       * a soft reload away from working, and saying so is much better than
       * silently dropping to the DOM path and leaving the operator wondering why
       * the capture is thin.
       */
      await step("COLLECT_OBSERVED", opts.collectObservedMs, async () => {
        const O = globalThis.VentureObserved ?? null;
        if (!O) {
          return { ok: false, reason: "observer_bridge_not_present" };
        }
        const status = O.status();
        gathered.observer = status;
        if (!status.installed) {
          return { ok: false, reason: "observer_not_installed_reload_the_page" };
        }
        const records = O.take();
        gathered.observed = records;
        return records.length > 0
          ? { ok: true, detail: { records: records.length, inventory: status.inventory } }
          : {
              ok: false,
              reason: "buffer_empty_page_loaded_before_observer",
              detail: { inventory: status.inventory },
            };
      });

      // ---- NORMALIZE --------------------------------------------------------
      /**
       * Turn observed responses into fields.
       *
       * NOT YET IMPLEMENTED, and reported as such rather than silently skipped.
       * The mapping from LinkedIn's JSON to our fields is derived from RECORDED
       * snapshots, and there are none — see test/fixtures/linkedin-api/README.md.
       * Writing it from the shape one would expect is the exact mistake this
       * re-architecture exists to stop making.
       *
       * Until then this step always reports `mapping_not_yet_derived`, and the DOM
       * steps below carry the capture exactly as they do today. That is the
       * fallback working as designed: the feature keeps running while the primary
       * path is built.
       */
      await step("NORMALIZE", opts.normalizeMs, async () => {
        const records = gathered.observed ?? [];
        if (records.length === 0) {
          return { ok: false, reason: "nothing_observed_to_normalize" };
        }
        const N = globalThis.VentureNormalizeApi ?? null;
        if (!N || typeof N.normalize !== "function") {
          return {
            ok: false,
            reason: "mapping_not_yet_derived",
            detail: { observedRecords: records.length },
          };
        }
        const result = N.normalize(records);
        gathered.api = result;
        const count = Object.keys(result?.fields ?? {}).length;
        return count > 0
          ? { ok: true, detail: { fields: count } }
          : { ok: false, reason: "mapping_matched_nothing", detail: { observedRecords: records.length } };
      });

      // ---- READ_TOPCARD ---------------------------------------------------
      await step("READ_TOPCARD", opts.topcardMs, async () => {
        if (!onRoute) return { ok: false, reason: "not_on_canonical_route" };
        const found = await waitFor(() => topcardPresent(doc, win), opts.topcardMs, win);
        return found ? { ok: true } : { ok: false, reason: "topcard_never_appeared" };
      });

      // ---- OPEN_CONTACT ---------------------------------------------------
      let modal = null;
      /** Did WE open it? Cleanup and CLOSE_CONTACT are allowed to act only if so. */
      let weOpenedIt = false;
      await step("OPEN_CONTACT", opts.openContactMs, async () => {
        if (!onRoute) return { ok: false, reason: "not_on_canonical_route" };
        const C = globalThis.VentureContact ?? null;
        if (!C) return { ok: false, reason: "contact_module_not_injected" };

        const already = C.findModal();
        if (already) {
          // Somebody else's popover — LinkedIn's, or the operator's own. Read it,
          // but it is not ours to close: doing so would be us breaking the page
          // the operator is using rather than tidying up after ourselves.
          modal = already;
          return { ok: true, detail: { already: true, weOpenedIt: false } };
        }
        const trigger = C.findTrigger();
        if (!trigger) return { ok: false, reason: "no_contact_info_trigger" };

        // The trigger is an anchor to /overlay/contact-info/, so this NAVIGATES.
        // Recorded before the click, so cleanup knows to put the URL back even if
        // everything after this throws.
        gathered.contactTrail.push("clicked");
        trigger.click();
        const appeared = await waitFor(
          () => !!C.findModal(),
          Math.max(120, Math.floor(opts.openContactMs * 0.8)),
          win,
        );
        modal = C.findModal();
        if (modal) {
          weOpenedIt = true;
          if (session && CU) CU.trackOpened(session, modal);
        }
        return appeared && modal
          ? { ok: true, detail: { weOpenedIt: true } }
          : { ok: false, reason: "overlay_did_not_open" };
      });

      // ---- READ_CONTACT ---------------------------------------------------
      await step("READ_CONTACT", opts.readContactMs, async () => {
        const C = globalThis.VentureContact ?? null;
        if (!C || !modal) return { ok: false, reason: "no_overlay_to_read" };
        const entries = C.parseModal(modal);
        gathered.contact = entries;
        const count =
          (entries.email?.length ?? 0) +
          (entries.phone?.length ?? 0) +
          (entries.website?.length ?? 0);
        return count > 0
          ? { ok: true, detail: { count } }
          : { ok: false, reason: "overlay_had_no_contact_details", detail: { count: 0 } };
      });

      // ---- CLOSE_CONTACT --------------------------------------------------
      /**
       * Closed HERE and not left to cleanup, so the steps after it read a profile
       * rather than a page with a dialog over it — and so a failure to close is
       * reported as its own step rather than buried in the cleanup summary.
       */
      await step("CLOSE_CONTACT", opts.closeContactMs, async () => {
        if (!modal) return { ok: true, detail: { nothingToClose: true } };
        const trail = [];
        if (!weOpenedIt) {
          // Not ours. The URL is still checked below, because arriving with a
          // dialog already up is exactly the state a previous leak leaves behind.
          trail.push("already_open_left_alone");
        } else if (CU) {
          trail.push(`close:${CU.closePopover(modal) ?? "no_mechanism"}`);
        } else if (typeof modal.hidePopover === "function") {
          modal.hidePopover();
          trail.push("close:hidePopover");
        }
        // And the URL the click changed.
        if (!isCanonical(win)) {
          const target = canonicalUrl(win);
          if (typeof win.history?.back === "function") {
            win.history.back();
            trail.push("url:history.back");
            await waitFor(() => isCanonical(win), 1200, win);
          }
          if (!isCanonical(win) && target && typeof win.history?.replaceState === "function") {
            win.history.replaceState({}, "", target);
            trail.push("url:replaceState");
          }
        }
        gathered.contactTrail.push(...trail);
        // A popover we did not open staying open is not a failure of ours.
        const stillOpen = weOpenedIt && CU ? CU.isOpen(modal) : false;
        return !stillOpen && isCanonical(win)
          ? { ok: true, detail: { trail, weOpenedIt } }
          : {
              ok: false,
              reason: stillOpen ? "overlay_would_not_close" : "url_not_restored",
              detail: { trail, weOpenedIt },
            };
      });

      // ---- EXPAND_BIO -----------------------------------------------------
      /**
       * The About text is line-clamped with a "see more" button. Pressing it is
       * the difference between a real bio and the fragment that produced a
       * permanent `bio_too_short`.
       *
       * The wait is for the text to GROW, with a timeout — on a static page the
       * button only toggles a CSS class and the text never changes, which is a
       * success (the full text was already there), not a failure.
       */
      await step("EXPAND_BIO", opts.expandBioMs, async () => {
        const { box, button } = aboutBox(doc);
        if (!box) return { ok: false, reason: "no_about_box" };
        const before = once(box.textContent).length;
        if (!button) return { ok: true, detail: { before, expanded: false, reason: "no_button" } };
        button.click();
        const grew = await waitFor(
          () => once(box.textContent).length > before,
          Math.min(1200, opts.expandBioMs),
          win,
        );
        const after = once(box.textContent).length;
        gathered.bio = { before, after, grew };
        return { ok: true, detail: { before, after, grew } };
      });

      // ---- LOAD_SECTIONS --------------------------------------------------
      /**
       * Experience and Education are lazy-mounted — the page ships one
       * `data-testid="lazy-column"` and renders them when they scroll into view.
       * Measured on both real fixtures: the only sections present are About,
       * Featured, Activity and the suggestion rails. Which is why company and job
       * title reported `section:experience:absent` on every capture.
       *
       * Progressive rather than one jump to the bottom: a single scrollTo can skip
       * past the observer's trigger point entirely. Stops early when the wanted
       * headings appear or when the heading count stops growing.
       */
      await step("LOAD_SECTIONS", opts.loadSectionsMs, async () => {
        const originalY = win.scrollY ?? 0;
        const trail = [];
        let mutations = 0;

        /**
         * Watch the main column instead of only counting headings.
         *
         * A lazily-mounted section arrives as a DOM insertion, and a heading count
         * taken between two scrolls can miss the moment it lands — the old step
         * compared counts and gave up the first time two consecutive samples
         * matched. An observer sees the insertion itself, so "something mounted" is
         * observed rather than inferred.
         */
        // Hoisted above the try so the `finally` can report them even when the
        // step runs out of budget half way through.
        let steps = 0;

        /**
         * Seeded IMMEDIATELY, before anything can await.
         *
         * A step abandoned by the watchdog mid-`await` never reaches its `finally`
         * in time to be reported — `withTimeout` resolves and the machine moves on
         * while the suspended function is still parked on a sleep. So the field is
         * given a real value the moment the step starts: "began, mounted nothing"
         * stays distinguishable from "never ran", which is the whole point of
         * reporting it.
         */
        gathered.sections = { mounted: false, steps: 0, mutations: 0, headings: [] };
        const target = doc.querySelector("main") ?? doc.querySelector('[role="main"]') ?? doc.body;
        let observer = null;
        try {
          if (typeof win.MutationObserver === "function") {
            observer = new win.MutationObserver((records) => {
              for (const r of records) {
                for (const node of r.addedNodes ?? []) {
                  if (node.nodeType !== 1) continue;
                  if (node.matches?.("section, article") || node.querySelector?.("section, article")) {
                    mutations += 1;
                  }
                }
              }
            });
            observer.observe(target, { childList: true, subtree: true });
            trail.push("observer:on");
          }
        } catch {
          trail.push("observer:unavailable");
        }

        try {
          /**
           * Scroll to the bottom in steps, recomputing the height every time.
           *
           * The document GROWS as sections mount, so a height read once is wrong by
           * the second step. The old version took two 600px steps and stopped —
           * 450ms in total on a page whose Experience section sits well below that,
           * which is why it reported `experience_never_mounted` on a profile that
           * plainly has one.
           *
           * Patience is the whole fix: at least 400ms of settle per step, and three
           * consecutive unproductive steps before giving up rather than one.
           */
          let unproductive = 0;
          let y = originalY;
          const deadlineForStep = now() + Math.min(opts.loadSectionsMs, deadline - now());

          for (; steps < opts.scrollMaxSteps; steps += 1) {
            if (now() >= deadlineForStep || outOfTime()) {
              trail.push("budget_spent");
              break;
            }
            if (hasWantedSections(doc)) {
              trail.push("wanted_present");
              break;
            }

            const height = Math.max(
              doc.documentElement?.scrollHeight ?? 0,
              doc.body?.scrollHeight ?? 0,
            );
            const viewport = win.innerHeight ?? 800;
            const atBottom = height > 0 && y + viewport >= height - 8;
            if (atBottom) {
              trail.push(`bottom:${height}`);
              break;
            }

            const before = sectionHeadings(doc).size;
            const seenMutations = mutations;
            y = Math.min(y + opts.scrollStepPx, Math.max(0, height - viewport));
            win.scrollTo(0, y);
            trail.push(`scroll:${y}`);
            await sleep(opts.scrollSettleMs, win);

            const grew = sectionHeadings(doc).size > before || mutations > seenMutations;
            if (grew) {
              unproductive = 0;
              continue;
            }
            unproductive += 1;
            // THREE, not one. A single quiet step is normal: the observer may not
            // have fired yet, and LinkedIn fetches before it renders.
            if (unproductive >= 3) {
              trail.push("three_unproductive_steps");
              break;
            }
          }

          /**
           * One last chance for a fetch already in flight — minus a margin.
           *
           * Waiting the whole remaining budget meant the wait ended exactly ON the
           * step's deadline, so `withTimeout` fired first and a step that had done
           * its job reported `step_timed_out` and lost its detail. Leave 150ms to
           * return in.
           */
          if (!hasWantedSections(doc)) {
            const room = Math.max(0, deadlineForStep - now() - 150);
            if (room > 0) await waitFor(() => hasWantedSections(doc), Math.min(600, room), win);
          }

          try {
            win.scrollTo(0, originalY);
            trail.push("scroll:restored");
          } catch {
            trail.push("scroll:restore_failed");
          }

          const mounted = hasWantedSections(doc);
          // Computed HERE, not read from `gathered.sections`: that is assigned in
          // the finally below, which runs after this expression is evaluated, so
          // reading it here threw "Cannot read properties of null" and turned a
          // working step into `threw_TypeError`.
          const headings = [...sectionHeadings(doc)];
          return mounted
            ? { ok: true, detail: { steps, mutations, trail } }
            : { ok: false, reason: "experience_never_mounted", detail: { steps, mutations, trail, headings } };
        } finally {
          try {
            observer?.disconnect();
          } catch {
            /* nothing to do about a detached observer */
          }
          /**
           * Reported from the FINALLY, so it survives the step running out of
           * budget. Assigned at the end of the happy path it was null whenever
           * this step timed out — and "the section did not mount" then looked
           * identical to "the step never ran", which is exactly the ambiguity
           * diagnostics v3 exists to remove.
           */
          gathered.sections = {
            mounted: hasWantedSections(doc),
            steps,
            mutations,
            headings: [...sectionHeadings(doc)],
          };
        }
      });

      // ---- READ_POSTS -----------------------------------------------------
      // Only checks that the activity section is there to be read; content.js
      // does the reading, because reading is its job and it has the validators.
      await step("READ_POSTS", opts.readPostsMs, async () => {
        const heads = [...sectionHeadings(doc)];
        const present = heads.some((h) => /(activity|aktivitas|posts|bejegyzes)/.test(h));
        return present ? { ok: true } : { ok: false, reason: "no_activity_section" };
      });

      record.ok = record.steps.some((s) => s.ok);
      goto(record.ok ? "DONE" : "FAILED");
      return finish();
    } catch (error) {
      // The machine itself broke. Still cleans up, still returns, still saves.
      record.steps.push({
        name: record.state,
        ok: false,
        reason: `machine_threw_${String(error?.name ?? "Error")}`,
        ms: now() - started,
      });
      goto("FAILED");
      return finish();
    } finally {
      // NOTHING is allowed to skip this.
      if (session && CU) {
        try {
          const result = await CU.cleanup(session, { urlTimeoutMs: 1500 });
          record.cleanupSteps = result.steps;
        } catch (e) {
          record.cleanupSteps = [`cleanup_threw_${String(e?.name ?? "Error")}`];
        }
        record.cleanupVerified = CU.verify(session);
      } else {
        record.cleanupSteps = ["cleanup_module_not_injected"];
        record.cleanupVerified = null;
      }
      record.totalMs = now() - started;
      if (record.totalMs >= opts.globalMs) record.watchdogFired = true;
    }

    function finish() {
      return {
        machine: record,
        observer: gathered.observer,
        observedCount: (gathered.observed ?? []).length,
        api: gathered.api,
        contact: gathered.contact,
        contactTrail: gathered.contactTrail,
        bio: gathered.bio,
        sections: gathered.sections,
      };
    }
  }

  globalThis.VentureMachine = { run, STATES, DEFAULTS, isCanonical, canonicalUrl, aboutBox };
})();
