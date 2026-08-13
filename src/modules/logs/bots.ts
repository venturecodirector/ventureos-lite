/**
 * Bot verification by reverse DNS (P2/8).
 *
 * Any scraper can put "Googlebot" in its user agent, and plenty do. Google's
 * own documented check is a reverse lookup to a googlebot.com / google.com
 * host, then a forward lookup back to the same IP — a PTR record alone can be
 * set by whoever controls the address block.
 *
 * This matters commercially, not just technically: telling a client "Google
 * crawled you 4,000 times" when half of it was a content thief would be a
 * finding they act on for the wrong reason.
 */
import { reverse, resolve4, resolve6 } from "node:dns/promises";
import type { BotName } from "./analyze";

const VERIFIED_SUFFIXES: Record<Exclude<BotName, "other">, string[]> = {
  googlebot: ["googlebot.com", "google.com", "googleusercontent.com"],
  bingbot: ["search.msn.com"],
};

/**
 * Only the shape this needs.
 *
 * Node's resolve4 is overloaded to return either strings or records-with-TTL
 * depending on its options; narrowing it here is what lets a test inject a
 * plain function instead of reproducing that signature.
 */
export interface DnsDeps {
  reverse(ip: string): Promise<string[]>;
  resolve4(hostname: string): Promise<string[]>;
  resolve6(hostname: string): Promise<string[]>;
}

/** Cache per run: a crawl hits from a handful of addresses, thousands of times. */
export class BotVerifier {
  private cache = new Map<string, boolean>();

  constructor(
    private readonly deps: DnsDeps = { reverse, resolve4, resolve6 },
    /** Hard cap on lookups, so one upload cannot become a DNS storm. */
    private readonly maxLookups = 500,
  ) {}

  private lookups = 0;

  async verify(ip: string, claimed: BotName): Promise<boolean> {
    if (claimed === "other") return false;
    const key = `${claimed}:${ip}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    if (this.lookups >= this.maxLookups) return false;
    this.lookups += 1;

    let ok = false;
    try {
      const names = await this.deps.reverse(ip);
      const suffixes = VERIFIED_SUFFIXES[claimed];
      const host = names.find((n) =>
        suffixes.some((s) => n.toLowerCase() === s || n.toLowerCase().endsWith(`.${s}`)),
      );
      if (host) {
        // Forward-confirm: a PTR record proves only that whoever runs the
        // address block said so.
        const resolver = ip.includes(":") ? this.deps.resolve6 : this.deps.resolve4;
        const addresses = await resolver(host);
        ok = addresses.includes(ip);
      }
    } catch {
      // An unresolvable address is unverified, which is the safe answer: the
      // report counts it as a claim rather than as a confirmed crawl.
      ok = false;
    }

    this.cache.set(key, ok);
    return ok;
  }
}
