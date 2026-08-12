import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";

/**
 * Envelope encryption for credentials stored in the database.
 *
 * AES-256-GCM, chosen because it authenticates as well as encrypts: a row
 * tampered with in the database fails to decrypt rather than silently yielding
 * altered bytes. Each value gets a fresh 96-bit IV — reusing an IV under GCM is
 * catastrophic, so it is generated per call and never derived from the value.
 *
 * Stored format: `v1.<iv>.<tag>.<ciphertext>`, all base64url. The version
 * prefix is there so the scheme can be rotated later without guessing at what
 * old rows contain.
 *
 * The key comes from CREDENTIALS_KEY. It is deliberately NOT editable from the
 * UI: it is what protects everything that IS editable there.
 */
const VERSION = "v1";
const IV_BYTES = 12;
const KEY_BYTES = 32;

export class CredentialCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialCryptoError";
  }
}

/**
 * Resolve the master key.
 *
 * Accepts base64 or hex of exactly 32 bytes. A passphrase is also accepted and
 * hashed to 32 bytes — not ideal, but far better than refusing to boot and
 * pushing someone toward disabling encryption entirely; the deploy docs ask for
 * `openssl rand -base64 32`.
 */
export function credentialKey(raw: string | undefined = process.env.CREDENTIALS_KEY): Buffer {
  if (!raw || !raw.trim()) {
    throw new CredentialCryptoError(
      "CREDENTIALS_KEY is not set — integration credentials cannot be encrypted or read.",
    );
  }
  const value = raw.trim();

  for (const encoding of ["base64", "hex"] as const) {
    try {
      const buf = Buffer.from(value, encoding);
      if (buf.length === KEY_BYTES) return buf;
    } catch {
      /* try the next encoding */
    }
  }
  // Fall back to a hash of whatever was provided, so an operator who pasted a
  // passphrase still gets a well-formed 256-bit key.
  return createHash("sha256").update(value).digest();
}

export function encryptSecret(plaintext: string, key: Buffer = credentialKey()): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptSecret(stored: string, key: Buffer = credentialKey()): string {
  const parts = stored.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new CredentialCryptoError("Stored credential is not in the expected format.");
  }
  const [, ivB64, tagB64, dataB64] = parts;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64url"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // Wrong key, or the row was altered. Both mean "do not trust this value".
    throw new CredentialCryptoError(
      "Could not decrypt a stored credential — CREDENTIALS_KEY may have changed.",
    );
  }
}

/**
 * What the UI shows instead of a secret: enough to recognise which key is in
 * place, never enough to use it.
 */
export function maskSecret(value: string): string {
  const v = value.trim();
  if (!v) return "";
  if (v.length <= 4) return "••••";
  return `••••${v.slice(-4)}`;
}
