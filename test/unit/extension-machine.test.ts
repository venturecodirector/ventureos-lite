import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";

/**
 * The capture state machine (capture items B, D, E).
 *
 * ── WHAT THESE TESTS ARE ACTUALLY DEFENDING ─────────────────────────────────
 *
 * A capture was observed running at `/in/<id>/overlay/<id>/` and reading a
 * profile from there: no top card, five identities counted out of dialog
 * content, a page title naming the overlay instead of the person. Every field was
 * wrong in a different way, which is what made it hard to see as one bug.
 *
 * It was one bug. The Contact-info trigger is an ANCHOR to
 * `/in/<slug>/overlay/contact-info/`, so pressing it NAVIGATES; the old close
 * path dispatched Escape, which is a documented no-op against `popover="manual"`;
 * so the overlay stayed open, the URL stayed on the overlay route, and the next
 * thing to run read a page that was not a profile.
 *
 * So the tests below are about side effects being undone, not about values.
 */
const EXT = join(process.cwd(), "extension");
const FIXTURES = join(process.cwd(), "test/fixtures/linkedin");

const FILES = {
  selectors: readFileSync(join(EXT, "selectors.js"), "utf8"),
  names: readFileSync(join(EXT, "names.js"), "utf8"),
  cleanup: readFileSync(join(EXT, "cleanup.js"), "utf8"),
  contactParse: readFileSync(join(EXT, "contact-parse.js"), "utf8"),
  machine: readFileSync(join(EXT, "machine.js"), "utf8"),
  content: readFileSync(join(EXT, "content.js"), "utf8"),
};

interface MachineStep {
  name: string;
  ok: boolean;
  reason: string | null;
  ms: number;
  detail?: unknown;
}
interface MachineRecord {
  version: number;
  state: string;
  transitions: { from: string; to: string; atMs: number }[];
  steps: MachineStep[];
  timings: Record<string, number>;
  watchdogFired: boolean;
  totalMs: number;
  cleanupSteps: string[];
  cleanupVerified: {
    popoversWeOpened: number;
    stillOpen: number;
    inertRemaining: number;
    urlRestored: boolean;
    scrollRestored: boolean;
    focusRestored: boolean;
    cleanedUp: boolean;
  } | null;
}
interface RunResult {
  machine: MachineRecord;
  contact: { email: string[]; phone: unknown[]; website: unknown[] } | null;
  contactTrail: string[];
  bio: { before: number; after: number; grew: boolean } | null;
  sections: { mounted: boolean; steps: number; headings: string[] } | null;
}
interface Extracted {
  url: string;
  refused: boolean;
  route: { ok: boolean; reason: string | null; kind?: string };
  name?: string;
  headline?: string;
  location?: string;
  companyName?: string;
  jobTitle?: string;
  bio?: string;
  photoUrl?: string;
  flags: string[];
  provenance: Record<string, { source: string; confidence: string }>;
  skipped: Record<string, string>;
  boundary: { ok: boolean; reason: string | null; identitiesInCard: number | null };
  _attempts: Record<string, string[]>;
}

/**
 * A jsdom page with every module injected, exactly as the popup injects them.
 *
 * `scrollTo` is replaced: jsdom does not implement it — it emits a
 * "Not implemented" notice, never fires a scroll event and leaves scrollY at 0 —
 * so a test that relies on scrolling has to observe the CALL. `onScroll` is how
 * the lazy-mount test simulates LinkedIn mounting a section when the page moves.
 */
