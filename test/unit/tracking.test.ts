import { describe, it, expect, vi } from "vitest";
import { hashIp, sanitizeBeacon } from "../../src/modules/tracking/record";
import { identifyVisitor, ptrDomain, fold } from "../../src/modules/tracking/identify";
import { visitorSignalTitle, readingTime } from "../../src/modules/tracking/notify";
import { isPageType } from "../../src/modules/tracking/resolve";

/**
 * The signal layer (playbook-v3 P8).
 *
 * The tests that matter here are the ones about restraint: what the beacon is
 * NOT allowed to claim, what a guess is NOT allowed to be called, and what
 * happens to an address.
 */

describe("sanitizeBeacon — a public endpoint believes nothing", () => {
  it("clamps a duration nobody could have spent reading", () => {
    expect(sanitizeBeacon({ t: "x", p: "quote", s: "s", d: 99_999_999_999 }).durationMs).toBe(
      4 * 60 * 60 * 1000,
    );
    expect(sanitizeBeacon({ t: "x", p: "quote", s: "s", d: -5 }).durationMs).toBe(0);
    expect(sanitizeBeacon({ t: "x", p: "quote", s: "s" }).durationMs).toBe(0);
  });

  it("keeps scroll depth inside 0–100 whatever was posted", () => {
    expect(sanitizeBeacon({ t: "x", p: "q", s: "s", sd: 900 }).scrollPct).toBe(100);
    expect(sanitizeBeacon({ t: "x", p: "q", s: "s", sd: -3 }).scrollPct).toBe(0);
    expect(sanitizeBeacon({ t: "x", p: "q", s: "s", sd: 47.6 }).scrollPct).toBe(48);
  });

  it("caps how many sections one page may claim, and how long each was read", () => {
    const sec: Record<string, number> = {};
    for (let i = 0; i < 100; i++) sec[`s${i}`] = 1000;
    const out = sanitizeBeacon({ t: "x", p: "q", s: "s", sec });
    expect(Object.keys(out.sections)).toHaveLength(24);
  });

  it("drops empty and zero-length sections rather than storing noise", () => {
    const out = sanitizeBeacon({
      t: "x",
      p: "q",
      s: "s",
      sec: { pricing: 4000, scope: 0, "": 900, junk: -1 },
    });
    expect(out.sections).toEqual({ pricing: 4000 });
  });

  it("accepts only the two viewport classes it defined", () => {
    expect(sanitizeBeacon({ t: "x", p: "q", s: "s", v: "mobile" }).viewport).toBe("mobile");
    expect(sanitizeBeacon({ t: "x", p: "q", s: "s", v: "tablet" }).viewport).toBeNull();
  });

  it("truncates a referrer instead of storing a whole URL bar", () => {
    const long = `https://example.com/${"a".repeat(1000)}`;
    expect(sanitizeBeacon({ t: "x", p: "q", s: "s", r: long }).referrer).toHaveLength(300);
  });
});

describe("hashIp", () => {
  it("is stable, salted, and not reversible to the address", () => {
    const a = hashIp("81.2.3.4", "salt");
    expect(hashIp("81.2.3.4", "salt")).toBe(a);
    expect(hashIp("81.2.3.4", "other-salt")).not.toBe(a);
    expect(a).not.toContain("81.2.3.4");
    expect(a).toHaveLength(40);
  });
});

describe("ptrDomain", () => {
  it("takes the registrable tail of a reverse-DNS name", () => {
    expect(ptrDomain("mail.danubia.hu")).toBe("danubia.hu");
    expect(ptrDomain("host-12.office.danubia.hu")).toBe("danubia.hu");
    expect(ptrDomain("srv.example.co.uk")).toBe("example.co.uk");
    expect(ptrDomain("nodots")).toBeNull();
    expect(ptrDomain("")).toBeNull();
  });
});

describe("fold", () => {
  it("folds the accents Hungarian company names are full of", () => {
    expect(fold("Máthé Fogászat Kft.")).toBe("mathefogaszatkft");
    expect(fold("ÁRVÍZTŰRŐ")).toBe("arvizturo");
  });
});

const COMPANIES = [
  { id: "c1", name: "Danubia Kft.", domain: "danubia.hu" },
  { id: "c2", name: "Rákóczi Pékség", domain: null },
];

const reverseTo = (host: string) => async () => [host];

