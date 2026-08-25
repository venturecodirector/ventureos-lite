/**
 * Bounds for the prospected-company backfill.
 *
 * A plain module because `backfill-actions.ts` carries `"use server"`, and a
 * value exported from one of those fails the production build while passing
 * typecheck, lint and a cached local build. See test/unit/reachability.test.ts.
 */

/** Companies per paid batch — one Places request each, so this is 12 requests. */
export const BACKFILL_BATCH = 12;

/**
 * Websites read for an email address per apply. Bounded because each is a live
 * fetch of somebody else's server, and reported when it bites.
 */
export const EMAIL_LOOKUP_CAP = 25;
