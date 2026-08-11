import type { OutcomeResult } from "./taxonomy";

/**
 * "What closes" aggregation (spec §4.20). Pure: turns per-deal outcome facts
 * into close-rate + revenue rankings by hook, signal, source, segment and
 * audit-score band. Revenue counts WON value only; close rate excludes
 * postponed (won / (won + lost)). Multi-valued dimensions (signals) fan a fact
 * into every matching bucket.
 */
export interface OutcomeDims {
  hook: string | null;
  signals: string[];
  source: string | null;
  segment: string | null;
  scoreBand: string;
}

export interface OutcomeFact {
  result: OutcomeResult;
  value: number;
  dims: OutcomeDims;
}

export interface AggRow {
  key: string;
  deals: number;
  won: number;
  lost: number;
  postponed: number;
  closeRate: number; // won / (won + lost); 0 when no closed deals
  revenue: number; // sum of WON value (HUF)
}

export function aggregate(
  facts: OutcomeFact[],
  keyFn: (f: OutcomeFact) => string[],
): AggRow[] {
  const map = new Map<string, AggRow>();
  for (const f of facts) {
    for (const key of keyFn(f)) {
      let row = map.get(key);
      if (!row) {
        row = { key, deals: 0, won: 0, lost: 0, postponed: 0, closeRate: 0, revenue: 0 };
        map.set(key, row);
      }
      row.deals += 1;
      if (f.result === "won") {
        row.won += 1;
        row.revenue += f.value;
      } else if (f.result === "lost") {
        row.lost += 1;
      } else {
        row.postponed += 1;
      }
    }
  }
  const rows = [...map.values()];
  for (const r of rows) {
    const closed = r.won + r.lost;
    r.closeRate = closed > 0 ? r.won / closed : 0;
  }
  // Rank by revenue, then by close rate, then alphabetically for stability.
  rows.sort(
    (a, b) => b.revenue - a.revenue || b.closeRate - a.closeRate || a.key.localeCompare(b.key),
  );
  return rows;
}

export interface WhatCloses {
  byHook: AggRow[];
  bySignal: AggRow[];
  bySource: AggRow[];
  bySegment: AggRow[];
  byScoreBand: AggRow[];
}

export function buildWhatCloses(facts: OutcomeFact[]): WhatCloses {
  const one = (v: string | null): string[] => (v ? [v] : []);
  return {
    byHook: aggregate(facts, (f) => one(f.dims.hook)),
    bySignal: aggregate(facts, (f) => f.dims.signals),
    bySource: aggregate(facts, (f) => one(f.dims.source)),
    bySegment: aggregate(facts, (f) => one(f.dims.segment)),
    byScoreBand: aggregate(facts, (f) => one(f.dims.scoreBand)),
  };
}
