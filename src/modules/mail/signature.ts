import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Mailgun webhook signature verification (spec §4.11). The signature is
 * HMAC-SHA256(signing_key, timestamp + token). Constant-time compare.
 */
export function verifyMailgunSignature(
  signingKey: string,
  timestamp: string,
  token: string,
  signature: string,
): boolean {
  const expected = createHmac("sha256", signingKey)
    .update(timestamp + token)
    .digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
