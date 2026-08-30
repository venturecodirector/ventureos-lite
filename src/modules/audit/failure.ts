/**
 * Turning whatever the audit pipeline threw into a sentence an operator can act on.
 *
 * ── WHY ─────────────────────────────────────────────────────────────────────
 *
 * A failed audit used to render as the single word "failed". That is the same
 * amount of information as a spinner that never stops: it does not say whether
 * to retry, to fix the URL, or to write the prospect off — and the three
 * answers are different. Worse, the commonest failure by far was a navigation
 * timeout on a site that was perfectly fine, so "failed" was usually not even
 * true about the prospect.
 *
 * Pure and dependency-free so both the worker and the probe can use it, and so
 * the classification is testable without a browser.
 */

/**
 * The site could not be read, so there is nothing to audit.
 *
 * This is a fact about the site, not a bug in the worker — which is why the
 * processor records it and returns rather than rethrowing. Rethrowing only
 * fills the log with stack traces for mistyped domains.
 */
export class AuditUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditUnreachableError";
  }
}

/** The first line of a thrown error, without Playwright's stack-ish tail. */
export function firstLine(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return raw.split("\n")[0]!.trim();
}

/**
 * What went wrong, in the operator's words.
 *
 * `AuditUnreachableError` already carries a written sentence, so it passes
 * through untouched; everything else is matched on the shapes Playwright and
 * Node actually produce.
 */
export function failureMessage(e: unknown): string {
  if (e instanceof AuditUnreachableError) return e.message;
  const first = firstLine(e);

  if (/ERR_NAME_NOT_RESOLVED|ERR_BLOCKED_BY_CLIENT|ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(first)) {
    return "The address could not be reached — the domain does not resolve to a public address. Check the spelling, and that the site is online.";
  }
  if (/ERR_CERT|ERR_SSL|certificate/i.test(first)) {
    return "The site's HTTPS certificate was rejected by the browser, so the page could not be opened. That is itself a finding worth raising with them.";
  }
  if (/ERR_CONNECTION_REFUSED|ECONNREFUSED|ERR_CONNECTION_RESET|ECONNRESET/i.test(first)) {
    return "The server refused the connection. The site may be down, or blocking automated visitors.";
  }
  if (/Timeout .*exceeded|TimeoutError|timed? ?out/i.test(first)) {
    return "The site took too long to respond, so the audit was stopped. It may be very slow, or refusing automated visitors.";
  }
  return first.slice(0, 300) || "The audit failed for an unknown reason.";
}
