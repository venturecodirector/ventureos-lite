import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";

/**
 * The post-RSC page, from a capture that reported a real failure.
 *
 * ── WHAT THE DIAGNOSTIC SAID ────────────────────────────────────────────────
 *
 *   headline: present false
 *             attempted ["topcard:rejected(headline_reads_as_a_location)", …]
 *
 * Everything else came through — name, company, location, job title, bio, photo.
 * So this is not "the layout changed" in the sense of anchors moving: the top
 * card is being read, and the VALIDATOR is throwing the headline away because it
 * looks like a location to it.
 *
 * The fixture is that page, scrubbed by the extension's own snapshot tool.
 */
const FIXTURE = join(process.cwd(), "test/fixtures/linkedin/i-rsc-headline-rejected.html");
const EXT = join(process.cwd(), "extension");
const read = (f: string) => readFileSync(join(EXT, f), "utf8");

function extract() {
  const dom = new JSDOM(readFileSync(FIXTURE, "utf8"), {
    url: "https://www.linkedin.com/in/odon-anonimizalt-1a2b3c4d/",
    runScripts: "outside-only",
  });
  const g: Record<string, unknown> = {};
  const inject = (src: string) =>
    new Function("globalThis", "window", "document", src)(g, dom.window, dom.window.document);
  inject(read("selectors.js"));
  inject(read("names.js"));
  inject(read("contact-parse.js"));
  // content.js is an expression (an IIFE's body) — the same way the machine test
  // evaluates it, so this measures the real extractor and not a copy of it.
  const fn = new Function(
    "document",
    "window",
    "location",
    "URL",
    "globalThis",
    `return (${read("content.js").trim().replace(/;\s*$/, "")})`,
  );
  return fn(dom.window.document, dom.window, dom.window.location, dom.window.URL, g) as {
    name?: string;
    headline?: string;
    location?: string;
    companyName?: string;
    jobTitle?: string;
    bio?: string;
    skipped: Record<string, string>;
    provenance: Record<string, { source: string; confidence: string }>;
    _attempts: Record<string, string[]>;
  };
}

describe("the post-RSC profile page", () => {
  it("loads as a fixture at all", () => {
    const html = readFileSync(FIXTURE, "utf8");
    expect(html.length).toBeGreaterThan(100_000);
    // The anchor the extractor depends on is still there.
    expect(html).toContain("topcard-logo-image");
  });

  it("carries no member id and no owner name", () => {
    const html = readFileSync(FIXTURE, "utf8");
    expect(/ACoAA(?!SCRUBBED)[A-Za-z0-9_-]{5,}/.test(html), "a real member id survived").toBe(false);
    expect(/M[áa]t[ée]\b/.test(html), "the owner's first name survived").toBe(false);
  });
});

describe("what the extractor gets from it", () => {
  const out = extract();

  it("reads the fields the diagnostic said it read", () => {
    for (const field of ["name", "location", "companyName", "jobTitle"] as const) {
      expect(out[field], `${field} was not read`).toBeTruthy();
    }
  });

  /**
   * ── THE HEADLINE, AND WHY IT WAS LOST ─────────────────────────────────────
   *
   * The pruning pass drops a line that contains another, so that a container's
   * concatenated text does not read as a card line. On this page that rule ate
   * the headline: LinkedIn renders the current company as its own chip, so
   *
   *     "Partner & Head of Business Development at JeansDay Marketing"
   *
   * contains "JeansDay Marketing" — as EVERY headline of the form "<role> at
   * <company>" does once the company is also a chip. With the headline gone the
   * card held three chips, and the validator rejected each in turn: the location
   * for reading as a location, the company and the school for having no headline
   * signal. Hence "the headline could not be read", on a page where it is
   * plainly there.
   *
   * An aggregate contains SEVERAL other lines — the glued name+degree+headline
   * line here contains five. One is a coincidence.
   */
  it("reads the headline that the containment rule used to delete", () => {
    expect(out.headline).toBe("Partner & Head of Business Development at JeansDay Marketing");
    expect(out.skipped.headline).toBeUndefined();
  });

  /**
   * ── THE EMPLOYER, AND WHY IT WAS A DATE ───────────────────────────────────
   *
   * The experience reader took the entry's second line as the employer. This
   * entry has none — role, then dates — so `companyName` came back as
   * "Jan 2015 - Jul 2020" with `experience:accepted` and HIGH confidence, and
   * would have gone into a lead that way. Skipping the dates was not enough
   * either: the next line down is a skill, "External Communications", which is
   * wrong in a more convincing way.
   */
  it("does not offer a date range, or a skill, as the employer", () => {
    expect(out.companyName).not.toMatch(/\d{4}/);
    expect(out.companyName).not.toBe("External Communications");
  });

  it("reads the CURRENT employer instead", () => {
    expect(out.companyName).toBe("JeansDay Marketing");
  });

  /**
   * ── AND THE PAIR THAT NEVER EXISTED ───────────────────────────────────────
   *
   * With the employer coming from the current headline and the title still
   * coming from an entry that ended in 2020, the lead read "PR & Marketing
   * Consultant at JeansDay Marketing" — two true facts and one false pairing.
   * Role and employer are one fact and are now read together or not at all.
   */
  it("pairs the role with the employer it actually belongs to", () => {
    expect(out.jobTitle).toBe("Partner & Head of Business Development");
    expect(out.companyName).toBe("JeansDay Marketing");
    expect(out.headline).toContain(out.jobTitle!);
    expect(out.headline).toContain(out.companyName!);
  });

  it("still reads the name and the location", () => {
    expect(out.name).toBe("Anonimizált Ödön");
    expect(out.location).toBe("Budapest, Hungary");
  });
});
