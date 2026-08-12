import { randomBytes } from "node:crypto";

/**
 * Public audit share pages (spec §4.4): unique unlisted slug, 60-day expiry,
 * open tracking. The slug is unguessable (unlisted, not secret-grade).
 */
export const SHARE_TTL_DAYS = 60;

export function generateSlug(): string {
  return randomBytes(9).toString("base64url"); // 12 url-safe chars
}

export function shareExpiryFrom(now: Date): Date {
  return new Date(now.getTime() + SHARE_TTL_DAYS * 86_400_000);
}

export function isShareExpired(expiresAt: Date, now: Date): boolean {
  return now.getTime() >= expiresAt.getTime();
}

/**
 * Public URL of a share. Delegates to the central link builder so the host
 * comes from PUBLIC_AUDIT_URL (audit.ventureco.agency) and never from a
 * caller-supplied or hardcoded base.
 */
export { auditShareLink as shareUrl } from "../../lib/public-links";
