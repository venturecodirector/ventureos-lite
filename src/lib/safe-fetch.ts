import { lookup } from "node:dns/promises";

/**
 * Fetching a URL the OPERATOR typed, without handing them the server's network.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * The domain lookup takes a hostname straight out of a form field and fetches
 * it server-side. Without a guard that is a request forgery primitive: any
 * signed-in user could point it at `http://localhost:6379`, at the Docker
 * network (`http://db:5432`), or at a cloud metadata endpoint, and read back
 * whatever came out. The site enrichment has the same shape and now shares this
 * path, so both are covered by one implementation instead of neither.
 *
 * Three layers, because each catches what the one before it cannot:
 *   1. the hostname itself (`localhost`, a bare label, an IP literal in a
 *      private range),
 *   2. what it RESOLVES to — `evil.com A 127.0.0.1` is a public-looking name
 *      pointing inward, and only DNS reveals it,
 *   3. every redirect hop, re-checked, because hop 1 being public says nothing
 *      about hop 2.
 *
 * ── WHAT IT DOES NOT STOP ───────────────────────────────────────────────────
 *
 * DNS rebinding: between our lookup and the connection, the name can be
 * re-answered with a private address. Closing that needs to pin the connection
 * to the address we checked, which Node's fetch does not expose. The realistic
 * attack — a hostile A-record — is covered; the racing one is not, and is
 * written down here rather than left implied.
 */

/** Suffixes that never belong to a public website. */
const PRIVATE_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".onion"];

function isPrivateIpv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (m.slice(1).some((p) => Number(p) > 255)) return true; // malformed → refuse
  return (
    a === 0 || // "this network"
    a === 10 || // private
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local, incl. cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 168) || // private
    (a === 192 && b === 0) || // IETF protocol assignments
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast and reserved
  );
}

/**
 * The v6 equivalents. Written out because "reject every IPv6 address" was the
 * first attempt and it silently refused every dual-stack site — which is most
 * real company websites — by treating an AAAA record as a disqualification
 * rather than as an address to check.
 */
function isPrivateIpv6(raw: string): boolean {
  const ip = (raw ?? "").toLowerCase().split("%")[0]!; // drop any zone index
  // ::ffff:127.0.0.1 is an IPv4 address wearing a v6 coat.
  const mapped = ip.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isPrivateIpv4(mapped[1]!);
  if (ip === "::" || ip === "::1") return true; // unspecified, loopback
  if (/^f[cd]/.test(ip)) return true; // fc00::/7 unique-local
  if (/^fe[89ab]/.test(ip)) return true; // fe80::/10 link-local
  if (ip.startsWith("64:ff9b:")) return true; // NAT64
  return false;
}

/** True when an address literal points somewhere off the public internet. */
export function isPrivateIpAddress(address: string): boolean {
  return address.includes(":") ? isPrivateIpv6(address) : isPrivateIpv4(address);
}

/**
 * Judge a hostname on its own text. Pure, so the rules are testable without a
 * resolver; `resolvesToPublicAddress` covers what text cannot tell us.
 */
export function isBlockedHostname(raw: string): boolean {
  const host = (raw ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (!host) return true;
  // An IPv6 literal in a company's website field is never legitimate, and the
  // range rules are subtle enough that refusing all of them is the honest call.
  if (host.includes(":") || host.startsWith("[")) return true;
  if (isPrivateIpv4(host)) return true;
  // A bare label is an internal name by definition — `localhost`, `db`, `redis`,
  // `metadata`. A public site always has a dot.
  if (!host.includes(".")) return true;
  if (PRIVATE_SUFFIXES.some((s) => host.endsWith(s))) return true;
  return false;
}

/** Every address the name resolves to must be public, not just the first. */
export async function resolvesToPublicAddress(host: string): Promise<boolean> {
  try {
    const addrs = await lookup(host, { all: true });
    if (addrs.length === 0) return false;
    // EVERY answer has to be public, not just one: a name that resolves to a
    // real server AND to 127.0.0.1 is an attack, not a dual-stack site.
    return addrs.every((a) => !isPrivateIpAddress(a.address));
  } catch {
    return false; // NXDOMAIN or no resolver: nothing to fetch anyway
  }
}

export interface SafeFetchOptions {
  timeoutMs: number;
  userAgent: string;
  accept?: string;
  /** Redirect hops to follow; each one is re-checked. */
  maxHops?: number;
}

/**
 * Fetch a public URL, following redirects by hand so each hop is re-validated.
 * Returns null when the URL is refused, unreachable, or redirects out of reach.
 */
export async function safeFetch(
  url: string,
  opts: SafeFetchOptions,
): Promise<Response | null> {
  let current = url;
  const hops = opts.maxHops ?? 3;

  for (let hop = 0; hop <= hops; hop++) {
    let parsed: URL;
    try {
      parsed = new URL(current);
    } catch {
      return null;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    if (isBlockedHostname(parsed.hostname)) return null;
    if (!(await resolvesToPublicAddress(parsed.hostname))) return null;

    let res: Response;
    try {
      res = await fetch(parsed.toString(), {
        headers: {
          "User-Agent": opts.userAgent,
          ...(opts.accept ? { Accept: opts.accept } : {}),
        },
        signal: AbortSignal.timeout(opts.timeoutMs),
        redirect: "manual",
      });
    } catch {
      return null;
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return res;
      current = new URL(location, parsed).toString();
      continue;
    }
    return res;
  }
  return null; // too many hops
}
