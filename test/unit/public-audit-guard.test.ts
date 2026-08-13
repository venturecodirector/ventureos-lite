import { describe, it, expect } from "vitest";
import {
  checkUrl,
  domainMatches,
  judgeSubmission,
  ipPrefix,
  type SubmissionContext,
} from "@/modules/public-audit/guard";

/**
 * The public audit form is the only unauthenticated write in the product that
 * queues worker jobs, so these rules are the load-bearing part of P12/1a.
 */
describe("public audit URL checks", () => {
  it("accepts a plain business domain and normalises it", () => {
    const r = checkUrl("  WWW.Pomodoro-Budapest.hu  ");
    expect(r.ok).toBe(true);
    expect(r.domain).toBe("pomodoro-budapest.hu");
    expect(r.normalizedUrl).toBe("https://www.Pomodoro-Budapest.hu".toLowerCase());
  });

  it("keeps a meaningful path but drops a bare slash", () => {
    expect(checkUrl("example.hu/").normalizedUrl).toBe("https://example.hu");
    expect(checkUrl("example.hu/kapcsolat").normalizedUrl).toBe("https://example.hu/kapcsolat");
  });

  // The worker fetches whatever we accept, so these are SSRF guards.
  it.each([
    "localhost",
    "http://127.0.0.1:3000",
    "http://10.0.0.5",
    "http://192.168.1.1/admin",
    "http://172.16.4.4",
    "http://169.254.169.254/latest/meta-data",
    "printer.local",
    "http://[::1]",
  ])("refuses the non-public host %s", (input) => {
    const r = checkUrl(input);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("not_public_host");
  });

  it("refuses a bare IP literal", () => {
    expect(checkUrl("http://93.184.216.34").reason).toBe("not_public_host");
  });

  it.each(["", "   ", "not a url", "ftp://example.hu", "javascript:alert(1)"])(
    "refuses malformed input %s",
    (input) => {
      expect(checkUrl(input).ok).toBe(false);
    },
  );
});

describe("domain list matching", () => {
  it("matches the domain and its subdomains", () => {
    expect(domainMatches("example.hu", ["example.hu"])).toBe(true);
    expect(domainMatches("shop.example.hu", ["example.hu"])).toBe(true);
    expect(domainMatches("www.example.hu", ["example.hu"])).toBe(true);
  });

  it("does not match a lookalike suffix", () => {
    expect(domainMatches("notexample.hu", ["example.hu"])).toBe(false);
    expect(domainMatches("example.hu.evil.com", ["example.hu"])).toBe(false);
  });

  it("ignores blanks in the list", () => {
    expect(domainMatches("example.hu", ["", "  "])).toBe(false);
  });
});

describe("submission verdict", () => {
  const base: SubmissionContext = {
    domain: "prospect.hu",
    ownDomains: ["ventureco.agency", "ventureco.group"],
    clientDomains: ["client.hu"],
    looksHuman: true,
    withinRateLimit: true,
    inFlight: 0,
    maxInFlight: 3,
  };

  it("accepts a clean submission", () => {
    expect(judgeSubmission(base)).toEqual({ accept: true });
  });

  it("refuses a bot before anything else", () => {
    const v = judgeSubmission({ ...base, looksHuman: false, withinRateLimit: false });
    expect(v).toMatchObject({ accept: false, reason: "bot" });
  });

  it("treats our own domain as friendly, not an error", () => {
    const v = judgeSubmission({ ...base, domain: "audit.ventureco.agency" });
    expect(v).toMatchObject({ accept: false, reason: "own_domain", friendly: true });
  });

  it("greets an existing client warmly instead of refusing coldly", () => {
    const v = judgeSubmission({ ...base, domain: "shop.client.hu" });
    expect(v).toMatchObject({ accept: false, reason: "client_domain", friendly: true });
  });

  it("blocks past the daily allowance", () => {
    const v = judgeSubmission({ ...base, withinRateLimit: false });
    expect(v).toMatchObject({ accept: false, reason: "rate_limited", friendly: false });
  });

  it("protects the worker at capacity", () => {
    const v = judgeSubmission({ ...base, inFlight: 3, maxInFlight: 3 });
    expect(v).toMatchObject({ accept: false, reason: "at_capacity" });
  });

  it("puts the client greeting ahead of the rate limit", () => {
    // A client who submits four times should still be greeted, not scolded.
    const v = judgeSubmission({ ...base, domain: "client.hu", withinRateLimit: false });
    expect(v).toMatchObject({ reason: "client_domain", friendly: true });
  });
});

describe("ip coarsening", () => {
  it("keeps a /24 of an IPv4 address", () => {
    expect(ipPrefix("84.2.31.95")).toBe("84.2.31.0/24");
  });

  it("keeps a /48 of an IPv6 address", () => {
    expect(ipPrefix("2001:db8:abcd:0012::1")).toBe("2001:db8:abcd::/48");
  });

  it("uses the first hop of a forwarded chain", () => {
    expect(ipPrefix("84.2.31.95, 10.0.0.1")).toBe("84.2.31.0/24");
  });

  it("returns null when there is nothing usable", () => {
    expect(ipPrefix(null)).toBeNull();
    expect(ipPrefix("")).toBeNull();
    expect(ipPrefix("garbage")).toBeNull();
  });
});
