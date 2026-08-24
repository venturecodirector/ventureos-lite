import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FLIGHT_MAPPING,
  normalizeFlight,
  type FlightRecord,
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

function recordsFrom(file: string): FlightRecord[] {
  const snapshot = JSON.parse(readFileSync(join(DIR, file), "utf8")) as {
    records: FlightRecord[];
  };
  return snapshot.records.filter((r) => r.body);
}

describe("every rule cites a snapshot that exists", () => {
  it("names a real file, with a real discriminator", () => {
    const rules = Object.values(FLIGHT_MAPPING).flat();
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(() => readFileSync(join(DIR, rule.evidence))).not.toThrow();
      // A rule identifies its node either by a tracked discriminator or by the
      // keys the node carries — one or the other, never neither.
      const byDiscriminator = Boolean(rule.discriminatorPath && rule.discriminator);
      const byKeys = Boolean(rule.keys?.length);
      expect(byDiscriminator || byKeys, `${rule.evidence}: rule identifies nothing`).toBe(true);
      if (byDiscriminator) expect(rule.discriminatorPath).toMatch(/\./);
    }
  });
});

describe("the contact overlay, read by the mapping", () => {
  const fields = normalizeFlight(recordsFrom("contact-overlay.json"));

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

describe("a capture that includes the contact panel", () => {
  const records = recordsFrom("profile-full-2.json");

  /**
   * This one was recorded with the panel OPEN, so the same capture carries both
   * the profile document and the contact rows — which is worth pinning, because
   * the earlier snapshots needed two separate recordings to cover the same
   * ground and the second one exists only for that reason.
   */
  it("supplies the name and the email from one recording", () => {
    const fields = normalizeFlight(records, { slug: "odon-anonimizalt" });
    expect(fields.name).toBeDefined();
    expect(fields.email).toBeDefined();
  });

  it("returns an object rather than throwing, whatever it is handed", () => {
    expect(() => normalizeFlight(records)).not.toThrow();
  });
});

describe("it degrades rather than guessing", () => {
  it("returns nothing for an empty or malformed set of bodies", () => {
    expect(normalizeFlight([])).toEqual({});
    expect(normalizeFlight([{ url: "https://x/", body: { format: "rsc-flight", rows: [] } }])).toEqual({});
    // Shapes it has never seen must not throw.
    expect(
      normalizeFlight([
        { url: "https://x/", body: { format: "rsc-flight", rows: [{ id: "0", tag: null, value: "just a string" }] } },
        { url: "https://x/", body: { format: "rsc-flight", rows: [{ id: "1", tag: null }] } },
      ]),
    ).toEqual({});
  });

  it("survives a self-referential structure", () => {
    const loop: Record<string, unknown> = { a: 1 };
    loop.self = loop;
    expect(() =>
      normalizeFlight([
        { url: "https://x/", body: { format: "rsc-flight", rows: [{ id: "0", tag: null, value: loop }] } },
      ]),
    ).not.toThrow();
  });
});

/**
 * ── ONE CAPTURE, TWO PEOPLE ─────────────────────────────────────────────────
 *
 * A session that walks from one profile to another leaves both in the buffer,
 * and the recorded capture holds exactly that: two profile documents. The name
 * lives in objects with explicit `firstName` and `lastName` keys and no tracked
 * view anywhere near them, so a rule that took the first pair it found would
 * attach one person's name to the other person's lead — silently, and only for
 * operators who browse the way people actually browse.
 *
 * The scoping is therefore the property worth testing, more than the extraction.
 */
describe("a name is read from the right person's record", () => {
  const records = recordsFrom("profile-full-2.json");

  it("finds the name in the record whose url is that profile", () => {
    const fields = normalizeFlight(records, { slug: "odon-anonimizalt" });
    expect(fields.name, "no name found for the profile that has one").toBeDefined();
    expect(fields.name!.via).toBe("keys=firstName+lastName");
    expect(fields.name!.confidence).toBe("high");
    // Scrubbed, so this is the placeholder pair — the POSITION is the assertion.
    expect(fields.name!.value).toMatch(/^<text:\d+> <text:\d+>$/);
  });

  /** THE POINT: the other person's record must not answer for this one. */
  it("returns nothing rather than the other person in the same capture", () => {
    const fields = normalizeFlight(records, { slug: "elek-teszt" });
    expect(
      fields.name,
      "a name was taken from a record belonging to somebody else",
    ).toBeUndefined();
  });

  it("refuses a slug that is in no record at all", () => {
    expect(normalizeFlight(records, { slug: "nobody-here" }).name).toBeUndefined();
  });

  /**
   * With no slug the rule still only reads a profile document — never a
   * component response or an action payload that happens to carry a name.
   */
  it("still restricts itself to a profile document when given no slug", () => {
    const fields = normalizeFlight(records);
    expect(fields.name).toBeDefined();
    expect(fields.name!.path).toMatch(/^\/rows\//);
  });
});

/**
 * ── THE NEGATIVE RESULT, PINNED SO NOBODY DERIVES IT AGAIN ──────────────────
 *
 * `own-profile.json` is a capture of the operator's own profile, and it is the
 * only one where the values were KNOWN — headline, location, company and job
 * title were supplied separately, so each could be matched to its redacted
 * LENGTH. That made a style-based rule testable for the first time.
 *
 * On that profile the answers were exact: the headline is the only Text in
 * eighty-four with `fontSize: xsmall`, `fontWeight: normal` and no
 * `textColorExpression`, and it is 37 characters, matching
 * "Business Developer, C-level Executive" exactly. The location is the only
 * `small`/`normal` Text inside the Topcard node, 17 characters, matching
 * "Budapest, Hungary".
 *
 * Both rules were written and run against a SECOND capture. They returned a
 * 213-character block as the headline and a 5-character string as the location.
 *
 * So they are not shipped, and this test says why — because the next person to
 * open these fixtures will see the same signature and reach the same conclusion,
 * and the evidence that it does not generalise is worth more than the rule.
 */
describe("headline and location stay unmapped, deliberately", () => {
  it("has no rule for either", () => {
    expect(FLIGHT_MAPPING.headline).toEqual([]);
    expect(FLIGHT_MAPPING.location).toEqual([]);
  });

  /**
   * How ambiguous it actually is, measured on both captures.
   *
   * The signature looked unique when it was read off ONE record of one capture.
   * Across the whole fixture it matches six texts on the operator's own profile
   * — 11, 29, 32, 37, 159 and 177 characters — and two on the other. The
   * headline is in there, and the extractor returned it only because document
   * order happened to reach it first.
   *
   * That is the whole lesson, and it is why the rule is not shipped: a signature
   * that is right for the reason "it came first" is not a rule, it is a
   * coincidence with a green test attached.
   */
  const signatureLengths = (file: string): number[] => {
    const snapshot = JSON.parse(readFileSync(join(DIR, file), "utf8")) as {
      records: Array<{ body: unknown }>;
    };
    const lengths: number[] = [];
    const walk = (value: unknown, depth = 0): void => {
      if (depth > 50 || value === null || typeof value !== "object") return;
      if (Array.isArray(value)) {
        for (const v of value) walk(v, depth + 1);
        return;
      }
      const node = value as Record<string, unknown>;
      const props = node.textProps as Record<string, unknown> | undefined;
      if (
        props &&
        props.fontSize === "xsmall" &&
        props.fontWeight === "normal" &&
        (node.textColorExpression === undefined || node.textColorExpression === "$undefined")
      ) {
        const children = props.children;
        const text = Array.isArray(children) ? children[0] : null;
        const m = typeof text === "string" ? /^<text:(\d+)>$/.exec(text) : null;
        if (m) lengths.push(Number(m[1]));
      }
      for (const v of Object.values(node)) walk(v, depth + 1);
    };
    for (const record of snapshot.records) walk(record.body);
    return lengths.sort((a, b) => a - b);
  };

  it("matches several texts on the profile it was derived from, not one", () => {
    const lengths = signatureLengths("own-profile.json");
    // The headline is 37 characters — "Business Developer, C-level Executive".
    expect(lengths).toContain(37);
    expect(lengths.length, `only ${lengths.join(", ")} matched`).toBeGreaterThan(1);
  });

  it("matches a paragraph on another profile, which is what killed the rule", () => {
    const lengths = signatureLengths("profile-full-2.json");
    // A headline is capped at 220 characters, so "under the limit" cannot
    // separate one from a block of prose.
    expect(lengths.some((n) => n > 150), `matched only ${lengths.join(", ")}`).toBe(true);
  });
});
