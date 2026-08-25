import { describe, it, expect } from "vitest";
import {
  evaluateQuote,
  quoteRulesFrom,
  DEFAULT_QUOTE_RULES,
  type QuoteFacts,
} from "../../src/modules/quote-rules/rules";

/**
 * Quote behaviour → suggested next step (playbook-v4 P14/3).
 *
 * These rules decide when the whole team is told to pick up the phone, so what
 * they must NOT do matters more than what they do: never on an accepted quote,
 * never twice on the same one, and never a draft that could send itself.
 */
const facts = (over: Partial<QuoteFacts> = {}): QuoteFacts => ({
  documentId: "d1",
  sessions: 1,
  pricingMs: 0,
  scopeMs: 0,
  reachedScope: true,
  lastOpenedAt: new Date(),
  accepted: false,
  alreadyFired: [],
  ...over,
});

const NOW = new Date("2026-08-25T09:00:00Z");

describe("repeat_open", () => {
  it("fires at the threshold, not before it", () => {
    expect(evaluateQuote(facts({ sessions: 2 }), DEFAULT_QUOTE_RULES, NOW)).toEqual([]);
    const hits = evaluateQuote(facts({ sessions: 3 }), DEFAULT_QUOTE_RULES, NOW);
    expect(hits.map((h) => h.ruleId)).toEqual(["repeat_open"]);
    expect(hits[0]!.taskTitle).toContain("3×");
  });

  it("fires exactly once per quote", () => {
    const hits = evaluateQuote(
      facts({ sessions: 9, alreadyFired: ["repeat_open"] }),
      DEFAULT_QUOTE_RULES,
      NOW,
    );
    expect(hits).toEqual([]);
  });
});

describe("price_dwell", () => {
  const dwelling = {
    sessions: 1,
    pricingMs: 120_000,
    scopeMs: 5_000,
    reachedScope: false,
  };

  it("fires on long time at the price with none at the scope", () => {
    const hits = evaluateQuote(facts(dwelling), DEFAULT_QUOTE_RULES, NOW);
    expect(hits.map((h) => h.ruleId)).toContain("price_dwell");
  });

  /**
   * The distinction the rule exists for: somebody who read the scope AND the
   * price is having a normal think, not stuck on a number.
   */
  it("does not fire when they did read the scope", () => {
    const hits = evaluateQuote(
      facts({ ...dwelling, scopeMs: 90_000, reachedScope: true }),
      DEFAULT_QUOTE_RULES,
      NOW,
    );
    expect(hits.map((h) => h.ruleId)).not.toContain("price_dwell");
  });

  it("does not fire on a quick glance at the price", () => {
    const hits = evaluateQuote(
      facts({ ...dwelling, pricingMs: 20_000 }),
      DEFAULT_QUOTE_RULES,
      NOW,
    );
    expect(hits.map((h) => h.ruleId)).not.toContain("price_dwell");
  });

  it("does not fire when they scrolled to the bottom, whatever the sections say", () => {
    const hits = evaluateQuote(
      facts({ ...dwelling, reachedScope: true }),
      DEFAULT_QUOTE_RULES,
      NOW,
    );
    expect(hits.map((h) => h.ruleId)).not.toContain("price_dwell");
  });
});

describe("went_quiet", () => {
  const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

  it("fires after the configured silence, not before", () => {
    expect(
      evaluateQuote(facts({ lastOpenedAt: daysAgo(6) }), DEFAULT_QUOTE_RULES, NOW).map((h) => h.ruleId),
    ).not.toContain("went_quiet");
    expect(
      evaluateQuote(facts({ lastOpenedAt: daysAgo(8) }), DEFAULT_QUOTE_RULES, NOW).map((h) => h.ruleId),
    ).toContain("went_quiet");
  });

  it("says nothing about a quote nobody ever opened", () => {
    const hits = evaluateQuote(
      facts({ sessions: 0, lastOpenedAt: null }),
      DEFAULT_QUOTE_RULES,
      NOW,
    );
    expect(hits).toEqual([]);
  });
});

describe("what the rules must never do", () => {
  /**
   * An accepted quote fires nothing. The reading was the client checking what
   * they signed, and chasing them for it is the fastest way to look careless.
   */
  it("stays silent on an accepted quote, however it was read", () => {
    const hits = evaluateQuote(
      facts({ accepted: true, sessions: 12, pricingMs: 600_000, reachedScope: false, lastOpenedAt: new Date("2026-01-01") }),
      DEFAULT_QUOTE_RULES,
      NOW,
    );
    expect(hits).toEqual([]);
  });

  it("writes no draft when the rule is configured not to", () => {
    const settings = quoteRulesFrom({ repeatOpen: { draft: false } });
    const hits = evaluateQuote(facts({ sessions: 5 }), settings, NOW);
    expect(hits[0]!.draftSubject).toBeNull();
    expect(hits[0]!.draftBody).toBeNull();
  });

  it("stays silent entirely when a rule is switched off", () => {
    const settings = quoteRulesFrom({
      repeatOpen: { enabled: false },
      priceDwell: { enabled: false },
      wentQuiet: { enabled: false },
    });
    expect(evaluateQuote(facts({ sessions: 20, lastOpenedAt: new Date("2026-01-01") }), settings, NOW)).toEqual([]);
  });
});

describe("quoteRulesFrom", () => {
  it("falls back to the defaults on anything unusable", () => {
    for (const raw of [null, undefined, {}, 42, "nope", []]) {
      expect(quoteRulesFrom(raw)).toEqual(DEFAULT_QUOTE_RULES);
    }
  });

  it("clamps a threshold somebody typed badly instead of trusting it", () => {
    const r = quoteRulesFrom({
      repeatOpen: { minSessions: 0 },
      priceDwell: { minPricingSeconds: 99_999, maxScopeRatio: 5 },
      wentQuiet: { quietDays: -3 },
    });
    expect(r.repeatOpen.minSessions).toBe(2);
    expect(r.priceDwell.minPricingSeconds).toBe(3600);
    expect(r.priceDwell.maxScopeRatio).toBe(1);
    expect(r.wentQuiet.quietDays).toBe(2);
  });

  it("keeps a partial edit and defaults the rest", () => {
    const r = quoteRulesFrom({ repeatOpen: { minSessions: 5 } });
    expect(r.repeatOpen.minSessions).toBe(5);
    expect(r.repeatOpen.enabled).toBe(true);
    expect(r.wentQuiet).toEqual(DEFAULT_QUOTE_RULES.wentQuiet);
  });
});
