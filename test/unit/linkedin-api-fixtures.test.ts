import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The first recorded LinkedIn payloads, and the two things they have to be.
 *
 * ── WHY THESE FILES EXIST ───────────────────────────────────────────────────
 *
 * The re-architecture's rule is that nothing is mapped that has not been seen in
 * a recorded snapshot, because six rounds of DOM fixes failed precisely by
 * reasoning about a shape instead of looking at one. This directory was empty for
 * that entire time, on the belief that LinkedIn server-renders the profile and
 * there was nothing to record. The census disproved it: the profile is fetched as
 * React Server Components, `application/octet-stream`, and our JSON filter had
 * been declining it unread.
 *
 * ── THE TWO THINGS, AND THEY PULL AGAINST EACH OTHER ────────────────────────
 *
 * NO PEOPLE, because these go into version control (CLAUDE.md hard rule 9), and
 * the first attempt at scrubbing this format let through 52 strangers' slugs, 126
 * member ids, a live email address and 1351 name occurrences.
 *
 * ENOUGH STRUCTURE to derive a mapping from, or the file teaches nothing. The
 * discriminators survive: `viewTrackingSpecs.viewName` says which contact field
 * a subtree is, and the values are shape placeholders in the right positions.
 */
const DIR = join(process.cwd(), "test/fixtures/linkedin-api");
const files = readdirSync(DIR).filter((f) => f.endsWith(".json"));

interface Snapshot {
  snapshotVersion: number;
  label: string;
  recordCount: number;
  records: Array<{
    url: string;
    contentType: string;
    bodyFormat: string | null;
    parseError: string | null;
    body: { format: string; rowCount: number; rows: unknown[] } | null;
  }>;
}

const load = (name: string): Snapshot =>
  JSON.parse(readFileSync(join(DIR, name), "utf8")) as Snapshot;

describe("the recorded snapshots exist and parsed", () => {
  it("there is at least a profile and a contact overlay", () => {
    expect(files).toContain("rsc-profile.json");
    expect(files).toContain("contact-overlay.json");
  });

  it("every record parsed, as JSON or as RSC flight", () => {
    for (const name of files) {
      for (const record of load(name).records) {
        expect(record.parseError, `${name} ${record.url}`).toBeNull();
        expect(["json", "rsc-flight"]).toContain(record.bodyFormat);
      }
    }
  });

  /** The payload that used to be declined unread. */
  it("the profile arrives as octet-stream and is read as RSC flight", () => {
    const flight = load("rsc-profile.json").records.filter(
      (r) => r.bodyFormat === "rsc-flight",
    );
    expect(flight.length).toBeGreaterThan(0);
    expect(flight.some((r) => /octet-stream/.test(r.contentType))).toBe(true);
    for (const r of flight) expect(r.body!.rowCount).toBeGreaterThan(0);
  });
});

/**
 * ── NO PEOPLE ───────────────────────────────────────────────────────────────
 *
 * Every pattern this session has actually been burned by, asserted over the raw
 * file text rather than a parsed view — a leak in a key, a URL or a nested string
 * is still a leak, and one of them (an accented slug, percent-encoded) survived a
 * parsed-value check once already.
 */
describe("no person survives in a committed snapshot", () => {
  const FORBIDDEN: Array<[string, RegExp]> = [
    ["a LinkedIn member id", /ACoAA[A-Za-z0-9_-]{5,}/],
    ["an email address", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
    // A quoted string that is entirely a long number: a phone number reads as
    // "just digits and punctuation", which is how one got through.
    ["a phone-shaped string", /"\+?\d[\d ()/-]{7,}\d"/],
    ["a signed image token", /[?&]t=[A-Za-z0-9_-]{20,}/],
    ["percent-encoded accented text", /%C3%A[0-9A-F][a-z]/i],
  ];

  for (const name of files) {
    const raw = readFileSync(join(DIR, name), "utf8");
    for (const [what, pattern] of FORBIDDEN) {
      it(`${name} contains no ${what}`, () => {
        const hit = pattern.exec(raw);
        expect(hit?.[0], `found: ${hit?.[0]}`).toBeUndefined();
      });
    }

    /**
     * Slugs are allowed ONLY in their placeholder form. The scrubber names people
     * from a fixed cast, so any other slug in a `/in/` path is a real person.
     */
    it(`${name} carries only placeholder profile slugs`, () => {
      const cast =
        /^(odon-anonimizalt|elek-teszt|anna-pelda|bela-minta|cecilia-proba|denes-fiktiv|emese-alnev|ferenc-nevtelen|gabor-ismeretlen)$/;
      const found = new Set<string>();
      for (const m of raw.matchAll(/\/in\/([A-Za-z0-9][A-Za-z0-9%_-]{2,})/g)) {
        if (!cast.test(m[1]!)) found.add(m[1]!);
      }
      expect([...found], "real slugs in the fixture").toEqual([]);
    });
  }
});

/**
 * ── ENOUGH STRUCTURE ────────────────────────────────────────────────────────
 *
 * This is the half that a redaction-happy scrubber quietly destroys, and the
 * reason a fixture can be "clean" and worthless at the same time. What the
 * mapping will key off is asserted here, so a future change to the scrubber
 * cannot take it away silently.
 */
describe("the contact overlay still teaches which field is which", () => {
  const overlay = load("contact-overlay.json");
  const text = JSON.stringify(overlay);

  it("keeps the sdui screen id that identifies the panel", () => {
    expect(text).toContain("com.linkedin.sdui.flagshipnav.profile.ProfileContactDetailsOverlay");
  });

  /**
   * THE DISCRIMINATOR. `viewTrackingSpecs.viewName` names each contact row, so a
   * mapping can find the email subtree without knowing a label's wording — which
   * matters because the labels are localised and this account's are Hungarian.
   */
  it("keeps a viewName for each contact row", () => {
    for (const field of ["contact-email", "contact-phone", "contact-website"]) {
      expect(text, `${field} is not in the fixture`).toContain(field);
    }
  });

  /** The values are gone, but their SHAPE and position remain. */
  it("marks where the values were, by kind", () => {
    expect(text).toContain("<email>");
    expect(text).toContain("<url>");
  });

  it("is small, because it holds only what the profile snapshot does not", () => {
    // The other ten records were identical to the profile snapshot's.
    expect(overlay.recordCount).toBeLessThanOrEqual(3);
  });
});
