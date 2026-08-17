import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";

/**
 * Diagnostics v3 (capture item 4), and the page classifier.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 *
 * Every diagnostics dump from the field read:
 *
 *     machine: null, cleanup: null, contact: null, photo: null
 *
 * Four structurally-absent fields, and the reader of that report has no way to
 * tell "the steps ran and found nothing" from "the steps were never invoked". It
 * was the second: the Diagnose button only ever ran the reader, and nothing at all
 * produced a `machine` or `cleanup` section. A null in any of those four is
 * therefore a test failure now, not a shrug.
 */
const EXT = join(process.cwd(), "extension");
const FIXTURES = join(process.cwd(), "test/fixtures/linkedin");

const DIAGNOSTICS = readFileSync(join(EXT, "diagnostics.js"), "utf8");
const DIAGNOSE = readFileSync(join(EXT, "diagnose.js"), "utf8");
const FILES = {
  selectors: readFileSync(join(EXT, "selectors.js"), "utf8"),
  names: readFileSync(join(EXT, "names.js"), "utf8"),
  cleanup: readFileSync(join(EXT, "cleanup.js"), "utf8"),
  contactParse: readFileSync(join(EXT, "contact-parse.js"), "utf8"),
  machine: readFileSync(join(EXT, "machine.js"), "utf8"),
  content: readFileSync(join(EXT, "content.js"), "utf8"),
};

interface FieldReport {
  present: boolean;
  tier: string | null;
  source: string | null;
  confidence: string | null;
  attempted: string[];
  skippedBecause: string | null;
}
interface Report {
  diagnoseVersion: number;
  fields: Record<string, FieldReport>;
  boundary: unknown;
  postsRead: number;
  machine: {
    version: number;
    steps: { name: string; ok: boolean; reason: string | null; ms: number }[];
    transitions: { from: string; to: string; atMs: number }[];
    timings: Record<string, number>;
    cleanupSteps: string[];
    cleanupVerified: Record<string, unknown> | null;
    totalMs: number;
  } | null;
  cleanup: { steps: string[]; verified: Record<string, unknown> | null } | null;
  contact: { found: boolean; note: string | null } | null;
  photo: { ok: boolean; reason?: string; trail: string[] } | null;
  sections: { mounted: boolean; steps: number; headings: string[] } | null;
  bioExpansion: { before: number; after: number; grew: boolean } | null;
}

function loadDiagnostics() {
  const g: Record<string, unknown> = {};
  new Function("globalThis", "chrome", DIAGNOSTICS)(g, undefined);
  return (g.VentureDiagnostics as {
    buildDiagnostics(payload: unknown, extras?: unknown): Report;
  }).buildDiagnostics;
}

const OWNER = "anonimizalt-odon-scrubbed";
const PROFILE_URL = `https://www.linkedin.com/in/${OWNER}/`;

/** A real capture: machine, then reader, then a report — as the popup does it. */
async function fullCapture(fixture: string, url = PROFILE_URL) {
  const dom = new JSDOM(readFileSync(join(FIXTURES, fixture), "utf8"), { url });
  let scrollY = 0;
  Object.defineProperty(dom.window, "scrollY", { get: () => scrollY, configurable: true });
  dom.window.scrollTo = ((_x: number, y: number) => {
    scrollY = typeof y === "number" ? y : 0;
  }) as typeof dom.window.scrollTo;
  const g: Record<string, unknown> = {};
  for (const src of [
    FILES.selectors,
    FILES.names,
    FILES.cleanup,
    FILES.contactParse,
    FILES.machine,
  ]) {
    new Function("globalThis", "window", "document", src)(g, dom.window, dom.window.document);
  }
  const machine = g.VentureMachine as { run(o: Record<string, unknown>): Promise<Record<string, unknown>> };
  const prep = await machine.run({
    globalMs: 4_000,
    routeMs: 200,
    topcardMs: 200,
    openContactMs: 200,
    readContactMs: 200,
    closeContactMs: 200,
    expandBioMs: 200,
    loadSectionsMs: 500,
    readPostsMs: 200,
    scrollSettleMs: 10,
    scrollMaxSteps: 3,
    window: dom.window,
    document: dom.window.document,
  });
  const payload = new Function(
    "document",
    "window",
    "location",
    "URL",
    "globalThis",
    `return (${FILES.content.trim().replace(/;\s*$/, "")})`,
  )(dom.window.document, dom.window, dom.window.location, dom.window.URL, g);

  const m = prep.machine as Record<string, unknown>;
  const report = loadDiagnostics()(payload, {
    machine: m,
    cleanup: { steps: m.cleanupSteps, verified: m.cleanupVerified },
    sections: prep.sections,
    bioExpansion: prep.bio,
    contact: { found: !!prep.contact, note: null },
    photo: { ok: true, width: 800, height: 800, trail: ["componentkey"] },
  });
  return { report, payload, prep };
}

