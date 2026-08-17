import { describe, it, expect } from "vitest";
import { captureBodySchema } from "../../src/modules/capture/body";
import {
  CAPTURE_BEGIN,
  CAPTURE_END,
  composeCapturedNotes,
  mergeCapturedNotes,
} from "../../src/modules/capture/notes";
import { hasAnalyzableText, researchSource } from "../../src/modules/leads/preparse";

/**
 * The join between a capture and a research run.
 *
 * These two halves were built separately and never met: the extension read a
 * profile and the endpoint stored every field it read, but `runResearch` looks
 * for prose in `notes` and nothing ever wrote any. Every extension-captured
 * lead therefore refused research for ever, with a message telling the user to
 * do the thing they had just done.
 */
const body = (over: Record<string, unknown> = {}) =>
  captureBodySchema.parse({
    url: "https://www.linkedin.com/in/nagy-anna",
    name: "Nagy Anna",
    headline: "Ügyvezető @ Danubia Fogászat",
    companyName: "Danubia Fogászat Kft.",
    location: "Budapest, Hungary",
    jobTitle: "Ügyvezető",
    email: "anna@danubia.hu",
    phone: "+36 30 123 4567",
    websiteUrl: "https://www.danubia-fogaszat.hu",
    bio: "Fogászati rendelőt vezetek Budán 1998 óta. Négy székkel és hat kollégával dolgozunk.",
    posts: ["Új CBCT-t állítottunk be a héten."],
    ...over,
  });

describe("a capture written as notes", () => {
  it("produces text a research call will accept", () => {
    // The whole point: this is the check that used to fail on every captured
    // lead, because the string being checked was empty.
    expect(hasAnalyzableText(composeCapturedNotes(body()))).toBe(true);
  });

  it("keeps every field the extension managed to read", () => {
    const notes = composeCapturedNotes(body());
    for (const expected of [
      "Nagy Anna",
      "Ügyvezető @ Danubia Fogászat",
      "Danubia Fogászat Kft.",
      "Budapest, Hungary",
      "anna@danubia.hu",
      "+36 30 123 4567",
      "danubia-fogaszat.hu",
      "Fogászati rendelőt vezetek",
      "Új CBCT-t",
    ]) {
      expect(notes).toContain(expected);
    }
  });

  it("omits what was not read rather than writing empty labels", () => {
    const notes = composeCapturedNotes(body({ email: null, phone: null, bio: null, posts: [] }));
    expect(notes).not.toContain("Email:");
    expect(notes).not.toContain("About:");
    expect(notes).toContain("Nagy Anna");
  });

  it("is worth analysing on a bio alone, and not on a bare URL", () => {
    expect(
      hasAnalyzableText(
        composeCapturedNotes(
          body({ name: null, headline: null, companyName: null, location: null, jobTitle: null, email: null, phone: null, websiteUrl: null, posts: [] }),
        ),
      ),
    ).toBe(true);
    expect(
      hasAnalyzableText(
        composeCapturedNotes(
          body({ name: null, headline: null, companyName: null, location: null, jobTitle: null, email: null, phone: null, websiteUrl: null, bio: null, posts: [] }),
        ),
      ),
    ).toBe(false);
  });
});

describe("merging a re-capture into notes somebody has been using", () => {
  const block = composeCapturedNotes(body());

  it("writes the block outright when there is nothing there", () => {
    expect(mergeCapturedNotes(null, block)).toBe(block);
    expect(mergeCapturedNotes("   ", block)).toBe(block);
  });

  it("keeps a human's own note, putting it first", () => {
    const merged = mergeCapturedNotes("Met her at the trade fair.", block);
    expect(merged.indexOf("trade fair")).toBeLessThan(merged.indexOf(CAPTURE_BEGIN));
    expect(merged).toContain("Nagy Anna");
  });

  it("replaces the previous capture rather than stacking a second one", () => {
    const older = mergeCapturedNotes("Met her at the trade fair.", composeCapturedNotes(body({ bio: "Régi szöveg." })));
    const merged = mergeCapturedNotes(older, block);
    expect(merged.split(CAPTURE_BEGIN)).toHaveLength(2);
    expect(merged.split(CAPTURE_END)).toHaveLength(2);
    expect(merged).not.toContain("Régi szöveg.");
    expect(merged).toContain("trade fair");
  });

  it("keeps text written on BOTH sides of the captured block", () => {
    const before = `Above the block.\n\n${block}\n\nBelow the block.`;
    const merged = mergeCapturedNotes(before, composeCapturedNotes(body({ bio: "Friss szöveg." })));
    expect(merged).toContain("Above the block.");
    expect(merged).toContain("Below the block.");
    expect(merged).toContain("Friss szöveg.");
  });
});

describe("what a research run is allowed to read", () => {
  it("reads the structured fields, so a lead captured before the fix still works", () => {
    // No notes at all — every lead the extension captured until now.
    const source = researchSource({
      notes: null,
      bio: "Fogászati rendelőt vezetek Budán 1998 óta. Négy székkel és hat kollégával dolgozunk.",
      title: "Ügyvezető",
      contactName: "Nagy Anna",
      company: { name: "Danubia Fogászat Kft." },
    });
    expect(hasAnalyzableText(source)).toBe(true);
    expect(source).toContain("Nagy Anna — Ügyvezető");
  });

  it("still refuses a lead that really has nothing on it", () => {
    // The score gate's sibling: hard rule #3 says no Claude call without input.
    expect(
      hasAnalyzableText(researchSource({ notes: null, bio: null, title: null, contactName: "Nagy Anna" })),
    ).toBe(false);
  });
});

describe("the photo URL the body accepts", () => {
  it("takes an https address", () => {
    const parsed = body({ photoUrl: "https://media.licdn.com/dms/image/x/profile-displayphoto/1" });
    expect(parsed.photoUrl).toBe("https://media.licdn.com/dms/image/x/profile-displayphoto/1");
  });

  it.each([
    ["data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==", "the lazy-load placeholder"],
    ["blob:https://www.linkedin.com/abc-123", "a blob handle"],
    ["javascript:alert(1)", "a script URL"],
  ])("drops %s (%s)", (url) => {
    // A data: URL parses fine, which is how the placeholder used to travel all
    // the way to the avatar store and be refused there — the capture claimed a
    // photo it did not have, and the lead showed initials.
    expect(body({ photoUrl: url }).photoUrl).toBeUndefined();
  });
});
