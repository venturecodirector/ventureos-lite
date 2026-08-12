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

/** Public, unlisted website-audit report — audit.ventureco.agency/<slug>. */
export function auditShareLink(slug: string): string {
  return build(auditUrl(), SURFACE_PATHS.audit, slug);
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
