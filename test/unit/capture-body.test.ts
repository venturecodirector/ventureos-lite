import { describe, it, expect } from "vitest";
import { captureBodySchema } from "@/modules/capture/body";

/**
 * The bug this file exists for.
 *
 * content.js returns `null` for every selector that misses. The server declared
 * those fields `.optional()`, which in Zod accepts `undefined` and NOT `null` —
 * so one missing headline failed the entire body with 400, and the popup, which
 * has no 400 branch on the capture path, showed a flat "Capture failed."
 *
 * It was invisible because the extension's own "Test connection" button posts a
 * deliberately invalid payload and reads 400 as SUCCESS. A passing test and a
 * failing capture were the same HTTP status.
 */
const REAL_PROFILE_URL = "https://www.linkedin.com/in/valaki";

describe("what the content script actually sends", () => {
  it("accepts nulls for every selector that missed", () => {
    // Verbatim shape from extension/content.js on a page whose DOM has moved.
    const parsed = captureBodySchema.safeParse({
      url: REAL_PROFILE_URL,
      name: "Nagy Anna",
      headline: null,
      companyName: null,
      location: null,
      bio: null,
      photoUrl: undefined,
      posts: [],
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.name).toBe("Nagy Anna");
    // Null becomes absent, not the string "null".
    expect(parsed.data.headline).toBeUndefined();
    expect(parsed.data.bio).toBeUndefined();
  });

  it("accepts a capture where EVERY optional field missed", () => {
    // The worst realistic case: LinkedIn reshuffled everything. The URL alone is
    // still worth a lead.
    const parsed = captureBodySchema.safeParse({
      url: REAL_PROFILE_URL,
      name: null,
      headline: null,
      companyName: null,
      location: null,
      bio: null,
      posts: [],
    });
    expect(parsed.success).toBe(true);
  });

  it("still refuses a body with no usable URL, which is the one required field", () => {
    // The URL identifies the lead and is what dedupe keys on.
    expect(captureBodySchema.safeParse({ url: "test" }).success).toBe(false);
    expect(captureBodySchema.safeParse({}).success).toBe(false);
  });
});

describe("oversized reads degrade rather than fail", () => {
  it("truncates a long bio instead of throwing the capture away", () => {
    const parsed = captureBodySchema.safeParse({
      url: REAL_PROFILE_URL,
      bio: "a".repeat(20_000),
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.bio).toHaveLength(8000);
  });

  it("drops an unusable photo URL rather than losing the person", () => {
    const tooLong = captureBodySchema.safeParse({
      url: REAL_PROFILE_URL,
      photoUrl: `https://media.licdn.com/${"x".repeat(3000)}`,
    });
    expect(tooLong.success).toBe(true);
    expect(tooLong.success && tooLong.data.photoUrl).toBeUndefined();

    const notAUrl = captureBodySchema.safeParse({
      url: REAL_PROFILE_URL,
      photoUrl: "data:image/gif;base64,",
    });
    expect(notAUrl.success).toBe(true);
  });

  it("caps posts and drops the empty ones", () => {
    const parsed = captureBodySchema.safeParse({
      url: REAL_PROFILE_URL,
      posts: ["one", "  ", "two", "three", "four", "five", "six"],
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.posts).toEqual(["one", "two", "three", "four", "five"]);
  });

  it("treats a null posts array as none", () => {
    const parsed = captureBodySchema.safeParse({ url: REAL_PROFILE_URL, posts: null });
    expect(parsed.success && parsed.data.posts).toEqual([]);
  });
});

describe("whitespace", () => {
  it("treats an empty or blank field as absent", () => {
    const parsed = captureBodySchema.safeParse({
      url: REAL_PROFILE_URL,
      name: "   ",
      headline: "",
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.name).toBeUndefined();
    expect(parsed.data.headline).toBeUndefined();
  });

  it("trims what it keeps", () => {
    const parsed = captureBodySchema.safeParse({
      url: REAL_PROFILE_URL,
      name: "  Nagy Anna  ",
    });
    expect(parsed.success && parsed.data.name).toBe("Nagy Anna");
  });
});

/**
 * The fields added after the first round of live use: a real job title, and
 * contact details where the person published them in their own prose.
 */
describe("the later capture fields", () => {
  it("accepts a job title, email and phone", () => {
    const out = captureBodySchema.parse({
      url: "https://www.linkedin.com/in/nagy-anna",
      jobTitle: "Ügyvezető",
      email: "anna@danubia.hu",
      phone: "+36 1 234 5678",
    });
    expect(out.jobTitle).toBe("Ügyvezető");
    expect(out.email).toBe("anna@danubia.hu");
    expect(out.phone).toBe("+36 1 234 5678");
  });

  it("still treats them as absent when the extension sends null", () => {
    // An installed older extension keeps sending nulls; the server is the side
    // that has to stay forgiving.
    const out = captureBodySchema.parse({
      url: "https://www.linkedin.com/in/nagy-anna",
      jobTitle: null,
      email: null,
      phone: null,
    });
    expect(out.jobTitle).toBeUndefined();
    expect(out.email).toBeUndefined();
  });
});
