import { generateSecret, generateSync, generateURI } from "otplib";
import QRCode from "qrcode";

/**
 * TOTP second factor (CLAUDE.md → Auth: "TOTP 2FA (otplib + QR enrollment)").
 *
 * RFC 6238 with the defaults every authenticator app expects: SHA-1, 6 digits,
 * 30-second period. A one-step window either side absorbs clock drift without
 * meaningfully widening the guessing surface.
 *
 * Uses otplib v13's functional API (`generateSync` with an explicit epoch)
 * rather than a one-shot `verify`. We need to know WHICH step a code belonged
 * to in order to burn it — see `verifyTotp`.
 */
export const TOTP_STEP_SECONDS = 30;
export const TOTP_WINDOW = 1;
export const TOTP_DIGITS = 6;
export const TOTP_ISSUER = "Venture OS";

/** Fresh base32 secret for an enrollment. Persist it only once confirmed. */
export function generateTotpSecret(): string {
  return generateSecret();
}

/** The otpauth:// URI an authenticator app scans. */
export function totpUri(email: string, secret: string): string {
  return generateURI({
    strategy: "totp",
    issuer: TOTP_ISSUER,
    label: email,
    secret,
    digits: TOTP_DIGITS,
    period: TOTP_STEP_SECONDS,
  });
}

/** Data-URI PNG of the enrollment QR — inline, no external image host. */
export async function totpQrDataUrl(email: string, secret: string): Promise<string> {
  return QRCode.toDataURL(totpUri(email, secret), {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 220,
    color: { dark: "#00051D", light: "#EFF1F8" },
  });
}

/** Which 30-second step a moment in time falls in. */
export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);
}

/** The 6-digit code valid for a given step. Exposed for tests and enrollment. */
export function codeForStep(secret: string, step: number): string {
  return generateSync({
    secret,
    strategy: "totp",
    epoch: step * TOTP_STEP_SECONDS,
    period: TOTP_STEP_SECONDS,
    digits: TOTP_DIGITS,
  });
}

export type TotpResult =
  | { ok: true; step: number }
  | { ok: false; reason: "malformed" | "invalid" | "replayed" };

/**
 * Verify a code and pin down which step it belonged to.
 *
 * `lastUsedStep` closes the replay hole a plain validity check leaves open:
 * without it, a code that was shoulder-surfed (or captured by a proxy) stays
 * usable for the rest of its 30-second window and can be spent twice. Callers
 * MUST persist the returned `step` and pass it back on the next attempt.
 */
export function verifyTotp(
  code: string,
  secret: string,
  nowMs: number,
  lastUsedStep: number | null,
): TotpResult {
  const cleaned = code.replace(/[\s-]/g, "");
  if (!new RegExp(`^\\d{${TOTP_DIGITS}}$`).test(cleaned)) return { ok: false, reason: "malformed" };
  if (!secret) return { ok: false, reason: "invalid" };

  const current = totpStep(nowMs);
  for (let offset = -TOTP_WINDOW; offset <= TOTP_WINDOW; offset += 1) {
    const step = current + offset;
    let expected: string;
    try {
      expected = codeForStep(secret, step);
    } catch {
      return { ok: false, reason: "invalid" };
    }
    if (!timingSafeEqual(expected, cleaned)) continue;
    if (lastUsedStep !== null && step <= lastUsedStep) {
      return { ok: false, reason: "replayed" };
    }
    return { ok: true, step };
  }
  return { ok: false, reason: "invalid" };
}

/** Comparison that does not short-circuit on the first differing digit. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
