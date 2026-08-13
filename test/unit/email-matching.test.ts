import { describe, it, expect } from "vitest";
import {
  matchParticipants,
  scopeFromIndex,
  domainOf,
  isGenericDomain,
  emptyIndex,
  normalizeAddress,
  type MatchIndex,
} from "@/modules/email/matching";
import {
  buildSyncQueries,
  backfillWindows,
  gmailDate,
  MAX_QUERY_CHARS,
} from "@/modules/email/gmail-query";

/**
 * playbook-v2 P2 — matching, and the query boundary.
 *
 * The query tests are the important ones: they are the only mechanical proof
 * that a sync pass cannot ask a mailbox for anything the CRM does not already
 * know about.
 */
function index(over: Partial<MatchIndex> = {}): MatchIndex {
  return { ...emptyIndex(), ...over };
}

const target = (leadId: string) => ({ leadId, companyId: "c1" });

describe("domainOf", () => {
  it("takes the domain, lower-cased", () => {
    expect(domainOf("Anna@Nagyceg.HU")).toBe("nagyceg.hu");
  });
  it("drops a leading www", () => {
    expect(domainOf("a@www.pelda.hu")).toBe("pelda.hu");
  });
  it("returns null for something that is not an address", () => {
    expect(domainOf("not-an-address")).toBeNull();
    expect(domainOf("a@localhost")).toBeNull();
  });
});

describe("generic domains", () => {
  it("knows the free-mail providers", () => {
    expect(isGenericDomain("gmail.com")).toBe(true);
    expect(isGenericDomain("freemail.hu")).toBe(true);
    expect(isGenericDomain("nagyceg.hu")).toBe(false);
  });
});

describe("matchParticipants precedence", () => {
  const idx = index({
    learned: new Map([["anna@nagyceg.hu", target("lead-learned")]]),
    byAddress: new Map([["anna@nagyceg.hu", target("lead-exact")]]),
    byDomain: new Map([["nagyceg.hu", target("lead-domain")]]),
  });

  it("puts a hand-made link above everything", () => {
    const m = matchParticipants(["anna@nagyceg.hu"], idx)!;
    expect(m.leadId).toBe("lead-learned");
    expect(m.matchType).toBe("manual");
  });

  it("uses an exact address when nothing was linked by hand", () => {
    const m = matchParticipants(["anna@nagyceg.hu"], index({ byAddress: idx.byAddress, byDomain: idx.byDomain }))!;
    expect(m.leadId).toBe("lead-exact");
    expect(m.matchType).toBe("address");
  });

  it("falls back to the domain, and labels it as a guess", () => {
    const m = matchParticipants(["valaki.mas@nagyceg.hu"], index({ byDomain: idx.byDomain }))!;
    expect(m.leadId).toBe("lead-domain");
    expect(m.matchType).toBe("domain");
    expect(m.via).toBe("valaki.mas@nagyceg.hu");
  });

  it("never matches a free-mail domain", () => {
    // One lead with a gmail address must not make every private conversation
    // in the mailbox look like company correspondence.
    const gmail = index({ byDomain: new Map([["gmail.com", target("lead-x")]]) });
    expect(matchParticipants(["barát@gmail.com"], gmail)).toBeNull();
  });

  it("ignores the mailbox owner's own addresses", () => {
    const withSelf = index({
      byAddress: new Map([["me@ventureco.group", target("lead-self")]]),
      self: new Set(["me@ventureco.group"]),
    });
    expect(matchParticipants(["me@ventureco.group"], withSelf)).toBeNull();
  });

  it("returns null when nobody in the thread is known", () => {
    expect(matchParticipants(["idegen@sehol.hu"], idx)).toBeNull();
    expect(matchParticipants([], idx)).toBeNull();
  });

  it("is case- and whitespace-insensitive", () => {
    const m = matchParticipants(["  ANNA@NagyCeg.hu "], idx)!;
    expect(m.leadId).toBe("lead-learned");
    expect(normalizeAddress(" A@B.hu ")).toBe("a@b.hu");
  });
});

