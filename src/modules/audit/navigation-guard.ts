import type { BrowserContext } from "playwright";
import { isBlockedHostname, resolvesToPublicAddress } from "@/lib/safe-fetch";

/**
 * Keep the audit browser on the public internet.
 *
 * ── WHY ────────────────────────────────────────────────────────────────────
 *
 * The public self-serve audit takes a URL from an UNAUTHENTICATED form and
 * hands it to this browser, which then navigates there and screenshots what it
 * finds. `guard.ts` refuses the obvious shapes — `localhost`, `10.x`, a bare IP
 * — but it judges the hostname as TEXT. A domain whose A record points at
 * 127.0.0.1 or at a cloud metadata endpoint reads as a perfectly ordinary
 * website and passes, and the screenshot of whatever answered comes back in the
 * teaser.
 *
 * Checking the submitted host before queueing (which the intake now also does)
 * closes the front door. This closes the rest of the house: a redirect to an
 * internal address, a meta-refresh, a script-driven navigation, an <img> or an
 * XHR pointing inward — every one of those is a request the browser makes on
 * its own, after our check, and only the browser can be told to refuse them.
 *
 * ── COST ───────────────────────────────────────────────────────────────────
 *
 * One DNS lookup per distinct host per audit, memoised for the life of the
 * context. A page pulling forty assets off three hosts pays for three lookups,
 * which is nothing against a 45-second audit budget.
 */
export async function guardPublicNavigation(
  context: BrowserContext,
  /** Test seam: the resolver, so both branches are provable without a network. */
  resolve: (host: string) => Promise<boolean> = resolvesToPublicAddress,
): Promise<void> {
  // Per context, so two audits never share a verdict and the map dies with the
  // browser rather than growing for the life of the worker.
  const verdicts = new Map<string, Promise<boolean>>();

  const judge = (host: string): Promise<boolean> => {
    let pending = verdicts.get(host);
    if (!pending) {
      pending = isBlockedHostname(host) ? Promise.resolve(false) : resolve(host);
      verdicts.set(host, pending);
    }
    return pending;
  };

  await context.route("**/*", async (route) => {
    let url: URL;
    try {
      url = new URL(route.request().url());
    } catch {
      return route.abort("blockedbyclient");
    }

    // data:, blob: and about: never leave the browser, so there is nothing to
    // protect against and blocking them would break ordinary inline images.
    if (url.protocol !== "http:" && url.protocol !== "https:") return route.continue();

    if (await judge(url.hostname)) return route.continue();
    return route.abort("blockedbyclient");
  });
}
