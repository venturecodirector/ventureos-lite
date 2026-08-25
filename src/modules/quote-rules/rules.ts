/**
 * Quote behaviour → suggested next step (playbook-v4 P14/3).
 *
 * ── WHAT THIS IS BUILT ON ──────────────────────────────────────────────────
 *
 * P8 made a quote page observable: distinct reading sessions, time spent in the
 * `pricing` section against the `scope` section, whether the reader ever
 * reached the bottom, and when they last looked. Those numbers sat on a panel
 * for a person to notice. This turns them into a suggestion at the moment they
 * mean something — a quote read three times and unsigned is a phone call, and
 * it stops being one a week later.
 *
 * ── DELIBERATELY SMALL, AND NEVER AUTOMATIC ────────────────────────────────
 *
 * Every rule produces a TASK and, optionally, a DRAFT email a human has to read
 * and send. Nothing here sends anything (CLAUDE.md hard rule #2), and nothing
 * here calls Claude — the drafts are template text with the quote's own numbers
 * in them.
 *
 * Everything in this file is pure: given the facts about one quote, which rules
 * fire. No database, no clock beyond the one passed in.
 */

export const QUOTE_RULE_IDS = ["repeat_open", "price_dwell", "went_quiet"] as const;
export type QuoteRuleId = (typeof QUOTE_RULE_IDS)[number];

export interface QuoteRuleConfig {
  enabled: boolean;
  /** Draft a follow-up email alongside the task. */
  draft: boolean;
}

export interface QuoteRulesSettings {
  repeatOpen: QuoteRuleConfig & { minSessions: number };
  priceDwell: QuoteRuleConfig & {
    /** Seconds in the pricing section before it counts as dwelling. */
    minPricingSeconds: number;
    /** …and at most this share of that time spent on the scope. */
    maxScopeRatio: number;
  };
  wentQuiet: QuoteRuleConfig & { quietDays: number };
}

/**
 * Seeded defaults, from the playbook's own examples.
 *
 * Three opens, because two is a person re-reading and four is too late. Ninety
 * seconds on price is a decision being weighed rather than a page being
 * skimmed. Seven days of silence after a single read is the point where a
 * gentle nudge still reads as attentive rather than as pestering.
 */
export const DEFAULT_QUOTE_RULES: QuoteRulesSettings = {
  repeatOpen: { enabled: true, draft: true, minSessions: 3 },
  priceDwell: { enabled: true, draft: true, minPricingSeconds: 90, maxScopeRatio: 0.25 },
  wentQuiet: { enabled: true, draft: true, quietDays: 7 },
};

