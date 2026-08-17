import { createHash, randomBytes } from "node:crypto";

/**
 * NAV Online Számla request authentication.
 *
 * Two hashes, two DIFFERENT algorithms, in the same `<user>` block. Getting this
 * wrong produces `INVALID_REQUEST_SIGNATURE` on every call with nothing to
 * distinguish it from a wrong key, so it is worth stating plainly:
 *
 *   passwordHash      SHA-512   uppercase hex   (spec §1.3.2 note 6)
 *   requestSignature  SHA3-512  uppercase hex   (spec §1.3.2 note 7)
 *
 * SHA-512 and SHA3-512 are unrelated algorithms, not aliases. The brief for this
 * work specified SHA-512 for the signature; the current specification is explicit
 * that SHA3-512 is the only accepted value, and the worked example below is what
 * settles it.
 *
 * Implemented against: EN_Online Invoice System 3.0 Interface Specification
 * (2026.02.12.), from NAV's own repository. See docs/integrations/nav-taxpayer.md.
 */

/** Endpoints, per spec §6. */
export const NAV_BASE_URL = {
  test: "https://api-test.onlineszamla.nav.gov.hu/invoiceService/v3",
  production: "https://api.onlineszamla.nav.gov.hu/invoiceService/v3",
} as const;
export type NavEnvironment = keyof typeof NAV_BASE_URL;

/** The documented synchronous blocking timeout is 5000 ms (spec §1.6.6). */
export const NAV_TIMEOUT_MS = 5000;

const upperHex = (algo: string, input: string) =>
  createHash(algo).update(input, "utf8").digest("hex").toUpperCase();

/** SHA-512, uppercase. The technical user's password. */
export function navPasswordHash(password: string): string {
  return upperHex("sha512", password);
}

/**
 * The timestamp mask the signature is built from: YYYYMMDDhhmmss in UTC, with
 * every separator and the zone removed (spec §1.5).
 */
export function navTimestampMask(at: Date): string {
  return at.toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
}

/** The wire format for `<common:timestamp>`: UTC, milliseconds, trailing Z. */
export function navTimestamp(at: Date): string {
  return `${at.toISOString().slice(0, 23)}Z`;
}

/**
 * A requestId.
 *
 * Must match `[+a-zA-Z0-9_]{1,30}` and be unique per taxpayer within the
 * timestamp tolerance — and uniqueness is enforced across rejected requests too,
 * so a retry after `INVALID_REQUEST_SIGNATURE` must mint a fresh one rather than
 * resending. Random rather than sequential for exactly that reason.
 */
export function navRequestId(): string {
  return `VOS${randomBytes(9).toString("hex").toUpperCase()}`;
}

/**
 * `requestSignature` for every operation except manageInvoice/manageAnnulment —
 * so including queryTaxpayer (spec §1.5.2).
 *
 *   SHA3-512( requestId + YYYYMMDDhhmmss + signKey ), uppercase
 */
export function navRequestSignature(params: {
  requestId: string;
  timestamp: Date;
  signKey: string;
}): string {
  const base = `${params.requestId}${navTimestampMask(params.timestamp)}${params.signKey}`;
  return upperHex("sha3-512", base);
}

/**
 * `requestSignature` for manageInvoice/manageAnnulment (spec §1.5.1).
 *
 * Not needed for taxpayer lookup, and implemented anyway because it is what the
 * specification publishes a worked example for — which makes it the only part of
 * this file that can be tested against a known answer from NAV rather than
 * against our own reasoning. The invoice path will need it later.
 */
export function navInvoiceRequestSignature(params: {
  requestId: string;
  timestamp: Date;
  signKey: string;
  /** In index order: the operation literal and the base64 invoice payload. */
  indices: { operation: string; base64Data: string }[];
}): string {
  const partial = `${params.requestId}${navTimestampMask(params.timestamp)}${params.signKey}`;
  const indexHashes = params.indices
    .map((i) => upperHex("sha3-512", `${i.operation}${i.base64Data}`))
    .join("");
  return upperHex("sha3-512", `${partial}${indexHashes}`);
}
