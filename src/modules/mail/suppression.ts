import { normalizeEmail } from "../leads/dedupe";

/** A recipient is suppressed if their normalized address is on the list. */
export function isRecipientSuppressed(address: string, suppressed: string[]): boolean {
  const a = normalizeEmail(address);
  if (!a) return false;
  return suppressed.some((s) => normalizeEmail(s) === a);
}
