import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FLIGHT_MAPPING,
  normalizeFlight,
  type FlightBody,
} from "../../src/modules/capture/linkedin-api";

/**
 * The first field mapping derived from a RECORDED payload, run against it.
 *
 * ── WHY THIS TEST IS THE POINT OF THE WHOLE RE-ARCHITECTURE ─────────────────
 *
 * Six rounds of DOM fixes failed by reasoning about a shape instead of looking at
 * one. So the rule was: nothing is mapped that has not been seen in a recorded
 * snapshot, and every rule cites the file. This is that test — the extractor run
 * against the committed evidence, not against a hand-written example of what the
 * payload might look like.
 *
 * The fixture's VALUES are scrubbed, and that is fine: what a mapping has to get
 * right is WHERE a field lives. `mailto:<email>` at the right path proves the
 * locator; a real address at the wrong path would prove nothing.
 */
const DIR = join(process.cwd(), "test/fixtures/linkedin-api");

function bodiesFrom(file: string): FlightBody[] {
  const snapshot = JSON.parse(readFileSync(join(DIR, file), "utf8")) as {
    records: Array<{ bodyFormat: string | null; body: FlightBody | null }>;
  };
  return snapshot.records
    .filter((r) => r.bodyFormat === "rsc-flight" && r.body)
    .map((r) => r.body!);
}

describe("every rule cites a snapshot that exists", () => {
  it("names a real file, with a real discriminator", () => {
    const rules = Object.values(FLIGHT_MAPPING).flat();
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(() => readFileSync(join(DIR, rule.evidence))).not.toThrow();
      expect(rule.discriminator.length).toBeGreaterThan(0);
      expect(rule.discriminatorPath).toMatch(/\./);
    }
  });
});

describe("the contact overlay, read by the mapping", () => {
  const fields = normalizeFlight(bodiesFrom("contact-overlay.json"));

  it("finds the email, by its tracking name rather than its label", () => {
    expect(fields.email, "the email field was not located").toBeDefined();
    // Scrubbed, so this is the placeholder — the POSITION is what is asserted.
    expect(fields.email!.value).toBe("<email>");
    expect(fields.email!.via).toBe("viewTrackingSpecs.viewName=contact-email");
    expect(fields.email!.confidence).toBe("high");
    expect(fields.email!.source).toBe("api");
  });

  it("finds the phone by its SHAPE, not by position", () => {
    expect(fields.phone, "the phone field was not located").toBeDefined();
    // `<phone>` is what the scrubber leaves where a number was — so the
    // extractor recognised a phone-shaped value, rather than taking whatever
    // string came first.
    expect(fields.phone!.value).toBe("<phone>");
    expect(fields.phone!.via).toBe("viewTrackingSpecs.viewName=contact-phone");
  });

  /**
   * ── THE BUG THIS PINS ─────────────────────────────────────────────────────
   *
   * The first version of the extractor took "the first string that is not
   * scaffolding". Against the RAW payload that is
   * `gpRhtA9jSFObSQRBJwS5vQ==` — the node's own `contentTrackingId` — and the
   * fixture test passed regardless, because it only checked that something had
   * been found at that position. A plausible wrong answer under a green test is
   * the precise failure this module exists to prevent, and it got within one
   * commit of shipping.
   *
   * Two things stop it now: the walk skips `viewTrackingSpecs` entirely, and
   * every rule names the shape it wants.
   */
  it("never returns tracking metadata as a value", () => {
    for (const field of Object.values(fields)) {
      expect(field.value, "a base64 tracking id came back as a field").not.toMatch(
        /^[A-Za-z0-9+/]{16,}={0,2}$/,
      );
      expect(field.value).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/); // a componentKey
      expect(field.value).not.toMatch(/^contact[_-]/); // the discriminator itself
    }
  });

  it("reports where it found each one, for the diagnostics", () => {
    for (const field of Object.values(fields)) {
      expect(field.path).toMatch(/^\/rows\//);
    }
  });

  /**
   * The label wording is NOT part of the mapping. This account's panel is in
   * Hungarian, and a mapping keyed on "Email" would have worked on an English
   * account and silently failed here — the exact shape of bug this whole
   * exercise exists to stop.
   */
  it("depends on no localised label text", () => {
    const source = readFileSync(
      join(process.cwd(), "src/modules/capture/linkedin-api.ts"),
      "utf8",
    );
    for (const label of ["E-mail", "Telefon", "Weboldal", "Email address", "Phone number"]) {
      expect(source, `the mapping keys off the label "${label}"`).not.toContain(`"${label}"`);
    }
  });
});

describe("the profile snapshot has no contact panel, and says so by omission", () => {
  const fields = normalizeFlight(bodiesFrom("rsc-profile.json"));

  /**
   * The contact rows only exist once the panel has been opened — which is why
   * there are two snapshots. A mapping that "found" an email here would be
   * matching something else, and that is worth pinning.
   */
  it("finds no email in a profile view where the panel was never opened", () => {
    expect(fields.email).toBeUndefined();
  });

  it("returns an object rather than throwing on a payload with none of its keys", () => {
    expect(() => normalizeFlight(bodiesFrom("rsc-profile.json"))).not.toThrow();
  });
});

describe("it degrades rather than guessing", () => {
  it("returns nothing for an empty or malformed set of bodies", () => {
    expect(normalizeFlight([])).toEqual({});
    expect(normalizeFlight([{ format: "rsc-flight", rows: [] }])).toEqual({});
    // Shapes it has never seen must not throw.
    expect(
      normalizeFlight([
        { format: "rsc-flight", rows: [{ id: "0", tag: null, value: "just a string" }] },
        { format: "rsc-flight", rows: [{ id: "1", tag: null }] },
      ]),
    ).toEqual({});
  });

  it("survives a self-referential structure", () => {
    const loop: Record<string, unknown> = { a: 1 };
    loop.self = loop;
    expect(() =>
      normalizeFlight([{ format: "rsc-flight", rows: [{ id: "0", tag: null, value: loop }] }]),
    ).not.toThrow();
  });
});
