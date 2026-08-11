/**
 * Referral ledger math (spec §4.18). Pure: attributes WON DealOutcome revenue
 * to the referrer of each lead, and ranks referrers. A ledger, not a partner
 * program — single-hop attribution (referrer → referred lead → deal value).
 */
export type OutcomeResult = "won" | "lost" | "postponed";
export type ReferrerKind = "person" | "company";

export interface RefLeadFact {
  leadId: string;
  referrerId: string | null;
  stage: string;
  result: OutcomeResult | null; // latest DealOutcome; null while still open
  value: number; // WON deal value in HUF (0 otherwise)
}

export interface ReferrerAgg {
  referrerId: string;
  referred: number;
  won: number;
  lost: number;
  postponed: number;
  open: number; // referred leads with no recorded outcome yet
  attributedRevenue: number; // sum of WON values
}

export function aggregateReferrals(facts: RefLeadFact[]): Map<string, ReferrerAgg> {
  const map = new Map<string, ReferrerAgg>();
  for (const f of facts) {
    if (!f.referrerId) continue; // self-sourced revenue is never attributed
    let r = map.get(f.referrerId);
    if (!r) {
      r = {
        referrerId: f.referrerId,
        referred: 0,
        won: 0,
        lost: 0,
        postponed: 0,
        open: 0,
        attributedRevenue: 0,
      };
      map.set(f.referrerId, r);
    }
    r.referred += 1;
    if (f.result === "won") {
      r.won += 1;
      r.attributedRevenue += f.value;
    } else if (f.result === "lost") {
      r.lost += 1;
    } else if (f.result === "postponed") {
      r.postponed += 1;
    } else {
      r.open += 1;
    }
  }
  return map;
}

export interface ReferrerMeta {
  name: string;
  kind: ReferrerKind;
}

export interface TopReferrer extends ReferrerAgg {
  name: string;
  kind: ReferrerKind;
}

export function topReferrers(
  aggs: Map<string, ReferrerAgg>,
  meta: Map<string, ReferrerMeta>,
  limit = 5,
): TopReferrer[] {
  const rows: TopReferrer[] = [...aggs.values()].map((a) => ({
    ...a,
    name: meta.get(a.referrerId)?.name ?? "Unknown referrer",
    kind: meta.get(a.referrerId)?.kind ?? "person",
  }));
  rows.sort(
    (a, b) =>
      b.attributedRevenue - a.attributedRevenue ||
      b.referred - a.referred ||
      a.name.localeCompare(b.name),
  );
  return rows.slice(0, limit);
}