describe("scopeFromIndex", () => {
  it("collects addresses and company domains, excluding our own", () => {
    const idx = index({
      byAddress: new Map([
        ["anna@nagyceg.hu", target("l1")],
        ["me@ventureco.group", target("l2")],
      ]),
      learned: new Map([["peter@masik.hu", target("l3")]]),
      byDomain: new Map([
        ["nagyceg.hu", target("l1")],
        ["gmail.com", target("l4")],
      ]),
      self: new Set(["me@ventureco.group"]),
    });

    const scope = scopeFromIndex(idx);
    expect(scope.addresses).toEqual(["anna@nagyceg.hu", "peter@masik.hu"]);
    // Free-mail domains never enter the query — they would match the whole
    // mailbox.
    expect(scope.domains).toEqual(["nagyceg.hu"]);
  });
});

describe("buildSyncQueries — the privacy boundary", () => {
  it("issues NO query when the CRM knows no addresses", () => {
    // A bare `after:` with no participant clause would match the entire
    // mailbox. This is the single most important assertion in the file.
    expect(buildSyncQueries({ addresses: [], domains: [] }, { after: new Date() })).toEqual([]);
  });

  it("always constrains by participant, never by date alone", () => {
    const queries = buildSyncQueries(
      { addresses: ["anna@nagyceg.hu"], domains: [] },
      { after: new Date(2026, 4, 16) },
    );
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("from:anna@nagyceg.hu");
    expect(queries[0]).toContain("to:anna@nagyceg.hu");
    expect(queries[0]).toContain("after:2026/05/16");
    expect(queries[0]).toMatch(/\{.*\}/);
  });

  it("matches a company domain on either side", () => {
    const [q] = buildSyncQueries({ addresses: [], domains: ["nagyceg.hu"] });
    expect(q).toContain("from:@nagyceg.hu");
    expect(q).toContain("to:@nagyceg.hu");
  });

  it("excludes drafts, spam and trash", () => {
    const [q] = buildSyncQueries({ addresses: ["a@b.hu"], domains: [] });
    expect(q).toContain("-in:drafts");
    expect(q).toContain("-in:spam");
    expect(q).toContain("-in:trash");
  });

  it("chunks rather than truncating as the pipeline grows", () => {
    const addresses = Array.from({ length: 200 }, (_, i) => `contact${i}@company${i}.hu`);
    const queries = buildSyncQueries({ addresses, domains: [] });

    expect(queries.length).toBeGreaterThan(1);
    // Silent truncation past the limit would make the sync quietly stop seeing
    // some leads — a bug that looks like nothing.
    for (const q of queries) {
      expect(q.length).toBeLessThan(MAX_QUERY_CHARS + 200);
    }
    for (const a of addresses) {
      expect(queries.some((q) => q.includes(`from:${a}`))).toBe(true);
    }
  });

  it("puts every address into some chunk exactly once", () => {
    const addresses = Array.from({ length: 40 }, (_, i) => `p${i}@x${i}.hu`);
    const queries = buildSyncQueries({ addresses, domains: [] });
    for (const a of addresses) {
      const hits = queries.filter((q) => q.includes(`from:${a} `) || q.includes(`from:${a}}`));
      expect(hits.length).toBe(1);
    }
  });
});

describe("gmailDate", () => {
  it("formats the way Gmail's operators expect", () => {
    expect(gmailDate(new Date(2026, 0, 5))).toBe("2026/01/05");
    expect(gmailDate(new Date(2026, 11, 31))).toBe("2026/12/31");
  });
});

describe("backfillWindows", () => {
  const now = new Date(2026, 7, 14);

  it("walks backwards in windows rather than asking for 90 days at once", () => {
    const windows = backfillWindows(now);
    expect(windows.length).toBeGreaterThan(1);
    // Newest first: the most recent correspondence is the most useful, and a
    // backfill that is interrupted should have fetched that part.
    expect(windows[0]!.before!.getTime()).toBeGreaterThan(windows[1]!.before!.getTime());
  });

  it("covers the whole period with no gap", () => {
    const windows = backfillWindows(now, 90);
    const oldest = windows[windows.length - 1]!.after!;
    expect(Math.round((now.getTime() - oldest.getTime()) / 86_400_000)).toBe(90);

    for (let i = 1; i < windows.length; i += 1) {
      // Each window starts exactly where the previous one ended.
      expect(windows[i]!.before!.getTime()).toBe(windows[i - 1]!.after!.getTime());
    }
  });
});
