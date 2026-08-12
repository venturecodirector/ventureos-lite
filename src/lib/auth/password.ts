import bcrypt from "bcryptjs";

/**
 * Password hashing (CLAUDE.md → Auth: bcrypt).
 *
 * Cost 12 is ~250ms on the deployment target — slow enough to make offline
 * cracking expensive, fast enough that a login does not feel broken. Raising it
 * is safe: `verifyPassword` reads the cost from the stored hash, so old hashes
 * keep working and `needsRehash` tells the login path to upgrade them.
 */
export const BCRYPT_COST = 12;

/** Placeholder written by the seed for accounts with no password yet. */
export const NO_PASSWORD = "!";

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_COST);
}

/**
 * Constant-time-ish verification. Returns false (never throws) for the
 * placeholder or any malformed hash, so a passwordless account simply cannot
 * log in rather than crashing the login route.
 */
export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  if (!hash || hash === NO_PASSWORD) return false;
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}

/** True when a stored hash was made with a weaker cost than we now use. */
export function needsRehash(hash: string): boolean {
  const m = /^\$2[aby]?\$(\d{2})\$/.exec(hash);
  if (!m) return true;
  return Number(m[1]) < BCRYPT_COST;
}

export interface PasswordProblem {
  message: string;
}

/**
 * Password policy. Deliberately length-first rather than a character-class
 * maze: length is what actually resists cracking, and complexity rules push
 * people toward `Password1!`.
 */
export const MIN_PASSWORD_LENGTH = 12;

const COMMON = new Set([
  "password", "password1", "passw0rd", "123456789012", "qwertyuiop12",
  "letmein12345", "administrator", "ventureos", "ventureco",
]);

export function validatePassword(plain: string): PasswordProblem[] {
  const problems: PasswordProblem[] = [];
  if (plain.length < MIN_PASSWORD_LENGTH) {
    problems.push({ message: `must be at least ${MIN_PASSWORD_LENGTH} characters` });
  }
  if (plain.length > 200) {
    // bcrypt truncates at 72 bytes; refuse absurd input rather than silently ignore it.
    problems.push({ message: "must be at most 200 characters" });
  }
  if (COMMON.has(plain.toLowerCase().replace(/\s+/g, ""))) {
    problems.push({ message: "is too common — pick something unguessable" });
  }
  if (/^(.)\1+$/.test(plain)) {
    problems.push({ message: "cannot be a single repeated character" });
  }
  return problems;
}
