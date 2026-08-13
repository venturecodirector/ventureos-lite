/**
 * Anti-abuse decisions for the public self-serve audit (P12/1a).
 *
 * Everything here is pure and synchronous so the rules can be tested without a
 * database, a clock or a network. The playbook's hard rule for this feature is
 * that a public form must not be able to DoS our own worker, so the decision
 * to accept a submission is deliberately conservative and made in one place.
 */

export type RefusalReason =
  | "invalid_url"
  | "not_public_host"
  | "own_domain"
  | "client_domain"
  | "bot"
  | "rate_limited"
  | "at_capacity";

export interface UrlCheck {
  ok: boolean;
  /** Registrable host, lower-cased, no www. — what we store and match on. */
  domain: string | null;
  normalizedUrl: string | null;
  reason?: RefusalReason;
}

/** Hosts that are never audited: loopback, private ranges, non-public TLDs. */
const PRIVATE_HOST =
  /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|\[?::1\]?|0\.0\.0\.0)/i;

/**
 * Reject anything that is not a plausible public website before it reaches the
 * queue. This is also an SSRF guard: the worker fetches whatever we accept, so
 * loopback and private ranges must never get through.
 */
export function checkUrl(raw: string): UrlCheck {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { ok: false, domain: null, normalizedUrl: null, reason: "invalid_url" };

  let parsed: URL;
  try {
    parsed = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return { ok: false, domain: null, normalizedUrl: null, reason: "invalid_url" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, domain: null, normalizedUrl: null, reason: "invalid_url" };
  }

  const host = parsed.hostname.toLowerCase();
  if (PRIVATE_HOST.test(host) || !host.includes(".") || host.endsWith(".local")) {
    return { ok: false, domain: null, normalizedUrl: null, reason: "not_public_host" };
  }
  // A bare IP literal is not a business website and is a common SSRF probe.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return { ok: false, domain: null, normalizedUrl: null, reason: "not_public_host" };
  }

  const domain = host.replace(/^www\./, "");
  return {
    ok: true,
    domain,
    normalizedUrl: `${parsed.protocol}//${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`,
  };
}

/**
 * Domain-list match that also covers subdomains: "shop.example.com" matches an
 * entry of "example.com", but "notexample.com" does not.
 */
export function domainMatches(domain: string, list: readonly string[]): boolean {
  const d = domain.toLowerCase().replace(/^www\./, "");
  return list.some((raw) => {
    const entry = raw.toLowerCase().trim().replace(/^www\./, "");
    if (!entry) return false;
    return d === entry || d.endsWith(`.${entry}`);
  });
}

export interface SubmissionContext {
  domain: string;
  /** Our own hosts — auditing ourselves is noise, not a lead. */
  ownDomains: readonly string[];
  /** Existing clients: they get a warm message, not a sales funnel. */
  clientDomains: readonly string[];
  /** Result of the honeypot + timing check. */
  looksHuman: boolean;
  /** False when this IP has already used its daily allowance. */
  withinRateLimit: boolean;
  /** Public audits currently queued or running, and the ceiling. */
  inFlight: number;
  maxInFlight: number;
}

export type SubmissionVerdict =
  | { accept: true }
  | { accept: false; reason: RefusalReason; friendly: boolean };

/**
 * Order matters. Cheap local checks first, and the "you are already a client"
 * case is separated from refusals because it deserves a warm message rather
 * than an error — per the playbook, "ügyfelünk vagy".
 */
export function judgeSubmission(ctx: SubmissionContext): SubmissionVerdict {
  if (!ctx.looksHuman) return { accept: false, reason: "bot", friendly: false };
  if (domainMatches(ctx.domain, ctx.ownDomains)) {
    return { accept: false, reason: "own_domain", friendly: true };
  }
  if (domainMatches(ctx.domain, ctx.clientDomains)) {
    return { accept: false, reason: "client_domain", friendly: true };
  }
  if (!ctx.withinRateLimit) return { accept: false, reason: "rate_limited", friendly: false };
  if (ctx.inFlight >= ctx.maxInFlight) {
    return { accept: false, reason: "at_capacity", friendly: false };
  }
  return { accept: true };
}

/**
 * Coarsen an IP before storing it: /24 for IPv4, /48 for IPv6. Enough to rate
 * limit and spot abuse, not enough to pin down a person. The full address is
 * only ever kept on a consent record, where it is evidence of a request.
 */
export function ipPrefix(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const addr = ip.split(",")[0]!.trim();
  if (!addr) return null;
  if (addr.includes(":")) {
    const parts = addr.split(":");
    return `${parts.slice(0, 3).join(":")}::/48`;
  }
  const octets = addr.split(".");
  if (octets.length !== 4) return null;
  return `${octets.slice(0, 3).join(".")}.0/24`;
}
