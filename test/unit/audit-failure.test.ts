import { describe, it, expect } from "vitest";
import {
  AuditUnreachableError,
  failureMessage,
  firstLine,
} from "../../src/modules/audit/failure";
import { analyzeAudit } from "../../src/modules/audit/analyze";
import type { PageProbe } from "../../src/modules/audit/types";

/**
 * A failed audit used to render as the single word "failed". That is exactly
 * as useful as a spinner that never stops: it does not say whether to retry,
 * to fix the URL, or to write the prospect off — and those are three different
 * answers.
 */
describe("what a failed audit tells the operator", () => {
  it("passes a written reason through untouched", () => {
    const e = new AuditUnreachableError("example.hu answered HTTP 404, so there was no page to audit.");
    expect(failureMessage(e)).toBe(e.message);
  });

  it("turns a DNS failure into an instruction, not a Chrome error code", () => {
    const msg = failureMessage(
      new Error("page.goto: net::ERR_NAME_NOT_RESOLVED at https://nope.example/\n=========="),
    );
    expect(msg).toMatch(/does not resolve/i);
    expect(msg).not.toMatch(/ERR_NAME_NOT_RESOLVED/);
  });

  it("reads the SSRF guard's abort as an unreachable domain", () => {
    // The navigation guard aborts requests to hosts that do not resolve to a
    // public address — which includes a domain that does not exist at all. The
    // browser reports that as ERR_BLOCKED_BY_CLIENT, which would otherwise
    // read to an operator as "we blocked it on purpose".
    expect(failureMessage(new Error("page.goto: net::ERR_BLOCKED_BY_CLIENT"))).toMatch(
      /does not resolve/i,
    );
  });

  it("calls out a rejected certificate as a finding worth raising", () => {
    expect(failureMessage(new Error("page.goto: net::ERR_CERT_DATE_INVALID"))).toMatch(
      /certificate/i,
    );
  });

  it("says a timeout is probably slowness, not absence", () => {
    const msg = failureMessage(new Error("page.goto: Timeout 20000ms exceeded.\n  at foo"));
    expect(msg).toMatch(/too long to respond/i);
  });

  it("never renders a stack trace, however odd the error", () => {
    const msg = failureMessage(new Error("something strange\nat a()\nat b()"));
    expect(msg).toBe("something strange");
  });

  it("still says something when the error carries no message at all", () => {
    expect(failureMessage(new Error(""))).toMatch(/unknown reason/i);
  });

  it("survives a thrown non-Error", () => {
    expect(firstLine("boom")).toBe("boom");
    expect(failureMessage({ weird: true })).toBeTruthy();
  });
});

/**
 * The other half of the same defect: a page we never read used to be scored as
 * if we had. wolt.com/hu answers 404 to a headless browser; the probe returned
 * every field false, and the analysis — which cannot tell "measured absent"
 * from "never measured" — produced 59/100, POSSIBLE, twenty-three findings.
 * Every one of them was invented, and an operator would have quoted from it.
 *
 * `probeSite` now throws instead of returning that probe. This test pins down
 * why that matters, without needing a browser: it shows what the analysis does
 * with an empty probe, which is precisely what must never reach it.
 */
describe("an empty probe is exactly why the probe must throw instead", () => {
  const nothingLoaded: PageProbe = {
    url: "https://blocked.example",
    finalUrl: "https://blocked.example",
    isHttps: true,
    statusOk: false,
    hasViewport: false,
    title: null,
    metaDescription: null,
    h1Count: 0,
    imgTotal: 0,
    imgWithAlt: 0,
    hasSitemap: false,
    hasRobots: false,
    copyrightYear: null,
    hasPhone: false,
    hasEmail: false,
    hasForm: false,
    hasBooking: false,
    hasCookieBanner: false,
    pageWeightBytes: 0,
    psi: null,
    screenshots: {},
  };

  it("scores a page that never loaded as a live sales opportunity", () => {
    const a = analyzeAudit(nothingLoaded);
    // Not an assertion that this is desirable — it is the bug, recorded. The
    // analysis is pure over what it is given and has no way to know better,
    // which is why the guard belongs upstream in `probeSite`.
    expect(a.score).toBeGreaterThan(40);
    expect(a.verdict).not.toBe("SKIP");
    expect(a.flags.length).toBeGreaterThan(3);
  });

  it("still records that the response was not OK, for anyone who looks", () => {
    expect(nothingLoaded.statusOk).toBe(false);
  });
});
