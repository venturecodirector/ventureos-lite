import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";

/**
 * The selector layer, against the REAL recorded LinkedIn DOM.
 *
 * LinkedIn now ships server-driven UI: every class name is a hash, there is no
 * <h1>, and there are no id anchors. What remains are the framework's own
 * identifiers (`componentkey`, `data-testid`), structure, and visible labels —
 * in that order, with the tier that answered recorded so a silent fall from tier
 * 1 to tier 3 is visible before it becomes a wrong value in somebody's pipeline.
 */
const SELECTORS = readFileSync(join(process.cwd(), "extension/selectors.js"), "utf8");
const CONTENT = readFileSync(join(process.cwd(), "extension/content.js"), "utf8");
const FIXTURES = join(process.cwd(), "test/fixtures/linkedin");

const OWNER = "anonimizalt-odon-scrubbed";

interface Selectors {
  topcardPhotoAnchor(doc: Document): Element | null;
  contactRouteAnchor(doc: Document, slug?: string | null): Element | null;
  contactInfoTextAnchor(doc: Document): Element | null;
  dialogContent(doc: Document): Element | null;
  manualPopovers(doc: Document): Element[];
  profileAnchors(doc: Document): { el: Element; slug: string }[];
  nameHeading(card: Element | null, doc: Document): Element | null;
  locationParagraph(doc: Document, slug?: string | null): Element | null;
  labelKind(heading: string): string | null;
  largestSrcsetCandidate(img: Element | null): string | null;
  once(raw: string | null): string | null;
  resolve(
    s: { tier: string; name: string; find: () => unknown }[],
  ): { value: unknown; tier: string | null; strategy: string | null; trail: string[] };
}

function load(fixture: string): { doc: Document; S: Selectors } {
  const dom = new JSDOM(readFileSync(join(FIXTURES, fixture), "utf8"), {
    url: `https://www.linkedin.com/in/${OWNER}/`,
  });
  const w = dom.window as unknown as Window & { VentureSelectors: Selectors; URL: typeof URL };
  new Function("document", "URL", "globalThis", SELECTORS)(w.document, w.URL, w);
  return { doc: w.document, S: w.VentureSelectors };
}

const REAL = ["real-profile-sdui.html", "real-profile-sdui-2.html"];

describe.each(REAL)("tier 1 — the framework's own identifiers (%s)", (fixture) => {
  const { doc, S } = load(fixture);

  it("finds the top-card photo anchor by componentkey", () => {
    const a = S.topcardPhotoAnchor(doc);
    expect(a).not.toBeNull();
    expect(a!.getAttribute("componentkey")).toContain("topcard-logo-image");
  });

  it("picks the profile photo's LARGEST srcset candidate — 800w, not the cover's 1400w", () => {
    // The trap: the cover photo in the same top card offers a 1400w candidate,
    // so "largest srcset in the top card" selects a landscape banner as an
    // avatar. Scoping to the photo anchor is what prevents it.
    const img = S.topcardPhotoAnchor(doc)!.querySelector("img");
    const url = S.largestSrcsetCandidate(img);
    expect(url).toContain("profile-displayphoto");
    expect(url).toContain("crop_800_800");
    expect(url).not.toMatch(/D4D16AQ/); // the cover photo's asset id
  });

  it("identifies the contact-info trigger by componentkey, not by href", () => {
    // Forty anchors on this page share the identical /overlay/contact-info/
    // href — including a Send button and two reaction counters — so href alone
    // has forty candidates and cannot identify anything.
    const byHref = doc.querySelectorAll('a[href*="overlay/contact-info"]');
    expect(byHref.length).toBeGreaterThan(10);

    const a = S.contactRouteAnchor(doc, OWNER);
    expect(a).not.toBeNull();
    expect(a!.getAttribute("componentkey")).toContain("topcard-logo-image");
  });

  it("sees the native popovers, all of which are in manual state", () => {
    const popovers = S.manualPopovers(doc);
    expect(popovers.length).toBeGreaterThan(0);
    for (const p of popovers) {
      // manual is the one that does NOT close on Escape or an outside click.
      expect(p.getAttribute("popover")).toBe("manual");
    }
  });

  it("finds the dialog-content container the contact route renders into", () => {
    expect(S.dialogContent(doc)).not.toBeNull();
  });
});

