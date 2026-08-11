/**
 * Bot protection for the public booking endpoint (spec §4.21): a honeypot field
 * that must stay empty plus a minimum fill-time check. No third-party CAPTCHA.
 */
export interface BotCheckInput {
  honeypot: string;
  elapsedMs: number; // now − form-render timestamp
  minElapsedMs: number;
}

export type BotVerdict = { ok: true } | { ok: false; reason: "honeypot" | "too_fast" };

export function botVerdict(input: BotCheckInput): BotVerdict {
  if (input.honeypot.trim() !== "") return { ok: false, reason: "honeypot" };
  if (input.elapsedMs < input.minElapsedMs) return { ok: false, reason: "too_fast" };
  return { ok: true };
}

export const MIN_FILL_MS = 2500;
