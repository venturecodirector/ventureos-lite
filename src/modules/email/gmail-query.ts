/**
 * The Gmail search queries a sync pass is allowed to issue (playbook-v2 P2b).
 *
 * This is where "filter at query level, not post-hoc" is actually implemented.
 * Every query is built from CRM addresses and company domains, so Gmail only
 * ever RETURNS mail involving someone we already know about — the user's
 * private correspondence is not fetched and discarded, it is never fetched.
 *
 * Chunked because a Gmail query has a length limit and an address list grows
 * with the pipeline. Chunking is not an optimisation: without it, the query
 * silently truncates past the limit and the sync quietly stops seeing some
 * leads, which is the worst kind of bug — one that looks like nothing.
 *
 * Pure, so the boundary can be tested without a mailbox.
 */
import type { SyncScope } from "./matching";

/**
 * Conservative budget for one query's participant clause. Gmail accepts more,
 * but long URLs get truncated by intermediaries and the failure is invisible.
 */
export const MAX_QUERY_CHARS = 1200;

/** Gmail's date operators take YYYY/MM/DD in the user's timezone. */
export function gmailDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}/${m}/${day}`;
}

/** One participant term: matches the address whether they sent or received. */
function participantTerms(scope: SyncScope): string[] {
  const terms: string[] = [];
  for (const address of scope.addresses) {
    terms.push(`from:${address}`, `to:${address}`, `cc:${address}`);
  }
  for (const domain of scope.domains) {
    terms.push(`from:@${domain}`, `to:@${domain}`, `cc:@${domain}`);
  }
  return terms;
}

export interface QueryWindow {
  /** Inclusive lower bound. */
  after?: Date;
  /** Exclusive upper bound, for a backfill walking backwards. */
  before?: Date;
}

/**
 * The queries for one sync pass.
 *
 * Returns an EMPTY array when the scope is empty — a workspace with no lead
 * addresses yet must issue no query at all. A bare `after:` with no participant
 * clause would match the entire mailbox, which is precisely the thing this
 * module exists to prevent.
 */
export function buildSyncQueries(scope: SyncScope, window: QueryWindow = {}): string[] {
  const terms = participantTerms(scope);
  if (terms.length === 0) return [];

  const bounds: string[] = [];
  if (window.after) bounds.push(`after:${gmailDate(window.after)}`);
  if (window.before) bounds.push(`before:${gmailDate(window.before)}`);
  // Drafts and spam are not correspondence with a lead.
  bounds.push("-in:drafts", "-in:spam", "-in:trash");
  const prefix = bounds.join(" ");

  const queries: string[] = [];
  let chunk: string[] = [];
  let length = 0;

  const flush = () => {
    if (chunk.length === 0) return;
    queries.push(`${prefix} {${chunk.join(" ")}}`);
    chunk = [];
    length = 0;
  };

  for (const term of terms) {
    // +1 for the separating space.
    if (length + term.length + 1 > MAX_QUERY_CHARS) flush();
    chunk.push(term);
    length += term.length + 1;
  }
  flush();

  return queries;
}

/**
 * A backfill walks backwards in windows rather than asking for 90 days at once.
 *
 * One enormous result set is a job that either finishes or does not; a walk is
 * resumable, reports progress honestly, and lets a rate limit pause it without
 * losing the work already done.
 */
export const BACKFILL_DAYS = 90;
export const BACKFILL_WINDOW_DAYS = 15;

export function backfillWindows(now: Date, days = BACKFILL_DAYS): QueryWindow[] {
  const windows: QueryWindow[] = [];
  const dayMs = 86_400_000;
  for (let offset = 0; offset < days; offset += BACKFILL_WINDOW_DAYS) {
    const before = new Date(now.getTime() - offset * dayMs);
    const after = new Date(
      now.getTime() - Math.min(offset + BACKFILL_WINDOW_DAYS, days) * dayMs,
    );
    windows.push({ after, before });
  }
  return windows;
}
