/**
 * Every prospect-facing URL the system hands out.
 *
 * Domain layout (CLAUDE.md): the authenticated app is the ROOT of
 * ventureco.agency; the three public surfaces are their own subdomains, so a
 * shared audit reads `audit.ventureco.agency/<slug>` rather than exposing an
 * app path. All four origins come from env (src/lib/env.ts) — nothing here
 * hardcodes a host.
 *
 * When a surface is not split out (local dev, where PUBLIC_*_URL is unset and
 * everything is one origin), the link falls back to the in-app path so the same
 * code works without extra configuration.
 */
import { appUrl, auditUrl, meetUrl, quoteUrl } from "./env";

/** The in-app route each public surface is served by. */
export const SURFACE_PATHS = {
  audit: "/share",
  quote: "/accept",
  meet: "/book",
} as const;

function build(surfaceOrigin: string, appPath: string, slug: string): string {
  const encoded = encodeURIComponent(slug);
  const app = appUrl();
  // Dedicated subdomain → clean root-level slug (middleware rewrites it to the
  // app route). Same origin as the app → keep the disambiguating path prefix.
  return surfaceOrigin.toLowerCase() === app.toLowerCase()
    ? `${app}${appPath}/${encoded}`
    : `${surfaceOrigin}/${encoded}`;
}

/**
 * Public, unlisted website-audit report — audit.ventureco.agency/r/<slug>.
 *
 * Moved under /r/ in P12: the root of the audit domain is now the self-serve
 * landing page, so a bare slug there would collide with it. Links already sent
 * to prospects keep working — the middleware 301s a bare slug to /r/<slug>.
 */
export function auditShareLink(slug: string): string {
  const app = appUrl();
  const origin = auditUrl();
  const encoded = encodeURIComponent(slug);
  return origin.toLowerCase() === app.toLowerCase()
    ? `${app}${SURFACE_PATHS.audit}/${encoded}`
    : `${origin}/r/${encoded}`;
}

/** Published sector report — audit.ventureco.agency/reports/<slug>. */
export function sectorReportLink(slug: string): string {
  const app = appUrl();
  const origin = auditUrl();
  const encoded = encodeURIComponent(slug);
  return origin.toLowerCase() === app.toLowerCase()
    ? `${app}/reports/${encoded}`
    : `${origin}/reports/${encoded}`;
}

/** The reports index on the audit domain. */
export function sectorReportsIndexLink(): string {
  const app = appUrl();
  const origin = auditUrl();
  return origin.toLowerCase() === app.toLowerCase() ? `${app}/reports` : `${origin}/reports`;
}

/** Public quote acceptance page — quote.ventureco.agency/<slug>. */
export function quoteAcceptLink(slug: string): string {
  return build(quoteUrl(), SURFACE_PATHS.quote, slug);
}

/** Public booking page for a host's slug — meet.ventureco.agency/<slug>. */
export function bookingLink(slug: string): string {
  return build(meetUrl(), SURFACE_PATHS.meet, slug);
}

/**
 * One-click unsubscribe for cold outreach. Deliberately on the app origin, not
 * the cold domain: suppression must keep working even if the cold domain is
 * later retired or blocklisted.
 */
export function coldUnsubscribeLink(recipientId: string): string {
  return `${appUrl()}/api/cold/unsubscribe/${encodeURIComponent(recipientId)}`;
}

/** Deep link into the authenticated app (digests, owner notifications). */
export function appLink(path: string): string {
  return `${appUrl()}${path.startsWith("/") ? path : `/${path}`}`;
}