describe.each(REAL)("tier 2 — structure (%s)", (fixture) => {
  const { doc, S } = load(fixture);

  it("reads the location from the row holding the Contact info LINK", () => {
    // Anchored on the text anchor, not the photo anchor: the photo's closest div
    // is the photo wrapper and returns nothing. Found by testing against the
    // real fixture rather than by reasoning about it.
    const p = S.locationParagraph(doc, OWNER);
    expect(p).not.toBeNull();
    expect(S.once(p!.textContent)).toBe("Budapest, Hungary");
  });

  it("does not mistake a degree badge for the location", () => {
    const p = S.locationParagraph(doc, OWNER);
    expect(S.once(p!.textContent)).not.toMatch(/^·/);
    expect(S.once(p!.textContent)).not.toMatch(/1st|2nd|3rd/);
  });

  it("collects every /in/ identity on the page, which is what bounds the card", () => {
    const anchors = S.profileAnchors(doc);
    const slugs = new Set(anchors.map((a) => a.slug));
    expect(anchors.length).toBeGreaterThan(50);
    // Many strangers in the rails; exactly one of them is the owner.
    expect(slugs.size).toBeGreaterThan(5);
    expect(slugs.has(OWNER)).toBe(true);
  });
});

describe("tier 3 — overlay labels", () => {
  const { S } = load(REAL[0]!);

  it.each([
    ["Email", "email"],
    ["E-mail", "email"],
    ["Phone", "phone"],
    ["Telefon", "phone"],
    ["Website", "website"],
    ["Weboldal", "website"],
    ["Birthday", "birthday"],
    ["Connected", "connected"],
    ["Address", "address"],
  ])("maps the label %s to %s", (label, kind) => {
    expect(S.labelKind(label)).toBe(kind);
  });

  it("recognises a possessive profile heading", () => {
    expect(S.labelKind("Kovács Anna's Profile")).toBe("profile");
  });

  it("returns null for an unrecognised label rather than guessing", () => {
    expect(S.labelKind("Some New Section")).toBeNull();
  });
});

describe("the tier record", () => {
  const { S } = load(REAL[0]!);

  it("reports which tier answered and every attempt that did not", () => {
    const r = S.resolve([
      { tier: "componentkey", name: "missing-key", find: () => null },
      { tier: "structure", name: "throws", find: () => { throw new Error("x"); } },
      { tier: "text-label", name: "works", find: () => "value" },
    ]);
    expect(r.value).toBe("value");
    expect(r.tier).toBe("text-label");
    expect(r.trail).toEqual([
      "componentkey/missing-key: absent",
      "structure/throws: threw(Error)",
      "text-label/works: found",
    ]);
  });

  it("returns a null value with the full trail when nothing answers", () => {
    const r = S.resolve([{ tier: "componentkey", name: "nope", find: () => null }]);
    expect(r.value).toBeNull();
    expect(r.tier).toBeNull();
    expect(r.trail).toHaveLength(1);
  });
});

/**
 * THE LINT. Class-based selection is what broke this extension twice, and the
 * classes on the real page are hashes like `_36cbea85` — meaningless today and
 * different tomorrow. This fails if one is ever introduced into extraction code.
 */
describe("no CSS class may be used to select anything", () => {
  /**
   * Comments are stripped before scanning. Documenting the banned thing is not
   * doing it — these files explain WHY hashed classes like the ones LinkedIn
   * emits are unusable, and a lint that punished the explanation would push the
   * reasoning out of the code.
   */
  const stripComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

  const EXTRACTION_SOURCES: Array<[string, string]> = [
    ["extension/selectors.js", stripComments(SELECTORS)],
    ["extension/content.js", stripComments(CONTENT)],
  ];

  it("contains no hashed-class selector", () => {
    // The shape LinkedIn actually emits: a leading underscore then hex.
    const hashed = /_[0-9a-f]{6,}/;
    const offenders = EXTRACTION_SOURCES.filter(([, src]) => hashed.test(src)).map(([f]) => f);
    expect(offenders).toEqual([]);
  });

  it("contains no class-based querySelector at all", () => {
    // Any `.someClass` inside a selector string, and any classList/className
    // read used for selection.
    const classSelector = /querySelector(?:All)?\(\s*[`'"][^`'"]*\.[a-zA-Z_-]/;
    const offenders = EXTRACTION_SOURCES.filter(([, src]) => classSelector.test(src)).map(([f]) => f);
    expect(offenders).toEqual([]);
  });

  it("fails when a hashed class is introduced — proving the test has teeth", () => {
    const tampered = `${stripComments(SELECTORS)}\nconst x = document.querySelector("._36cbea85");`;
    expect(/_[0-9a-f]{6,}/.test(tampered)).toBe(true);
    expect(/querySelector(?:All)?\(\s*[`'"][^`'"]*\.[a-zA-Z_-]/.test(tampered)).toBe(true);
  });
});
