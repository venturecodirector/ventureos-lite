import { describe, it, expect } from "vitest";
import {
  preParse,
  hasAnalyzableText,
  hostOf,
  isSocialHost,
} from "@/modules/leads/preparse";

/**
 * P1/1b — everything a paste can yield without spending a Claude call.
 * The budget rule is the point: an email address is a regex, not a judgement.
 */
describe("hasAnalyzableText", () => {
  it("rejects a bare LinkedIn URL", () => {
    expect(hasAnalyzableText("https://www.linkedin.com/in/gabor-kovacs-1234/")).toBe(false);
  });

  it("rejects a URL with an address stuck to it", () => {
    expect(hasAnalyzableText("https://pelda.hu gabor@pelda.hu")).toBe(false);
  });

  it("accepts a real profile paste", () => {
    const text =
      "Gábor Kovács — ügyvezető a Pomodoro Kft-nél. Budapesti étterem, 2015 óta. " +
      "Most nyitottunk egy második helyet a Bartók Béla úton.";
    expect(hasAnalyzableText(text)).toBe(true);
  });

  it("treats whitespace-only input as unusable", () => {
    expect(hasAnalyzableText("   \n\t  ")).toBe(false);
    expect(hasAnalyzableText("")).toBe(false);
  });
});

describe("preParse", () => {
  const sample = `
    Gábor Kovács
    ügyvezető · Pomodoro Budapest Kft.
    Budapest, Magyarország
    Kapcsolat: gabor.kovacs@pomodorobudapest.com vagy +36 30 123 4567
    Weboldal: https://www.pomodorobudapest.com/kapcsolat
    LinkedIn: https://www.linkedin.com/in/gaborkovacs
    Éttermünk 2015 óta működik, most nyitunk egy második helyszínt.
  `;

  it("pulls out the email", () => {
    expect(preParse(sample).emails).toEqual(["gabor.kovacs@pomodorobudapest.com"]);
  });

  it("normalises a Hungarian phone number to +36", () => {
    expect(preParse(sample).phones).toEqual(["+36301234567"]);
  });

  it("picks the company domain, not the LinkedIn URL", () => {
    const r = preParse(sample);
    expect(r.domain).toBe("pomodorobudapest.com");
    expect(r.websites).toContain("linkedin.com");
  });

  it("finds the city", () => {
    expect(preParse(sample).city).toBe("Budapest");
  });

  it("reports that there is prose worth researching", () => {
    expect(preParse(sample).hasProse).toBe(true);
  });

  it("returns empty structures for a bare URL, and says so", () => {
    const r = preParse("https://www.linkedin.com/in/someone");
    expect(r.emails).toEqual([]);
    expect(r.phones).toEqual([]);
    expect(r.domain).toBeNull();
    expect(r.hasProse).toBe(false);
  });

  it.each([
    ["06-30-123-4567", "+36301234567"],
    ["+36 1 234 5678", "+3612345678"],
    ["0036 20 987 6543", "+36209876543"],
  ])("normalises %s", (input, expected) => {
    expect(preParse(`hívj: ${input}`).phones).toEqual([expected]);
  });

  it("ignores digit runs that are too short to be a number", () => {
    expect(preParse("alapítva 2015, 12 fő").phones).toEqual([]);
  });

  it("does not mistake an image filename for an email", () => {
    expect(preParse("logo@2x.png a fejlécben").emails).toEqual([]);
  });

  it("deduplicates repeated values", () => {
    const r = preParse("a@b.hu és megint a@b.hu, meg A@B.HU");
    expect(r.emails).toEqual(["a@b.hu"]);
  });

  it("strips trailing punctuation from an address", () => {
    expect(preParse("írj ide: info@pelda.hu.").emails).toEqual(["info@pelda.hu"]);
  });
});

describe("host helpers", () => {
  it("normalises hosts", () => {
    expect(hostOf("https://WWW.Pelda.hu/x?y=1")).toBe("pelda.hu");
    expect(hostOf("pelda.hu")).toBe("pelda.hu");
    expect(hostOf("nonsense !!")).toBeNull();
  });

  it("knows the social hosts that are not company sites", () => {
    expect(isSocialHost("linkedin.com")).toBe(true);
    expect(isSocialHost("www.facebook.com")).toBe(true);
    expect(isSocialHost("pomodorobudapest.com")).toBe(false);
    // A lookalike must not be treated as social.
    expect(isSocialHost("notlinkedin.com")).toBe(false);
  });
});
