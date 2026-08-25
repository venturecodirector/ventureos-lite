import { reverse as reverseDns } from "node:dns/promises";
import type { Confidence } from "./types";

/**
 * Company-level visitor identification (playbook-v3 P8/b).
 *
 * ── HOW HONEST THIS IS ──────────────────────────────────────────────────────
 *
 * Most Hungarian micro-businesses browse from a consumer connection, where no
 * company-level identification is possible at all. The playbook says so out
 * loud and expects a hit rate of 10–30%. This module is therefore built to
 * return "nem tudom" often and confidently, and the UI is built to show that
 * as a first-class answer rather than as a blank.
 *
 * The gold is not the identification rate — it is the case where we already
 * know who the page was sent to, and only need to know whether THEY opened it.
 * That question is answered elsewhere (by the page's own target), and needs no
 * guessing at all.
 */

/** Reverse-DNS names that say nothing about a company. */
const CONSUMER_PTR =
  /(^|\.)(dsl|adsl|cable|catv|dial|dyn|dynamic|pool|client|customer|broadband|mobile|gprs|umts|lte|res|residential)[-.0-9]/i;

/** Consumer ISPs: a PTR here identifies the ISP, never the visitor's employer. */
const ISP_DOMAINS = [
  "t-online.hu", "telekom.hu", "upc.hu", "vodafone.hu", "digi.hu", "invitel.hu",
  "externet.hu", "tarr.hu", "telenor.hu", "yettel.hu", "chello.hu", "enternet.hu",
  "comcast.net", "virginm.net", "btcentralplus.com",
];

export interface IdentifyInput {
  ip: string;
  /** Companies in this workspace, for matching. */
  companies: ReadonlyArray<{ id: string; name: string; domain: string | null }>;
  /** Injected so the matcher is testable without a resolver. */
  reverse?: (ip: string) => Promise<string[]>;
}

export interface Identification {
  orgName: string | null;
  companyId: string | null;
  confidence: Confidence;
}

/** The registrable-ish tail of a hostname: "mail.danubia.hu" → "danubia.hu". */
export function ptrDomain(hostname: string): string | null {
  const h = (hostname ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (!h || !h.includes(".")) return null;
  const parts = h.split(".");
  // Two labels normally; three for the second-level suffixes that matter here.
  const twoLevel = /^(co|ac|gov|org|net|com)\.[a-z]{2}$/;
  const tail2 = parts.slice(-2).join(".");
  const tail3 = parts.slice(-3).join(".");
  return twoLevel.test(tail2) && parts.length >= 3 ? tail3 : tail2;
}

/** Letters and digits only, accent-folded — so "Danubia Kft." meets "danubia". */
export function fold(value: string): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** Company-form words that must not carry a match on their own. */
const COMPANY_NOISE = /(kft|bt|zrt|nyrt|kkt|ev|gmbh|ltd|llc|inc|sa|srl|bv|ag)$/;

function nameKey(name: string): string {
  return fold(name).replace(COMPANY_NOISE, "");
}

/**
 * Decide who visited, from the reverse-DNS name alone.
 *
 * high   — the PTR's domain IS a company's domain. That is not a guess.
 * medium — the PTR's domain looks like a company's NAME. Rendered with
 *          "valószínűleg" everywhere it is shown.
 * low    — a PTR exists and names an organisation we do not know.
 * none   — no PTR, or one that identifies an ISP rather than an employer.
 */
export async function identifyVisitor(input: IdentifyInput): Promise<Identification> {
  const reverse = input.reverse ?? ((ip: string) => reverseDns(ip));

  let hostnames: string[] = [];
  try {
    hostnames = await reverse(input.ip);
  } catch {
    return { orgName: null, companyId: null, confidence: "none" };
  }
  const hostname = hostnames[0];
  if (!hostname) return { orgName: null, companyId: null, confidence: "none" };

  const domain = ptrDomain(hostname);
  if (!domain) return { orgName: null, companyId: null, confidence: "none" };

  // A consumer line names the ISP. Reporting "T-Online megnézte az ajánlatot"
  // would be worse than saying nothing.
  if (ISP_DOMAINS.includes(domain) || CONSUMER_PTR.test(hostname)) {
    return { orgName: null, companyId: null, confidence: "none" };
  }

  const exact = input.companies.find(
    (c) => c.domain && c.domain.toLowerCase().replace(/^www\./, "") === domain,
  );
  if (exact) return { orgName: domain, companyId: exact.id, confidence: "high" };

  // The domain's own label against company names: "danubia.hu" → "danubia".
  const label = fold(domain.split(".")[0]!);
  if (label.length >= 4) {
    const byName = input.companies.find((c) => {
      const key = nameKey(c.name);
      return key.length >= 4 && (key === label || key.startsWith(label) || label.startsWith(key));
    });
    if (byName) return { orgName: domain, companyId: byName.id, confidence: "medium" };
  }

  return { orgName: domain, companyId: null, confidence: "low" };
}