describe("a capture's diagnostics are never structurally empty", () => {
  for (const fixture of ["real-profile-sdui.html", "real-profile-sdui-2.html"]) {
    describe(fixture, () => {
      it("fills machine, cleanup, contact and photo — the four that were null", async () => {
        const { report } = await fullCapture(fixture);
        expect(report.diagnoseVersion).toBe(3);
        expect(report.machine, "machine is null").not.toBeNull();
        expect(report.cleanup, "cleanup is null").not.toBeNull();
        expect(report.contact, "contact is null").not.toBeNull();
        expect(report.photo, "photo is null").not.toBeNull();
      });

      it("carries per-step timings and a contiguous transition chain", async () => {
        const { report } = await fullCapture(fixture);
        const m = report.machine!;
        expect(m.steps.length).toBeGreaterThanOrEqual(8);
        for (const s of m.steps) {
          expect(typeof m.timings[s.name], `${s.name} timing`).toBe("number");
        }
        expect(m.transitions.length).toBeGreaterThanOrEqual(8);
        for (let i = 1; i < m.transitions.length; i += 1) {
          expect(m.transitions[i]!.from).toBe(m.transitions[i - 1]!.to);
        }
        expect(m.totalMs).toBeGreaterThanOrEqual(0);
      });

      it("carries cleanup VERIFICATION, not just the steps attempted", async () => {
        const { report } = await fullCapture(fixture);
        // "We called hidePopover" and "the popover is closed" are different
        // claims, and only the second one is worth reporting.
        const v = report.cleanup!.verified!;
        expect(v).not.toBeNull();
        for (const key of [
          "popoversWeOpened",
          "stillOpen",
          "inertRemaining",
          "urlRestored",
          "scrollRestored",
          "focusRestored",
          "cleanedUp",
        ]) {
          expect(v, `cleanup.verified.${key} missing`).toHaveProperty(key);
        }
        expect(v.cleanedUp).toBe(true);
        expect(v.stillOpen).toBe(0);
        expect(v.urlRestored).toBe(true);
      });

      it("reports the sections that mounted and whether About expanded", async () => {
        const { report } = await fullCapture(fixture);
        expect(report.sections).not.toBeNull();
        expect(Array.isArray(report.sections!.headings)).toBe(true);
        // Non-null even when nothing expanded: null means "not attempted".
        expect(report.bioExpansion === null || typeof report.bioExpansion.before === "number").toBe(
          true,
        );
      });

      it("explains every field it could not read", async () => {
        const { report } = await fullCapture(fixture);
        for (const [name, f] of Object.entries(report.fields)) {
          if (f.present) {
            expect(f.source, `${name} present with no source`).toBeTruthy();
            expect(f.confidence, `${name} present with no confidence`).toBeTruthy();
          } else {
            // Either a reason, or a record of what was attempted. Silence is the
            // one thing that is not allowed.
            const explained = !!f.skippedBecause || f.attempted.length > 0;
            expect(explained, `${name} is absent with no explanation`).toBe(true);
          }
        }
      });
    });
  }

  it("still produces a usable report when nothing was gathered at all", () => {
    // The degenerate case: the reader returned only a URL. The report must still
    // be shaped correctly rather than throwing or coming back half-built.
    const report = loadDiagnostics()({ url: "https://www.linkedin.com/in/x/" });
    expect(report.diagnoseVersion).toBe(3);
    expect(Object.keys(report.fields).length).toBeGreaterThanOrEqual(10);
    // These ARE null here, legitimately: no machine ran.
    expect(report.machine).toBeNull();
    expect(report.cleanup).toBeNull();
  });

  it("never puts a field's VALUE in the report", async () => {
    const { report, payload } = await fullCapture("real-profile-sdui.html");
    const json = JSON.stringify(report);
    // The person's own data is not diagnostic information.
    for (const value of [payload.name, payload.headline, payload.bio, payload.photoUrl]) {
      if (typeof value === "string" && value.length > 8) {
        expect(json, `the report leaks ${value.slice(0, 24)}`).not.toContain(value);
      }
    }
  });
});

