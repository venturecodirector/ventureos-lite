import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";

/**
 * The snapshot scrubber must preserve slug SHAPE.
 *
 * This is why the /in/mgoldberger bug could not be reproduced from a snapshot.
 * The scrubber rewrote every owner slug to a fixed `anonimizalt-odon-scrubbed` —
 * three hyphenated tokens, which the name validator handles perfectly — so the
 * one-token first-initial-plus-surname shape that actually broke it was scrubbed
 * away along with the identity.
 *
 * The identity is still fully replaced. What survives is structure: how many
 * tokens, whether the first is an initial, whether there is a trailing
 * disambiguator and how long it is. None of that is personal data, and all of it
 * is what the validator is tested against.
 */
const SNAPSHOT = readFileSync(join(process.cwd(), "extension/snapshot.js"), "utf8");

async function scrub(slug: string, title = "Somebody Real | LinkedIn") {
  const dom = new JSDOM(
    `<!doctype html><html><head><title>${title}</title></head><body>
      <main><a href="/in/${slug}/">Somebody Real</a></main></body></html>`,
    { url: `https://www.linkedin.com/in/${slug}/` },
  );
  const result = await new Function(
    "document",
    "window",
    "location",
    "navigator",
    `return (${SNAPSHOT.trim().replace(/;\s*$/, "")})`,
  )(dom.window.document, dom.window, dom.window.location, dom.window.navigator);
  return result as { url: string; html: string; slugShape: { real: number; placeholder: string } };
}

const tokens = (slug: string) => slug.split("-").filter(Boolean);
const placeholderOf = (url: string) => /\/in\/([^/]+)/.exec(url)![1]!;

describe("the placeholder slug mirrors the real slug's shape", () => {
  it("keeps a one-token initial+surname slug as one token — THE mgoldberger case", async () => {
    const out = await scrub("mgoldberger");
    const p = placeholderOf(out.url);
    expect(tokens(p)).toHaveLength(1);
    // First initial then a full surname, which is the shape that broke the rule.
    expect(p).toMatch(/^[a-z][a-z]{4,}$/);
    expect(p).not.toBe("anonimizalt-odon-scrubbed");
  });

  it("keeps a three-token slug as three tokens", async () => {
    for (const slug of ["tamas-daniel-vezer", "tom-vechy-vecsernyes"]) {
      expect(tokens(placeholderOf((await scrub(slug)).url)), slug).toHaveLength(3);
    }
  });

  it("keeps a two-token slug as two", async () => {
    expect(tokens(placeholderOf((await scrub("anna-kovacs")).url))).toHaveLength(2);
  });

  it("keeps a trailing disambiguator, and its length", async () => {
    const p = placeholderOf((await scrub("beata-ferenczi-3802a22b0")).url);
    const last = tokens(p).at(-1)!;
    expect(last).toMatch(/^[a-z0-9]+$/);
    expect(last).toMatch(/\d/);
    expect(last).toHaveLength("3802a22b0".length);
  });

  it("replaces the identity completely, in the html as well as the url", async () => {
    const out = await scrub("mgoldberger", "Mark Goldberger | LinkedIn");
    // THE POINT: shape survives, the person does not.
    expect(out.html).not.toContain("mgoldberger");
    expect(out.html).not.toContain("Goldberger");
    expect(out.url).not.toContain("goldberger");
  });
});