describe("identifyVisitor", () => {
  it("calls a domain match HIGH — that is not a guess", async () => {
    const r = await identifyVisitor({
      ip: "81.2.3.4",
      companies: COMPANIES,
      reverse: reverseTo("mail.danubia.hu"),
    });
    expect(r).toEqual({ orgName: "danubia.hu", companyId: "c1", confidence: "high" });
  });

  it("calls a name match MEDIUM, so the UI can say 'valószínűleg'", async () => {
    const r = await identifyVisitor({
      ip: "81.2.3.4",
      companies: COMPANIES,
      reverse: reverseTo("gw.rakoczi.hu"),
    });
    expect(r.companyId).toBe("c2");
    expect(r.confidence).toBe("medium");
  });

  /**
   * The failure that would embarrass us in front of a client: reporting
   * "T-Online megnézte az ajánlatot" because the prospect read it at home.
   */
  it("refuses to name a consumer ISP as the visitor", async () => {
    for (const host of [
      "catv-80-99-1-2.catv.broadband.hu",
      "dsl51B7B430.pool.t-online.hu",
      "d5152a1b2.access.telenor.hu",
    ]) {
      const r = await identifyVisitor({
        ip: "81.2.3.4",
        companies: COMPANIES,
        reverse: reverseTo(host),
      });
      expect(r.confidence, host).toBe("none");
      expect(r.companyId, host).toBeNull();
    }
  });

  it("says none when there is no reverse name at all — the common case", async () => {
    const r = await identifyVisitor({
      ip: "81.2.3.4",
      companies: COMPANIES,
      reverse: async () => {
        throw new Error("ENOTFOUND");
      },
    });
    expect(r).toEqual({ orgName: null, companyId: null, confidence: "none" });
  });

  it("names an organisation it does not know as LOW, without inventing a company", async () => {
    const r = await identifyVisitor({
      ip: "81.2.3.4",
      companies: COMPANIES,
      reverse: reverseTo("proxy.someagency.hu"),
    });
    expect(r).toEqual({ orgName: "someagency.hu", companyId: null, confidence: "low" });
  });

  it("does not match a three-letter label onto a company by accident", async () => {
    const r = await identifyVisitor({
      ip: "81.2.3.4",
      companies: [{ id: "c3", name: "DAN Kft", domain: null }],
      reverse: reverseTo("gw.dan.hu"),
    });
    expect(r.companyId).toBeNull();
  });
});

describe("the copy never overstates", () => {
  it("qualifies anything below high confidence", () => {
    expect(
      visitorSignalTitle({ companyName: "Danubia", pageLabel: "Quote", confidence: "high" }),
    ).toBe("Danubia megnézte: Quote");
    expect(
      visitorSignalTitle({ companyName: "Danubia", pageLabel: "Quote", confidence: "medium" }),
    ).toBe("Valószínűleg Danubia megnézte: Quote");
  });

  it("says a reading time the way a person would", () => {
    expect(readingTime(35_000)).toBe("35 mp");
    expect(readingTime(160_000)).toBe("2 perc 40 mp");
    expect(readingTime(120_000)).toBe("2 perc");
    expect(readingTime(0)).toBe("0 mp");
  });
});

describe("isPageType", () => {
  it("accepts only the four surfaces we publish", () => {
    for (const t of ["audit_share", "quote", "booking", "public_audit"]) {
      expect(isPageType(t)).toBe(true);
    }
    for (const t of ["", "leads", "../etc", "QUOTE"]) {
      expect(isPageType(t)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Reachable without a session — the failure the e2e suite cannot see.
// ---------------------------------------------------------------------------

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

describe("the measurement surface is public", () => {
  /**
   * Caught in production, not in the browser suite, and it could not have been
   * caught there: every e2e spec runs with a signed-in storage state, so the
   * auth middleware waves the beacon through. A real prospect reading a quote
   * has no session at all — and /t.js was answering with a redirect to /login.
   */
  const middleware = readFileSync(
    join(__dirname, "..", "..", "src", "middleware.ts"),
    "utf8",
  );

  for (const path of ["/t.js", "/api/t", "/privacy"]) {
    it(`${path} is a public prefix`, () => {
      expect(middleware.includes(`"${path}"`), `${path} would redirect to /login`).toBe(true);
    });
  }

  it("ships the script it points at", () => {
    expect(existsSync(join(__dirname, "..", "..", "public", "t.js"))).toBe(true);
  });

  /**
   * A tracked page on audit./quote. links to /privacy on THAT host, where the
   * bare-slug fallback would otherwise turn it into /r/privacy.
   */
  it("lets /privacy through on the public subdomains too", () => {
    expect(middleware.includes('pathname === "/privacy"')).toBe(true);
  });

  it("keeps the script under 2 KB over the wire", () => {
    const raw = readFileSync(join(__dirname, "..", "..", "public", "t.js"));
    // Caddy serves it compressed (Caddyfile.prod: `encode zstd gzip`), which is
    // the size the playbook's "<2 KB" is about.
    const gzipped = require("node:zlib").gzipSync(raw, { level: 9 }).length;
    expect(gzipped).toBeLessThan(2048);
  });
});
