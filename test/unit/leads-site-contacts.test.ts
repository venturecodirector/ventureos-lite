import { describe, it, expect } from "vitest";
import { extractSiteContacts } from "../../src/modules/leads/enrichment";
import { prospectClassificationSchema } from "../../src/lib/ai/prompts/prospect-classify";

/**
 * Contacts from a company's own web page, and the classifier's output shape.
 *
 * ── THE REPORTED PROBLEM ────────────────────────────────────────────────────
 *
 * "If the lead comes from Google there is no phone number and no email — that is
 * impossible." Right about the company, wrong about the source: Google Places
 * carries a name, an address, a phone and a website, and no email for any
 * business, ever. The address is on the company's own site, in a footer or an
 * impresszum — in the page we were already downloading for its copy and then
 * throwing the markup away.
 */
describe("reading contacts out of a company's page", () => {
  const PAGE = `
    <html><head><title>Danubia Fogászat</title></head>
    <body>
      <header><a href="/">Danubia Fogászat</a></header>
      <p>Rendelőnk Budán várja a pácienseket.</p>
      <footer>
        <a href="mailto:info@danubia-fogaszat.hu">Írjon nekünk</a>
        <a href="tel:+3612345678">Hívjon minket</a>
        <p>Recepció: recepcio@danubia-fogaszat.hu</p>
      </footer>
    </body></html>`;

  it("reads a mailto: address the text extraction would have destroyed", () => {
    const c = extractSiteContacts(PAGE);
    expect(c.emails).toContain("info@danubia-fogaszat.hu");
  });

  it("reads a tel: link and normalises it", () => {
    const c = extractSiteContacts(PAGE);
    expect(c.phones.length).toBeGreaterThan(0);
    expect(c.phones[0]).toMatch(/^\+36/);
  });

  it("also finds an address printed in the text without a link", () => {
    expect(extractSiteContacts(PAGE).emails).toContain("recepcio@danubia-fogaszat.hu");
  });

  /** An address nobody reads is not a way to reach anybody. */
  it("drops no-reply and system addresses", () => {
    const html = `<a href="mailto:no-reply@acme.hu">x</a>
                  <a href="mailto:postmaster@acme.hu">y</a>
                  <a href="mailto:hello@acme.hu">z</a>`;
    const c = extractSiteContacts(html);
    expect(c.emails).toEqual(["hello@acme.hu"]);
  });

  it("drops template placeholders and asset filenames", () => {
    const html = `<a href="mailto:you@example.com">x</a>
                  <p>logo@2x.png</p>
                  <a href="mailto:iroda@valodi.hu">y</a>`;
    expect(extractSiteContacts(html).emails).toEqual(["iroda@valodi.hu"]);
  });

  it("de-duplicates an address that is both linked and printed", () => {
    const html = `<a href="mailto:info@acme.hu">Ír</a><p>info@acme.hu</p>`;
    expect(extractSiteContacts(html).emails).toEqual(["info@acme.hu"]);
  });

  it("caps what it returns, so a link farm cannot fill the field", () => {
    const html = Array.from({ length: 40 }, (_, i) => `<a href="mailto:a${i}@acme.hu">x</a>`).join("");
    expect(extractSiteContacts(html).emails.length).toBeLessThanOrEqual(5);
  });

  it("returns empty rather than throwing on a page with nothing in it", () => {
    for (const html of ["", "<html></html>", "not html at all"]) {
      expect(() => extractSiteContacts(html)).not.toThrow();
      expect(extractSiteContacts(html).emails).toEqual([]);
    }
  });

  it("decodes an entity-escaped mailto", () => {
    const html = `<a href="mailto:info%40acme.hu">x</a>`;
    expect(extractSiteContacts(html).emails).toEqual(["info@acme.hu"]);
  });
});

/**
 * The other production error: `ClaudeJsonError: ... items: Required`.
 *
 * The system prompt asked for "one entry per input index" and never said what the
 * JSON should look like, so the model answered with a bare array — which is a
 * reasonable reading of an ambiguous instruction. Validation then failed after
 * the repair retry, costing two Haiku calls and showing the operator an opaque
 * server error.
 */
describe("the prospect classifier's output shape", () => {
  const ITEMS = [
    { index: 0, fit: "strong" as const, priority: 1, note: "no website" },
    { index: 1, fit: "skip" as const, priority: 5, note: null },
  ];

  it("accepts the documented object shape", () => {
    const parsed = prospectClassificationSchema.parse({ items: ITEMS });
    expect(parsed.items).toHaveLength(2);
  });

  /** THE FIX FOR THE LOGGED ERROR. */
  it("accepts a bare array, which is what the old prompt actually invited", () => {
    const parsed = prospectClassificationSchema.parse(ITEMS);
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0]!.fit).toBe("strong");
  });

  it("still refuses something that is neither", () => {
    for (const bad of [null, 42, "items", { rows: ITEMS }, { items: "nope" }]) {
      expect(() => prospectClassificationSchema.parse(bad)).toThrow();
    }
  });

  it("still enforces the per-item rules", () => {
    expect(() =>
      prospectClassificationSchema.parse([{ index: 0, fit: "maybe", priority: 1 }]),
    ).toThrow();
    expect(() =>
      prospectClassificationSchema.parse([{ index: 0, fit: "strong", priority: 9 }]),
    ).toThrow();
  });
});

/**
 * The prompt is the real fix; the preprocess above is the belt. If the prompt
 * ever loses its shape instruction the model will drift back to a bare array, so
 * the instruction itself is asserted.
 */
describe("the prompt states the shape it wants", () => {
  it("shows the exact JSON envelope", async () => {
    const { PROSPECT_CLASSIFY_SYSTEM } = await import(
      "../../src/lib/ai/prompts/prospect-classify"
    );
    expect(PROSPECT_CLASSIFY_SYSTEM).toContain('{"items":[');
    expect(PROSPECT_CLASSIFY_SYSTEM).toMatch(/not a bare array/i);
  });
});
