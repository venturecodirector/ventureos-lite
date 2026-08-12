import { describe, it, expect } from "vitest";
import {
  credentialKey,
  encryptSecret,
  decryptSecret,
  maskSecret,
  CredentialCryptoError,
} from "../../src/lib/crypto";
import {
  ALL_FIELDS,
  INFRASTRUCTURE_VARS,
  INTEGRATION_GROUPS,
  fieldByKey,
  validateField,
  validateResolved,
} from "../../src/modules/integrations/registry";

const KEY = Buffer.alloc(32, 7);

describe("credential encryption", () => {
  it("round-trips a secret", () => {
    const secret = "key-9f2b0c9d7e5a1436";
    const stored = encryptSecret(secret, KEY);
    expect(decryptSecret(stored, KEY)).toBe(secret);
  });

  it("never stores the plaintext", () => {
    const secret = "sk-ant-super-secret-value";
    const stored = encryptSecret(secret, KEY);
    expect(stored).not.toContain(secret);
    expect(stored).not.toContain("super-secret");
  });

  it("uses a fresh IV, so the same value encrypts differently every time", () => {
    const a = encryptSecret("same", KEY);
    const b = encryptSecret("same", KEY);
    expect(a).not.toBe(b);
    expect(decryptSecret(a, KEY)).toBe(decryptSecret(b, KEY));
  });

  it("is versioned so the scheme can be rotated later", () => {
    expect(encryptSecret("x", KEY).startsWith("v1.")).toBe(true);
  });

  it("refuses a value tampered with in the database", () => {
    const stored = encryptSecret("original", KEY);
    const parts = stored.split(".");
    // Flip a byte of the ciphertext; GCM's tag must catch it.
    const data = Buffer.from(parts[3], "base64url");
    data[0] ^= 0xff;
    parts[3] = data.toString("base64url");
    expect(() => decryptSecret(parts.join("."), KEY)).toThrow(CredentialCryptoError);
  });

  it("refuses to decrypt with the wrong key", () => {
    const stored = encryptSecret("original", KEY);
    expect(() => decryptSecret(stored, Buffer.alloc(32, 9))).toThrow(CredentialCryptoError);
  });

  it("rejects a malformed stored value rather than guessing", () => {
    expect(() => decryptSecret("nonsense", KEY)).toThrow(CredentialCryptoError);
    expect(() => decryptSecret("v2.a.b.c", KEY)).toThrow(CredentialCryptoError);
  });

  it("throws a clear error when no key is configured", () => {
    expect(() => credentialKey("")).toThrow(CredentialCryptoError);
    expect(() => credentialKey(undefined)).toThrow(CredentialCryptoError);
  });

  it("accepts base64, hex, or a passphrase, always yielding 32 bytes", () => {
    expect(credentialKey(Buffer.alloc(32, 1).toString("base64"))).toHaveLength(32);
    expect(credentialKey(Buffer.alloc(32, 2).toString("hex"))).toHaveLength(32);
    expect(credentialKey("a passphrase someone pasted")).toHaveLength(32);
  });
});

describe("masking", () => {
  it("shows only the last four characters", () => {
    expect(maskSecret("key-abcdef123456")).toBe("••••3456");
    expect(maskSecret("abcd")).toBe("••••");
    expect(maskSecret("")).toBe("");
  });

  it("never leaks the leading part of a key", () => {
    const masked = maskSecret("sk-ant-api03-verysecret");
    expect(masked).not.toContain("sk-ant");
  });
});

describe("registry", () => {
  it("has a unique storage key per field", () => {
    const keys = ALL_FIELDS.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("keeps the two Mailgun setups in separate groups", () => {
    const tx = INTEGRATION_GROUPS.find((g) => g.id === "mailgun_transactional")!;
    const cold = INTEGRATION_GROUPS.find((g) => g.id === "mailgun_cold")!;
    expect(tx.fields.map((f) => f.key)).toContain("mailgun.tx.apiKey");
    expect(cold.fields.map((f) => f.key)).toContain("mailgun.cold.apiKey");
    expect(tx.fields.some((f) => f.key.includes("cold"))).toBe(false);
  });

  it("never exposes an infrastructure variable as an editable field", () => {
    const editableEnvVars = new Set(ALL_FIELDS.map((f) => f.envVar).filter(Boolean));
    for (const infra of INFRASTRUCTURE_VARS) {
      expect(editableEnvVars.has(infra.name)).toBe(false);
    }
    // The encryption key in particular must never be editable from the UI it protects.
    expect(INFRASTRUCTURE_VARS.map((v) => v.name)).toContain("CREDENTIALS_KEY");
  });

  it("marks secrets as secret and domains as plain", () => {
    expect(fieldByKey("mailgun.cold.apiKey")?.kind).toBe("secret");
    expect(fieldByKey("mailgun.cold.domain")?.kind).toBe("plain");
  });
});

describe("field validation", () => {
  it("checks the Anthropic key shape", () => {
    expect(validateField("anthropic.apiKey", "nope")).toMatch(/sk-ant-/);
    expect(validateField("anthropic.apiKey", "sk-ant-abc")).toBeNull();
  });

  it("rejects a scheme in a domain field", () => {
    expect(validateField("mailgun.tx.domain", "https://mg.x.hu")).toMatch(/bare hostname/);
    expect(validateField("mailgun.tx.domain", "mg.x.hu")).toBeNull();
  });

  it("always allows clearing a value", () => {
    expect(validateField("anthropic.apiKey", "")).toBeNull();
    expect(validateField("mailgun.tx.domain", "   ")).toBeNull();
  });

  it("refuses an unknown key", () => {
    expect(validateField("something.made.up", "x")).toBe("Unknown setting.");
  });
});

describe("the Mailgun invariant, wherever the values came from", () => {
  it("passes when the two domains differ", () => {
    expect(
      validateResolved({
        "mailgun.tx.domain": "mg.ventureco.group",
        "mailgun.cold.domain": "cold.ventureco.agency",
      }),
    ).toEqual([]);
  });

  it("catches a collision introduced by a DATABASE value, not just env", () => {
    // This is the case the boot-time env check cannot see.
    const problems = validateResolved({
      "mailgun.tx.domain": "mg.ventureco.group",
      "mailgun.cold.domain": "MG.VENTURECO.GROUP",
    });
    expect(problems).toHaveLength(1);
    expect(problems[0].key).toBe("mailgun.cold.domain");
    expect(problems[0].message).toMatch(/cannot be the same/i);
  });

  it("catches a shared sending key", () => {
    const problems = validateResolved({
      "mailgun.tx.domain": "mg.a.hu",
      "mailgun.cold.domain": "cold.b.hu",
      "mailgun.tx.apiKey": "key-same",
      "mailgun.cold.apiKey": "key-same",
    });
    expect(problems.map((p) => p.key)).toContain("mailgun.cold.apiKey");
  });

  it("rejects a malformed domain", () => {
    const problems = validateResolved({ "mailgun.tx.domain": "not a host" });
    expect(problems[0].key).toBe("mailgun.tx.domain");
  });

  it("says nothing when only one side is configured", () => {
    expect(validateResolved({ "mailgun.tx.domain": "mg.a.hu" })).toEqual([]);
    expect(validateResolved({})).toEqual([]);
  });
});
