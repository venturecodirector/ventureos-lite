/**
 * Minimal robots.txt parser (RFC 9309 subset).
 *
 * We fetch other people's websites in two places — lead enrichment (P1/1c) and
 * the sector batch — so we honour their crawl rules. The existing audit probe
 * only checks whether robots.txt EXISTS as a scoring signal; it never reads it.
 * This does.
 *
 * Pure and synchronous: fetching the file is the caller's job, deciding what it
 * permits is testable without a network.
 */
export interface RobotsRules {
  /** Longest-match Allow/Disallow paths for the group that applies to us. */
  allow: string[];
  disallow: string[];
  /** Seconds between requests, when the site asks for one. */
  crawlDelay: number | null;
}

/**
 * Parse for a specific user-agent. A group naming our agent wins over `*`;
 * when neither appears, everything is allowed (an absent rule is permission).
 */
export function parseRobots(txt: string, userAgent: string): RobotsRules {
  const ua = userAgent.toLowerCase();
  const groups: Array<{ agents: string[]; allow: string[]; disallow: string[]; delay: number | null }> = [];
  let current: (typeof groups)[number] | null = null;
  let lastLineWasAgent = false;

  for (const rawLine of (txt ?? "").split(/\r?\n/)) {
    const line = rawLine.split("#")[0]!.trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === "user-agent") {
      // Consecutive User-agent lines share one group.
      if (!current || !lastLineWasAgent) {
        current = { agents: [], allow: [], disallow: [], delay: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastLineWasAgent = true;
      continue;
    }
    lastLineWasAgent = false;
    if (!current) continue;

    if (field === "allow") current.allow.push(value);
    else if (field === "disallow") current.disallow.push(value);
    else if (field === "crawl-delay") {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) current.delay = n;
    }
  }

  const exact = groups.find((g) => g.agents.some((a) => a !== "*" && ua.includes(a)));
  const wildcard = groups.find((g) => g.agents.includes("*"));
  const chosen = exact ?? wildcard;
  if (!chosen) return { allow: [], disallow: [], crawlDelay: null };
  return { allow: chosen.allow, disallow: chosen.disallow, crawlDelay: chosen.delay };
}

/** Length of a rule's match against a path, or -1 when it does not match. */
function matchLength(rule: string, path: string): number {
  if (rule === "") return -1; // an empty Disallow means "allow everything"
  // Only * and $ are special.
  if (!rule.includes("*") && !rule.includes("$")) {
    return path.startsWith(rule) ? rule.length : -1;
  }
  const escaped = rule
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\\\$$/, "$");
  const re = new RegExp(`^${escaped}`);
  return re.test(path) ? rule.length : -1;
}

/**
 * Longest match wins; Allow beats Disallow on a tie, per the spec. An empty
 * rule set permits everything.
 */
export function isAllowed(rules: RobotsRules, path: string): boolean {
  const p = path || "/";
  let bestAllow = -1;
  let bestDisallow = -1;
  for (const a of rules.allow) bestAllow = Math.max(bestAllow, matchLength(a, p));
  for (const d of rules.disallow) bestDisallow = Math.max(bestDisallow, matchLength(d, p));
  if (bestDisallow === -1) return true;
  return bestAllow >= bestDisallow;
}

/** The agent string we identify as, so a site owner can recognise and block us. */
export const VENTURE_USER_AGENT = "VentureOS-Auditor";