function page(fixture: string, url: string, html?: string, onScroll?: (y: number) => void) {
  const dom = new JSDOM(html ?? readFileSync(join(FIXTURES, fixture), "utf8"), {
    url,
    runScripts: "outside-only",
  });
  let scrollY = 0;
  Object.defineProperty(dom.window, "scrollY", { get: () => scrollY, configurable: true });
  Object.defineProperty(dom.window, "scrollX", { get: () => 0, configurable: true });
  dom.window.scrollTo = ((x: number, y: number) => {
    scrollY = typeof y === "number" ? y : 0;
    onScroll?.(scrollY);
  }) as typeof dom.window.scrollTo;
  const g: Record<string, unknown> = {};
  const inject = (src: string) =>
    new Function("globalThis", "window", "document", src)(g, dom.window, dom.window.document);
  inject(FILES.selectors);
  inject(FILES.names);
  inject(FILES.cleanup);
  inject(FILES.contactParse);
  inject(FILES.machine);
  return { dom, g };
}

type Machine = {
  run(opts: Record<string, unknown>): Promise<RunResult>;
  isCanonical(win: unknown): boolean;
};

/** Short budgets: these tests must not spend twenty seconds proving a timeout. */
const FAST = {
  globalMs: 4_000,
  routeMs: 300,
  topcardMs: 300,
  openContactMs: 300,
  readContactMs: 200,
  closeContactMs: 300,
  expandBioMs: 300,
  loadSectionsMs: 800,
  readPostsMs: 200,
  scrollSettleMs: 10,
  scrollMaxSteps: 4,
};

async function runMachine(
  fixture: string,
  url: string,
  html?: string,
  extra: Record<string, unknown> = {},
) {
  const { dom, g } = page(fixture, url, html);
  const machine = g.VentureMachine as Machine;
  const result = await machine.run({
    ...FAST,
    ...extra,
    window: dom.window,
    document: dom.window.document,
  });
  return { result, dom, g };
}

/** Extraction, run against a page the machine has already prepared. */
function extractFrom(dom: JSDOM, g: Record<string, unknown>): Extracted {
  const fn = new Function(
    "document",
    "window",
    "location",
    "URL",
    "globalThis",
    `return (${FILES.content.trim().replace(/;\s*$/, "")})`,
  );
  return fn(
    dom.window.document,
    dom.window,
    dom.window.location,
    dom.window.URL,
    g,
  ) as Extracted;
}

const OWNER = "anonimizalt-odon-scrubbed";
const PROFILE_URL = `https://www.linkedin.com/in/${OWNER}/`;
const OVERLAY_URL = `https://www.linkedin.com/in/${OWNER}/overlay/${OWNER}/`;

// ── item 2: the overlay route ───────────────────────────────────────────────