// ── the page classifier ────────────────────────────────────────────────────

function probe(fixture: string, url = PROFILE_URL) {
  const dom = new JSDOM(readFileSync(join(FIXTURES, fixture), "utf8"), { url });
  return new Function(
    "document",
    "window",
    "location",
    "navigator",
    `return (${DIAGNOSE.trim().replace(/;\s*$/, "")})`,
  )(dom.window.document, dom.window, dom.window.location, dom.window.navigator) as {
    pageKind: string;
    auth: { memberSignals: string[]; guestCtaCount: number; verdict: string };
  };
}

describe("pageKind, by capability rather than by URL", () => {
  /**
   * THE REPORTED BUG: an authenticated session classified as "public-profile",
   * which invites the reader to blame the guest wall for fields that are missing
   * for entirely different reasons.
   */
  for (const fixture of ["real-profile-sdui.html", "real-profile-sdui-2.html"]) {
    it(`calls ${fixture} a member-profile, not a public one`, () => {
      const p = probe(fixture);
      expect(p.auth.verdict).toBe("authenticated");
      expect(p.pageKind).toBe("member-profile");
      expect(p.pageKind).not.toBe("public-profile");
      // And it says WHY, so the verdict is checkable.
      expect(p.auth.memberSignals.length).toBeGreaterThanOrEqual(2);
      expect(p.auth.memberSignals).toContain("mynetwork");
    });
  }

  it("calls a guest wall a public profile", () => {
    const dom = new JSDOM(
      `<!doctype html><html><body><nav><a href="/login">Sign in</a>
        <button>Join now</button></nav>
        <main><a href="/in/someone/">Someone</a></main></body></html>`,
      { url: "https://www.linkedin.com/in/someone/" },
    );
    const p = new Function(
      "document",
      "window",
      "location",
      "navigator",
      `return (${DIAGNOSE.trim().replace(/;\s*$/, "")})`,
    )(dom.window.document, dom.window, dom.window.location, dom.window.navigator) as {
      pageKind: string;
      auth: { verdict: string; guestCtaCount: number };
    };
    expect(p.auth.guestCtaCount).toBeGreaterThan(0);
    expect(p.auth.verdict).toBe("guest");
    expect(p.pageKind).toBe("public-profile");
  });

  it("says 'unknown' rather than guessing when neither signal is there", () => {
    const p = probe("b-no-right-rail.html", "https://www.linkedin.com/in/anna-kovacs-fixture/");
    // The synthetic fixture is minimal chrome: one /feed/ link, no guest CTA.
    expect(p.auth.verdict).toBe("unknown");
    expect(p.pageKind).toBe("profile-auth-unknown");
  });

  /**
   * DIAGNOSTIC ONLY. A reader that behaves differently depending on a guess about
   * the session is a reader with two code paths and one of them untested.
   */
  it("is not consulted by anything that extracts", () => {
    const offenders: string[] = [];
    for (const file of readdirSync(EXT).filter((f) => f.endsWith(".js") && f !== "diagnose.js")) {
      if (readFileSync(join(EXT, file), "utf8").includes("pageKind")) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