export function quoteRulesFrom(raw: unknown): QuoteRulesSettings {
  const r = (raw ?? {}) as Record<string, Record<string, unknown>>;
  const num = (v: unknown, fallback: number, min: number, max: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
  const d = DEFAULT_QUOTE_RULES;
  return {
    repeatOpen: {
      enabled: bool(r.repeatOpen?.enabled, d.repeatOpen.enabled),
      draft: bool(r.repeatOpen?.draft, d.repeatOpen.draft),
      minSessions: Math.round(num(r.repeatOpen?.minSessions, d.repeatOpen.minSessions, 2, 20)),
    },
    priceDwell: {
      enabled: bool(r.priceDwell?.enabled, d.priceDwell.enabled),
      draft: bool(r.priceDwell?.draft, d.priceDwell.draft),
      minPricingSeconds: Math.round(
        num(r.priceDwell?.minPricingSeconds, d.priceDwell.minPricingSeconds, 15, 3600),
      ),
      maxScopeRatio: num(r.priceDwell?.maxScopeRatio, d.priceDwell.maxScopeRatio, 0, 1),
    },
    wentQuiet: {
      enabled: bool(r.wentQuiet?.enabled, d.wentQuiet.enabled),
      draft: bool(r.wentQuiet?.draft, d.wentQuiet.draft),
      quietDays: Math.round(num(r.wentQuiet?.quietDays, d.wentQuiet.quietDays, 2, 90)),
    },
  };
}

/** Everything a rule may look at. Assembled from the P8 visit rows. */
export interface QuoteFacts {
  documentId: string;
  /** Distinct reading sessions. */
  sessions: number;
  /** Milliseconds spent in each named section, summed across sessions. */
  pricingMs: number;
  scopeMs: number;
  /** True when at least one session reached the bottom of the page. */
  reachedScope: boolean;
  lastOpenedAt: Date | null;
  accepted: boolean;
  /** Rules that have already fired on this quote — each fires once. */
  alreadyFired: readonly string[];
}

export interface RuleHit {
  ruleId: QuoteRuleId;
  /** One sentence, in the operator's language, saying why it fired. */
  reason: string;
  taskTitle: string;
  taskNote: string;
  /** Null when the rule is configured not to draft. */
  draftSubject: string | null;
  draftBody: string | null;
}

/**
 * Which rules fire on this quote, right now.
 *
 * An ACCEPTED quote fires nothing: the reading was the client checking what
 * they signed, and chasing them for it is the fastest way to look careless.
 */
export function evaluateQuote(
  facts: QuoteFacts,
  settings: QuoteRulesSettings,
  now: Date = new Date(),
): RuleHit[] {
  if (facts.accepted) return [];
  const hits: RuleHit[] = [];
  const fired = new Set(facts.alreadyFired);

  const r = settings.repeatOpen;
  if (r.enabled && !fired.has("repeat_open") && facts.sessions >= r.minSessions) {
    hits.push({
      ruleId: "repeat_open",
      reason: `${facts.sessions}× megnyitva, elfogadás nélkül`,
      taskTitle: `Hívd fel — az ajánlatot ${facts.sessions}× megnyitották, még nincs elfogadva`,
      taskNote:
        "Többször visszatértek hozzá, tehát érdekli őket, és valami mégis megállítja. Ez a legjobb pillanat egy hívásra.",
      draftSubject: r.draft ? "Segíthetek valamiben az ajánlattal kapcsolatban?" : null,
      draftBody: r.draft
        ? "Kedves {{név}},\n\nLáttam, hogy visszanézett az ajánlatra — ha bármelyik tétel kérdéses, szívesen átbeszélem. Ha az összeg az akadály, tudunk ütemezett fizetésről is beszélni.\n\nHívjam holnap délelőtt?"
        : null,
    });
  }

  /**
   * Time on the price, none on what it buys. The reader is weighing a number
   * without the thing the number is for — which is a conversation about scope,
   * not a discount.
   */
  const p = settings.priceDwell;
  if (p.enabled && !fired.has("price_dwell")) {
    const pricingSeconds = facts.pricingMs / 1000;
    const ratio = facts.pricingMs > 0 ? facts.scopeMs / facts.pricingMs : 1;
    if (pricingSeconds >= p.minPricingSeconds && ratio <= p.maxScopeRatio && !facts.reachedScope) {
      hits.push({
        ruleId: "price_dwell",
        reason: `${Math.round(pricingSeconds)} mp az áron, alig a tartalmon`,
        taskTitle: "Pontosítsuk a tartalmat — sokáig nézték az árat",
        taskNote:
          "Az áron hosszan időztek, a tételekig viszont el sem jutottak. Nem az összeggel van baj, hanem azzal, hogy nem látszik, mit fedez.",
        draftSubject: p.draft ? "Pontosítsuk, mit tartalmaz az ajánlat" : null,
        draftBody: p.draft
          ? "Kedves {{név}},\n\nHogy könnyebb legyen a döntés, összeszedem tételről tételre, mit fedez az ajánlat és mi az, ami elhagyható vagy későbbre tehető.\n\nMikor hívhatom egy rövid egyeztetésre?"
          : null,
      });
    }
  }

  const q = settings.wentQuiet;
  if (q.enabled && !fired.has("went_quiet") && facts.sessions > 0 && facts.lastOpenedAt) {
    const quietDays = (now.getTime() - facts.lastOpenedAt.getTime()) / 86_400_000;
    if (quietDays >= q.quietDays) {
      hits.push({
        ruleId: "went_quiet",
        reason: `${Math.floor(quietDays)} napja nem nézték meg`,
        taskTitle: "Finom emlékeztető — az ajánlat elcsendesedett",
        taskNote: "Megnyitották, aztán semmi. Egy rövid, nyomásmentes kérdés most még jól esik.",
        draftSubject: q.draft ? "Aktuális még az ajánlat?" : null,
        draftBody: q.draft
          ? "Kedves {{név}},\n\nCsak röviden: aktuális még a projekt? Ha most nem időszerű, nyugodtan szóljon, és jelentkezem később — ha viszont kérdés maradt benne, arra is szívesen válaszolok."
          : null,
      });
    }
  }

  return hits;
}
