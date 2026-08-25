import { resolveMx, resolve4, resolve6 } from "node:dns/promises";
import type { VerifyReason } from "./types";

/**
 * Does this domain accept mail at all? (playbook-v3 P9/2, layer 2.)
 *
 * An MX record is the closest thing to a free, polite, universally available
 * signal that an address could possibly be delivered. No mail server means no
 * mailbox — that is a fact, not a guess, and it is the check that catches
 * typo'd and lapsed domains before they cost the sending domain anything.
 *
 * A domain with no MX but with an A record still accepts mail by the RFC
 * (implicit MX), so that is treated as deliverable rather than refused.
 */

export interface MxVerdict {
  reason: VerifyReason | null;
  /** Mail hosts, for the display and for a provider that wants them. */
  hosts: string[];
}

/** Never throws — an unreachable resolver is "unknown", not "invalid". */
export async function checkMx(
  domain: string,
  deps: {
    mx?: (d: string) => Promise<Array<{ exchange: string; priority: number }>>;
    a?: (d: string) => Promise<string[]>;
    aaaa?: (d: string) => Promise<string[]>;
  } = {},
): Promise<MxVerdict> {
  const mx = deps.mx ?? resolveMx;
  const a = deps.a ?? resolve4;
  const aaaa = deps.aaaa ?? resolve6;

  try {
    const records = await mx(domain);
    const hosts = records
      .filter((r) => r.exchange && r.exchange !== ".")
      .sort((x, y) => x.priority - y.priority)
      .map((r) => r.exchange);
    if (hosts.length > 0) return { reason: null, hosts };
  } catch (e) {
    const code = (e as { code?: string }).code;
    // NXDOMAIN is the domain saying it does not exist. Anything else is our
    // side failing to ask, which is not evidence about the address.
    if (code === "ENOTFOUND" || code === "ENODATA") {
      // ENODATA means the domain exists but has no MX — fall through to A.
      if (code === "ENOTFOUND") return { reason: "domain_not_found", hosts: [] };
    } else {
      return { reason: "dns_unavailable", hosts: [] };
    }
  }

  // RFC 5321 §5.1: no MX but an address record means the host itself takes mail.
  try {
    const v4 = await a(domain).catch(() => [] as string[]);
    const v6 = v4.length ? [] : await aaaa(domain).catch(() => [] as string[]);
    if (v4.length > 0 || v6.length > 0) return { reason: null, hosts: [domain] };
  } catch {
    /* fall through */
  }
  return { reason: "no_mx", hosts: [] };
}