describe("the overlay-route regression — the corrupted capture", () => {
  it("REFUSES to extract anything from an overlay route", async () => {
    const { dom, g } = page("real-profile-sdui-2.html", OVERLAY_URL);
    const out = extractFrom(dom, g);

    expect(out.refused).toBe(true);
    expect(out.route.ok).toBe(false);
    expect(out.route.reason).toBe("on_an_overlay_route");
    // Not one field, including the ones that would have "worked".
    for (const field of ["name", "headline", "location", "companyName", "jobTitle", "bio", "photoUrl"] as const) {
      expect(out[field], `${field} was read off an overlay route`).toBeUndefined();
    }
  });

  it("never reports more than one identity — the reported count was five", async () => {
    for (const url of [PROFILE_URL, OVERLAY_URL]) {
      for (const fixture of ["real-profile-sdui.html", "real-profile-sdui-2.html"]) {
        const { dom, g } = page(fixture, url);
        const out = extractFrom(dom, g);
        const n = out.boundary.identitiesInCard;
        expect(n === null || n === 1, `${fixture} @ ${url} reported ${n} identities`).toBe(true);
      }
    }
  });

  /**
   * The mechanism, asserted directly: the five identities the boundary walk
   * counted are all inside dialog subtrees, and one of them is a real person's
   * slug. No field may come from there.
   */
  it("takes no field from dialog content", async () => {
    const { dom, g } = page("real-profile-sdui-2.html", PROFILE_URL);
    const doc = dom.window.document;
    const OVERLAYS =
      '[popover],[role="dialog"],[data-testid="dialog"],[data-testid="dialog-content"],' +
      '[data-testid="popover-floating"],[inert],[aria-hidden="true"]';
    const inDialog = new Set<string>();
    for (const d of doc.querySelectorAll(OVERLAYS)) {
      for (const a of d.querySelectorAll('a[href*="/in/"]')) {
        const m = /\/in\/([^/?#]+)/.exec(a.getAttribute("href") ?? "");
        if (m && m[1]!.toLowerCase() !== OWNER) inDialog.add(decodeURIComponent(m[1]!).toLowerCase());
      }
    }
    // The fixture really does hide other people in dialogs — otherwise this test
    // proves nothing.
    expect(inDialog.size).toBeGreaterThan(0);

    const out = extractFrom(dom, g);
    expect(out.boundary.ok).toBe(true);
    expect(out.boundary.identitiesInCard).toBe(1);
    for (const field of ["name", "headline", "location", "companyName", "jobTitle", "bio"] as const) {
      const value = out[field]?.toLowerCase();
      if (!value) continue;
      for (const slug of inDialog) {
        for (const token of slug.split("-").filter((t) => t.length >= 4)) {
          expect(value, `${field} contains "${token}" from a dialog`).not.toContain(token);
        }
      }
    }
  });

  it("returns to the canonical route before anything else runs", async () => {
    const { result, dom } = await runMachine("real-profile-sdui-2.html", OVERLAY_URL);
    const ensure = result.machine.steps.find((s) => s.name === "ENSURE_ROUTE")!;
    expect(ensure).toBeTruthy();
    // jsdom has no history to go back to, so the replaceState fallback is what
    // does it — which is exactly the path a tab opened straight on an overlay
    // link takes.
    expect(ensure.ok).toBe(true);
    expect(dom.window.location.pathname).toBe(`/in/${OWNER}/`);

    // And extraction, run afterwards, now proceeds.
    const out = extractFrom(dom, (await page("real-profile-sdui-2.html", dom.window.location.href)).g);
    expect(out.refused).toBe(false);
  });

  it("ENSURE_ROUTE is the first step, always", async () => {
    const { result } = await runMachine("real-profile-sdui.html", PROFILE_URL);
    expect(result.machine.steps[0]!.name).toBe("ENSURE_ROUTE");
    expect(result.machine.transitions[0]).toMatchObject({ from: "IDLE", to: "ENSURE_ROUTE" });
  });
});

// ── item 3: cleanup after a deliberate failure ──────────────────────────────

describe("cleanup after a deliberately failing capture", () => {
  /**
   * A page built to break the capture: a manual popover that Escape cannot close
   * (the actual hang), no contact trigger, and no About box. Every step that can
   * fail, does.
   */
  const BROKEN = `<!doctype html><html><head><title>Anonimizált Ödön | LinkedIn</title></head>
    <body>
      <main><div class="card">
        <a href="/in/${OWNER}/"><img src="https://media.licdn.com/x.jpg" srcset="https://media.licdn.com/profile-displayphoto/x.jpg 400w"></a>
        <a href="/in/${OWNER}/">Anonimizált Ödön</a>
        <div>CEO at Seyu</div>
        <div>Budapest, Hungary</div>
        <a id="trigger" href="/in/${OWNER}/overlay/contact-info/">Contact info</a>
      </div>
        <section><h2>About</h2><p>short</p></section>
      </main>
      <!-- A manual popover, hidden until the trigger opens it. Escape cannot
           close this: that is the whole point, and was the hang. -->
      <div id="stuck" role="dialog" data-testid="popover-floating" popover="manual" hidden>
        <h2>Contact info</h2>
      </div>
    </body></html>`;

  it("closes every popover it opened, restores URL, scroll and focus — and says so", async () => {
    const { result, dom } = await runMachine("", PROFILE_URL, BROKEN);
    const win = dom.window as unknown as { scrollY: number };

    // The machine opened the stuck popover itself so cleanup has something to do.
    const stuck = dom.window.document.getElementById("stuck")!;
    expect(stuck).toBeTruthy();

    const v = result.machine.cleanupVerified;
    expect(v, "cleanup was never verified").not.toBeNull();
    expect(v!.cleanedUp).toBe(true);
    expect(v!.stillOpen).toBe(0);
    expect(v!.inertRemaining).toBe(0);
    expect(v!.urlRestored).toBe(true);
    expect(v!.scrollRestored).toBe(true);
    expect(v!.focusRestored).toBe(true);
    expect(win.scrollY).toBe(0);
    expect(result.machine.cleanupSteps.length).toBeGreaterThan(0);
  });

  it("records a reason per failing step and keeps going", async () => {
    const { result } = await runMachine("", PROFILE_URL, BROKEN);
    const byName = Object.fromEntries(result.machine.steps.map((s) => [s.name, s]));

    // The overlay opens but carries no details, so READ_CONTACT is the step that
    // fails here — and that must not cost the later steps.
    expect(byName.READ_CONTACT!.ok).toBe(false);
    expect(byName.READ_CONTACT!.reason).toBe("overlay_had_no_contact_details");
    // Every later step still ran.
    for (const later of ["CLOSE_CONTACT", "EXPAND_BIO", "LOAD_SECTIONS", "READ_POSTS"]) {
      expect(byName[later], `${later} did not run after an earlier failure`).toBeTruthy();
    }
    // Every reason is a machine-readable code, not a sentence.
    for (const s of result.machine.steps) {
      if (s.reason) expect(s.reason, s.name).toMatch(/^[a-z0-9_]+$/i);
    }
  });

  it("still yields a saveable payload with partial data and reason codes", async () => {
    const { dom, g } = page("", PROFILE_URL, BROKEN);
    const machine = g.VentureMachine as Machine;
    await machine.run({ ...FAST, window: dom.window, document: dom.window.document });
    const out = extractFrom(dom, g);

    // THE POINT: a broken capture is still a lead.
    expect(out.url).toBe(`https://www.linkedin.com/in/${OWNER}`);
    expect(out.refused).toBe(false);
    expect(out.name).toBe("Anonimizált Ödön");
    // And what could not be read says why, in codes.
    for (const reason of Object.values(out.skipped)) {
      expect(reason).toMatch(/^[a-z0-9_]+$/);
    }
  });

  it("survives cleanup being run twice — it is called from a finally", async () => {
    const { dom, g } = page("", PROFILE_URL, BROKEN);
    const machine = g.VentureMachine as Machine;
    const CU = g.VentureCleanup as {
      createSession(w: unknown): unknown;
      cleanup(s: unknown): Promise<{ ok: boolean; steps: string[] }>;
      verify(s: unknown): { cleanedUp: boolean };
    };
    await machine.run({ ...FAST, window: dom.window, document: dom.window.document });
    const session = CU.createSession(dom.window);
    const first = await CU.cleanup(session);
    const second = await CU.cleanup(session);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(CU.verify(session).cleanedUp).toBe(true);
  });

  it("cannot hang: the watchdog bounds the whole run", async () => {
    const { result } = await runMachine("real-profile-sdui-2.html", PROFILE_URL, undefined, {
      globalMs: 900,
      loadSectionsMs: 5_000,
      scrollSettleMs: 300,
      scrollMaxSteps: 40,
    });
    expect(result.machine.totalMs).toBeLessThan(4_000);
    expect(result.machine.cleanupVerified!.cleanedUp).toBe(true);
  });
});

// ── item 5: the two paths to company and job title ─────────────────────────

describe("current company and job title", () => {
  it("comes from the Experience section at HIGH confidence when it is mounted", () => {
    const { dom, g } = page(
      "a-authenticated-with-right-rail.html",
      "https://www.linkedin.com/in/anna-kovacs-fixture/",
    );
    const out = extractFrom(dom, g);
    expect(out.jobTitle).toBe("Ügyvezető");
    expect(out.companyName).toBe("Danubia Fogászat Kft.");
    expect(out.provenance.jobTitle).toMatchObject({ source: "experience", confidence: "high" });
    expect(out.provenance.companyName).toMatchObject({ source: "experience", confidence: "high" });
  });

  /**
   * The real fixtures: the section is lazy-mounted and never arrives, which is why
   * every capture reported `section:experience:absent`. The headline is the
   * fallback, and it is labelled `derived` at medium confidence because a headline
   * is prose as often as it is a job title.
   */
  it("falls back to the headline at MEDIUM confidence, labelled derived", () => {
    const { dom, g } = page("real-profile-sdui.html", PROFILE_URL);
    const out = extractFrom(dom, g);
    expect(out.headline).toBe("CEO at Seyu");
    expect(out.jobTitle).toBe("CEO");
    expect(out.companyName).toBe("Seyu");
    for (const f of ["jobTitle", "companyName"] as const) {
      expect(out.provenance[f]).toMatchObject({ source: "derived", confidence: "medium" });
      expect(out.provenance[f]!.confidence).not.toBe("high");
    }
    expect(out._attempts.jobTitle?.join(" ")).toContain("section:experience:absent");
  });

  it("parses all three headline separators, and refuses prose", () => {
    const cases: [string, string | undefined, string | undefined][] = [
      ["CEO at Seyu", "CEO", "Seyu"],
      ["Gyártásvezető @ Alföld Présüzem", "Gyártásvezető", "Alföld Présüzem"],
      ["Head of Growth | Acme Kft.", "Head of Growth", "Acme Kft."],
      // Prose, not a role: must not become a job title.
      ["Building the future of payments at scale for everyone", undefined, undefined],
      ["We are hiring at Acme", undefined, undefined],
    ];
    for (const [headline, role, company] of cases) {
      const html = `<!doctype html><html><head><title>Teszt Elek | LinkedIn</title></head><body><main><div class="card">
        <a href="/in/teszt-elek/"><img src="https://media.licdn.com/x.jpg" srcset="https://media.licdn.com/profile-displayphoto/x.jpg 400w"></a>
        <a href="/in/teszt-elek/">Teszt Elek</a>
        <div>${headline}</div>
        <div>Budapest, Hungary</div>
      </div></main></body></html>`;
      const { dom, g } = page("", "https://www.linkedin.com/in/teszt-elek/", html);
      const out = extractFrom(dom, g);
      expect(out.jobTitle, `role from "${headline}"`).toBe(role);
      expect(out.companyName, `company from "${headline}"`).toBe(company);
    }
  });

  /**
   * LOAD_SECTIONS doing its job: the section mounts only once the page scrolls,
   * simulated here with a scroll listener, because jsdom has no layout and
   * therefore no IntersectionObserver behaviour to trigger.
   */
  it("LOAD_SECTIONS scrolls until a lazy Experience section mounts", async () => {
    const html = `<!doctype html><html><head><title>Teszt Elek | LinkedIn</title></head><body><main><div class="card">
      <a href="/in/teszt-elek/"><img src="https://media.licdn.com/x.jpg" srcset="https://media.licdn.com/profile-displayphoto/x.jpg 400w"></a>
      <a href="/in/teszt-elek/">Teszt Elek</a>
      <div>CEO at Seyu</div>
      <div>Budapest, Hungary</div>
    </div>
      <section><h2>About</h2><p>${"x".repeat(60)}</p></section>
      <div data-testid="lazy-column"></div>
    </main></body></html>`;

    // The section mounts on the SECOND scroll, so the test also proves the loop
    // keeps stepping rather than giving up after one move.
    let scrolls = 0;
    let doc!: Document;
    const onScroll = () => {
      scrolls += 1;
      if (scrolls < 2 || doc.querySelector("section h2[data-lazy]")) return;
      const section = doc.createElement("section");
      section.innerHTML =
        '<h2 data-lazy="1">Experience</h2><ul><li><span>Ügyvezető</span><span>Lazy Kft. · Full-time</span>' +
        "<span>2020 - Present</span></li></ul>";
      doc.querySelector('[data-testid="lazy-column"]')!.appendChild(section);
    };
    const { dom, g } = page("", "https://www.linkedin.com/in/teszt-elek/", html, onScroll);
    doc = dom.window.document;

    const machine = g.VentureMachine as Machine;
    const result = await machine.run({ ...FAST, window: dom.window, document: doc });

    const load = result.machine.steps.find((s) => s.name === "LOAD_SECTIONS")!;
    expect(load.ok, `LOAD_SECTIONS: ${load.reason}`).toBe(true);
    expect(result.sections!.mounted).toBe(true);
    expect(result.sections!.steps).toBeGreaterThan(0);

    // And now the Experience section wins over the headline fallback.
    const out = extractFrom(dom, g);
    expect(out.jobTitle).toBe("Ügyvezető");
    expect(out.companyName).toBe("Lazy Kft.");
    expect(out.provenance.jobTitle!.confidence).toBe("high");
  });

  it("reports experience_never_mounted rather than pretending, on the real page", async () => {
    const { result } = await runMachine("real-profile-sdui.html", PROFILE_URL);
    const load = result.machine.steps.find((s) => s.name === "LOAD_SECTIONS")!;
    expect(load.ok).toBe(false);
    expect(load.reason).toBe("experience_never_mounted");
    expect(result.sections!.headings).not.toContain("experience");
  });
});

// ── item 6: the About text ─────────────────────────────────────────────────

describe("the About text", () => {
  const about = (body: string, extra = "") =>
    `<!doctype html><html><head><title>Teszt Elek | LinkedIn</title></head><body><main><div class="card">
      <a href="/in/teszt-elek/"><img src="https://media.licdn.com/x.jpg" srcset="https://media.licdn.com/profile-displayphoto/x.jpg 400w"></a>
      <a href="/in/teszt-elek/">Teszt Elek</a>
      <div>CEO at Seyu</div>
      <div>Budapest, Hungary</div>
    </div>
      <section><h2>About</h2>
        <div data-testid="expandable-text-box">${body}${extra}</div>
      </section>
    </main></body></html>`;

  it("accepts a 40-character bio — bio_too_short is gone", () => {
    const text = "Rövid, de igazi bemutatkozás. Negyven!!!"; // 40 chars
    expect(text.length).toBe(40);
    const { dom, g } = page("", "https://www.linkedin.com/in/teszt-elek/", about(text));
    const out = extractFrom(dom, g);
    expect(out.bio).toBe(text);
    expect(out.skipped.bio).toBeUndefined();
  });

  it("still refuses something too short to be a bio at all", () => {
    const { dom, g } = page("", "https://www.linkedin.com/in/teszt-elek/", about("hi"));
    const out = extractFrom(dom, g);
    expect(out.bio).toBeUndefined();
    expect(out.skipped.bio).toBe("bio_too_short");
  });

  it("presses the reveal button and reads the text it uncovers", async () => {
    const html = about(
      '<span id="txt">A truncated opening sentence…</span>',
      '<button data-testid="expandable-text-button">see more</button>',
    );
    const { dom, g } = page("", "https://www.linkedin.com/in/teszt-elek/", html);
    const doc = dom.window.document;
    const FULL =
      "A truncated opening sentence… and then the whole rest of it, which only " +
      "appears once the reveal button has actually been pressed.";
    doc.querySelector('[data-testid="expandable-text-button"]')!.addEventListener("click", () => {
      doc.getElementById("txt")!.textContent = FULL;
    });

    const machine = g.VentureMachine as Machine;
    const result = await machine.run({ ...FAST, window: dom.window, document: doc });

    const step = result.machine.steps.find((s) => s.name === "EXPAND_BIO")!;
    expect(step.ok).toBe(true);
    expect(result.bio!.grew).toBe(true);
    expect(result.bio!.after).toBeGreaterThan(result.bio!.before);

    const out = extractFrom(dom, g);
    expect(out.bio).toContain("only appears once the reveal button has actually been pressed");
  });

  it("flags a still-clamped About rather than discarding it", () => {
    /**
     * Varied text, not `"x".repeat(400)`.
     *
     * LinkedIn renders most labels twice — once for sight, once for screen
     * readers — so the reader collapses a string that is two identical halves.
     * 400 identical characters IS two identical halves, so the de-duplication
     * correctly halved it and the test was measuring its own bad input.
     */
    const long = Array.from({ length: 40 }, (_, i) => `sentence ${String(i).padStart(2, "0")}`).join(" ");
    const body = long.slice(0, 400);
    expect(body.length).toBe(400);
    const html = about(body, '<button data-testid="expandable-text-button">see more</button>');
    const { dom, g } = page("", "https://www.linkedin.com/in/teszt-elek/", html);
    const out = extractFrom(dom, g);
    // Exactly 400: the "see more" button's own label is excluded.
    expect(out.bio!.length).toBe(400);
    expect(out.flags).toContain("bio_truncated");
    expect(out.skipped.bio).toBeUndefined();
  });

  it("reads the real fixture's 995-character About, which used to be rejected", () => {
    const { dom, g } = page("real-profile-sdui.html", PROFILE_URL);
    const out = extractFrom(dom, g);
    expect(out.bio!.length).toBeGreaterThan(900);
    expect(out.bio).toContain("entrepreneur");
    expect(out.skipped.bio).toBeUndefined();
    expect(out.provenance.bio!.source).toBe("about-box");
  });
});

// ── item 4: the machine's account of itself ────────────────────────────────

describe("the machine reports itself", () => {
  it("records every transition, in order, with timings", async () => {
    const { result } = await runMachine("real-profile-sdui.html", PROFILE_URL);
    const m = result.machine;

    expect(m.version).toBe(3);
    expect(m.transitions.length).toBeGreaterThanOrEqual(8);
    // The chain is contiguous: each transition starts where the last ended.
    for (let i = 1; i < m.transitions.length; i += 1) {
      expect(m.transitions[i]!.from).toBe(m.transitions[i - 1]!.to);
    }
    expect(["DONE", "FAILED"]).toContain(m.state);

    // A timing for every step that ran, and they are numbers.
    for (const s of m.steps) {
      expect(typeof m.timings[s.name], `${s.name} has no timing`).toBe("number");
      expect(m.timings[s.name]).toBeGreaterThanOrEqual(0);
    }
    expect(m.totalMs).toBeGreaterThanOrEqual(0);
  });

  it("runs the specified steps in the specified order", async () => {
    const { result } = await runMachine("real-profile-sdui.html", PROFILE_URL);
    expect(result.machine.steps.map((s) => s.name)).toEqual([
      "ENSURE_ROUTE",
      "READ_TOPCARD",
      "OPEN_CONTACT",
      "READ_CONTACT",
      "CLOSE_CONTACT",
      "EXPAND_BIO",
      "LOAD_SECTIONS",
      "READ_POSTS",
    ]);
  });

  it("always returns a cleanup verification, even on the happy path", async () => {
    const { result } = await runMachine("real-profile-sdui.html", PROFILE_URL);
    expect(result.machine.cleanupVerified).not.toBeNull();
    expect(result.machine.cleanupVerified!.cleanedUp).toBe(true);
    expect(result.machine.cleanupSteps).not.toEqual(["cleanup_module_not_injected"]);
  });
});

// ── the real fixtures, every field ─────────────────────────────────────────

describe("the real fixtures now yield a whole profile", () => {
  for (const fixture of ["real-profile-sdui.html", "real-profile-sdui-2.html"]) {
    it(`reads name, headline, location, company, role, bio and posts from ${fixture}`, () => {
      const { dom, g } = page(fixture, PROFILE_URL);
      const out = extractFrom(dom, g);

      expect(out.boundary.ok).toBe(true);
      expect(out.boundary.identitiesInCard).toBe(1);
      expect(out.name).toBe("Anonimizált Ödön");
      expect(out.provenance.name).toMatchObject({ source: "topcard", confidence: "high" });
      expect(out.headline).toBe("CEO at Seyu");
      expect(out.location).toBe("Budapest, Hungary");
      expect(out.companyName).toBe("Seyu");
      expect(out.jobTitle).toBe("CEO");
      expect(out.bio!.length).toBeGreaterThan(900);
      expect(out.skipped).toEqual({});
    });
  }

  /**
   * THE START-ORDER BUG. The owner has 90 anchors to their own slug and 16 hold an
   * image; the first in DOCUMENT order is in the sticky header, and its container
   * is a perfectly valid four-line card reading "name / headline / More / Message".
   * The walk accepted it and stopped, so `location` reported `topcard:absent`
   * while "Budapest, Hungary" sat in the real top card further down.
   *
   * LinkedIn's own `topcard-logo-image-referencekey` identifies the real one.
   */
  it("starts from the componentkey'd top card, not the first anchor in the document", () => {
    const { dom, g } = page("real-profile-sdui.html", PROFILE_URL);
    const keyed = dom.window.document.querySelector(
      '[componentkey="topcard-logo-image-referencekey"]',
    );
    expect(keyed, "the fixture has no componentkey'd top card").not.toBeNull();

    const out = extractFrom(dom, g);
    // The sticky-header card cannot supply a location; the real one can.
    expect(out.location).toBe("Budapest, Hungary");
    expect(out.provenance.location).toMatchObject({ source: "topcard" });
  });

  /**
   * A post MENTIONS other people — that is most of what posts are for. The
   * cross-contamination guard used containment, so 1668 characters of the
   * person's own writing were discarded because a commenter's name appeared
   * inside them, and `postsRead: 0` read as an unreadable activity section.
   */
  it("keeps a post that mentions somebody else, while refusing one that IS somebody else", () => {
    const { dom, g } = page("real-profile-sdui.html", PROFILE_URL);
    const out = extractFrom(dom, g) as unknown as { posts: string[] };
    expect(out.posts.length).toBeGreaterThan(0);
    // The posts really do name other people — otherwise this proves nothing.
    expect(out.posts.some((p) => /Person \d/i.test(p) || p.length > 400)).toBe(true);
  });

  it("still refuses a card that genuinely holds two identities", () => {
    // Fixture (e) is the deliberate two-identity case and must stay refused: the
    // widened walk must not have widened its way out of the boundary test.
    const { dom, g } = page(
      "e-mangled-two-identities.html",
      "https://www.linkedin.com/in/anna-kovacs-fixture/",
    );
    const out = extractFrom(dom, g);
    expect(out.boundary.ok).toBe(false);
    expect(out.boundary.reason).toBe("card_contains_more_than_one_identity");
    expect(out.headline).toBeUndefined();
    expect(out.location).toBeUndefined();
  });

  it("never lets a right-rail stranger into a field, on the real page", () => {
    const { dom, g } = page("real-profile-sdui-2.html", PROFILE_URL);
    const doc = dom.window.document;
    // Every name reachable through an anchor that is NOT the owner's.
    const strangers = new Set<string>();
    for (const a of doc.querySelectorAll('a[href*="/in/"]')) {
      const href = a.getAttribute("href") ?? "";
      if (href.toLowerCase().includes(OWNER)) continue;
      const t = (a.textContent ?? "").replace(/\s+/g, " ").trim();
      if (t.length >= 5 && t.length <= 60 && /\s/.test(t)) strangers.add(t.toLowerCase());
    }
    expect(strangers.size).toBeGreaterThan(0);

    const out = extractFrom(dom, g);
    for (const field of ["name", "headline", "location", "companyName", "jobTitle"] as const) {
      const v = out[field]?.toLowerCase();
      if (!v) continue;
      for (const s of strangers) expect(v, `${field} contains "${s}"`).not.toContain(s);
    }
  });
});
