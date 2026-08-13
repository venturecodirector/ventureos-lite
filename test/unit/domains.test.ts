import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { validateEnv, appUrl, auditUrl, quoteUrl, meetUrl } from "../../src/lib/env";
import {
  auditShareLink,
  quoteAcceptLink,
  bookingLink,
  coldUnsubscribeLink,
  appLink,
} from "../../src/lib/public-links";
import { assertStreamDomain, MailStreamError } from "../../src/modules/mail/provider";
import { resolveColdIdentity } from "../../src/modules/campaigns/identity";
import { resolveSendingIdentity } from "../../src/modules/mail/identity";

/**
 * The Domain layout in CLAUDE.md, enforced as executable rules:
 *  - the app is the ROOT of ventureco.agency
 *  - audit./quote./meet. are the public surfaces
 *  - transactional mail goes out ONLY on mg.ventureco.group
 *  - cold mail goes out ONLY on cold.ventureco.agency and can never fall back
 */
const PROD = {
  NODE_ENV: "production",
  DB_FLAVOR: "postgres",
  DATABASE_URL: "postgresql://app:pw@db:5432/ventureos?schema=public",
  APP_DB_PASSWORD: "an-app-role-password",
  REDIS_URL: "redis://redis:6379",
  NEXTAUTH_SECRET: "0123456789012345678901234567890123456789012",
  NEXTAUTH_URL: "https://ventureco.agency",
  ANTHROPIC_API_KEY: "sk-ant-placeholder-key",
  APP_URL: "https://ventureco.agency",
  PUBLIC_AUDIT_URL: "https://audit.ventureco.agency",
  PUBLIC_QUOTE_URL: "https://quote.ventureco.agency",
  PUBLIC_MEET_URL: "https://meet.ventureco.agency",
  FILES_DIR: "/data/files",
  CREDENTIALS_KEY: "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaQ==",
  MAIL_PROVIDER: "mailgun",
  MAILGUN_EU: "true",
  MAILGUN_API_KEY: "key-transactional",
  MAILGUN_DOMAIN: "mg.ventureco.group",
  MAILGUN_WEBHOOK_SIGNING_KEY: "whsk",
  MAILGUN_COLD_API_KEY: "key-cold",
  MAILGUN_COLD_DOMAIN: "cold.ventureco.agency",
} as NodeJS.ProcessEnv;

const problemsFor = (env: NodeJS.ProcessEnv, variable: string) =>
  validateEnv(env, true).problems.filter((p) => p.variable === variable);

describe("env validation", () => {
  it("accepts the documented production layout", () => {
    const result = validateEnv(PROD, true);
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("names every missing variable rather than failing on the first", () => {
    const { ok, problems } = validateEnv(
      { NODE_ENV: "production", DB_FLAVOR: "postgres" } as NodeJS.ProcessEnv,
      true,
    );
    expect(ok).toBe(false);
    const named = problems.map((p) => p.variable);
    for (const v of ["DATABASE_URL", "APP_URL", "NEXTAUTH_SECRET", "PUBLIC_QUOTE_URL"]) {
      expect(named).toContain(v);
    }
    expect(problems.every((p) => p.message.length > 0)).toBe(true);
  });

  it("refuses a cold domain equal to the transactional domain", () => {
    const same = { ...PROD, MAILGUN_COLD_DOMAIN: "mg.ventureco.group" };
    const found = problemsFor(same, "MAILGUN_COLD_DOMAIN");
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain("must differ from MAILGUN_DOMAIN");
  });

  it("refuses a cold domain configured without its own API key", () => {
    const { MAILGUN_COLD_API_KEY, ...noKey } = PROD;
    expect(problemsFor(noKey as NodeJS.ProcessEnv, "MAILGUN_COLD_API_KEY")).toHaveLength(1);
  });

  it("refuses reusing the transactional key for the cold domain", () => {
    const shared = { ...PROD, MAILGUN_COLD_API_KEY: PROD.MAILGUN_API_KEY };
    expect(problemsFor(shared, "MAILGUN_COLD_API_KEY")).toHaveLength(1);
  });

  it("requires the Mailgun EU region in production", () => {
    expect(problemsFor({ ...PROD, MAILGUN_EU: "false" }, "MAILGUN_EU")).toHaveLength(1);
  });

  it("rejects loopback, http and duplicated origins in production", () => {
    expect(
      problemsFor({ ...PROD, PUBLIC_MEET_URL: "http://localhost:3000" }, "PUBLIC_MEET_URL").length,
    ).toBeGreaterThan(0);
    const dup = { ...PROD, PUBLIC_QUOTE_URL: PROD.PUBLIC_AUDIT_URL };
    expect(problemsFor(dup, "PUBLIC_QUOTE_URL")[0].message).toContain("identical to");
  });

  it("rejects a scheme or path in a Mailgun domain", () => {
    expect(problemsFor({ ...PROD, MAILGUN_DOMAIN: "https://mg.ventureco.group" }, "MAILGUN_DOMAIN"))
      .toHaveLength(1);
  });

  it("requires postgres in production", () => {
    expect(problemsFor({ ...PROD, DB_FLAVOR: "mysql" }, "DB_FLAVOR")).toHaveLength(1);
  });

  it("treats a blank value as missing, not as a format error", () => {
    const blank = { ...PROD, ANTHROPIC_API_KEY: "   " };
    expect(problemsFor(blank, "ANTHROPIC_API_KEY")[0].message).toBe("is required but not set");
  });
});

describe("public link generation", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    Object.assign(process.env, {
      APP_URL: "https://ventureco.agency",
      PUBLIC_AUDIT_URL: "https://audit.ventureco.agency",
      PUBLIC_QUOTE_URL: "https://quote.ventureco.agency",
      PUBLIC_MEET_URL: "https://meet.ventureco.agency",
    });
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("puts each public page on its own subdomain, app on the root", () => {
    expect(appUrl()).toBe("https://ventureco.agency");
    expect(auditShareLink("abc")).toBe("https://audit.ventureco.agency/r/abc");
    expect(quoteAcceptLink("Q-1")).toBe("https://quote.ventureco.agency/Q-1");
    expect(bookingLink("tamas")).toBe("https://meet.ventureco.agency/tamas");
    expect(appLink("/meetings/m1")).toBe("https://ventureco.agency/meetings/m1");
  });

  it("keeps unsubscribe on the app origin so suppression outlives the cold domain", () => {
    expect(coldUnsubscribeLink("r1")).toBe("https://ventureco.agency/api/cold/unsubscribe/r1");
  });

  it("url-encodes slugs", () => {
    expect(auditShareLink("a/b?c")).toBe("https://audit.ventureco.agency/r/a%2Fb%3Fc");
  });

  it("derives the subdomains from APP_URL when the explicit URLs are unset", () => {
    delete process.env.PUBLIC_AUDIT_URL;
    delete process.env.PUBLIC_QUOTE_URL;
    delete process.env.PUBLIC_MEET_URL;
    expect(auditUrl()).toBe("https://audit.ventureco.agency");
    expect(quoteUrl()).toBe("https://quote.ventureco.agency");
    expect(meetUrl()).toBe("https://meet.ventureco.agency");
  });

  it("falls back to in-app paths on localhost, where there are no subdomains", () => {
    process.env.APP_URL = "http://localhost:3000";
    delete process.env.PUBLIC_AUDIT_URL;
    delete process.env.PUBLIC_QUOTE_URL;
    delete process.env.PUBLIC_MEET_URL;
    expect(auditShareLink("abc")).toBe("http://localhost:3000/share/abc");
    expect(quoteAcceptLink("abc")).toBe("http://localhost:3000/accept/abc");
    expect(bookingLink("tamas")).toBe("http://localhost:3000/book/tamas");
  });
});

describe("mail stream separation (enforced in code, not config)", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.MAILGUN_DOMAIN = "mg.ventureco.group";
    process.env.MAILGUN_COLD_DOMAIN = "cold.ventureco.agency";
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  const msg = (domain: string, stream?: "cold" | "transactional") => ({
    domain,
    stream,
    to: "a@b.hu",
    from: "x <x@y>",
    subject: "s",
    html: "<p>h</p>",
  });

  it("routes each stream to its own credentials", () => {
    expect(assertStreamDomain(msg("mg.ventureco.group"))).toBe("MAILGUN_API_KEY");
    expect(assertStreamDomain(msg("cold.ventureco.agency", "cold"))).toBe(
      "MAILGUN_COLD_API_KEY",
    );
  });

  it("refuses cold mail on the transactional domain", () => {
    expect(() => assertStreamDomain(msg("mg.ventureco.group", "cold"))).toThrow(MailStreamError);
    expect(() => assertStreamDomain(msg("mg.ventureco.group", "cold"))).toThrow(
      /cold mail on the transactional domain/,
    );
  });

  it("refuses to fall back to the transactional domain even with cold unconfigured", () => {
    delete process.env.MAILGUN_COLD_DOMAIN;
    expect(() => assertStreamDomain(msg("mg.ventureco.group", "cold"))).toThrow(
      /cold mail on the transactional domain/,
    );
  });

  it("allows a per-workspace cold domain, still on the cold credentials", () => {
    // Workspace.featureFlags.coldEmail.coldDomain may differ from the env default.
    expect(assertStreamDomain(msg("cold.acme.hu", "cold"))).toBe("MAILGUN_COLD_API_KEY");
  });

  it("refuses transactional mail on the cold domain", () => {
    expect(() => assertStreamDomain(msg("cold.ventureco.agency"))).toThrow(
      /transactional mail on the cold domain/,
    );
  });

  it("refuses everything when both domains are configured the same", () => {
    process.env.MAILGUN_COLD_DOMAIN = "mg.ventureco.group";
    expect(() => assertStreamDomain(msg("mg.ventureco.group"))).toThrow(/both/);
    expect(() => assertStreamDomain(msg("mg.ventureco.group", "cold"))).toThrow(/both/);
  });
});

describe("sending identities carry no hardcoded domain", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("uses MAILGUN_DOMAIN for transactional and fails without one", () => {
    process.env.MAILGUN_DOMAIN = "mg.ventureco.group";
    expect(resolveSendingIdentity(null).domain).toBe("mg.ventureco.group");
    expect(resolveSendingIdentity(null).fromEmail).toBe("noreply@mg.ventureco.group");
    delete process.env.MAILGUN_DOMAIN;
    expect(() => resolveSendingIdentity(null)).toThrow(/No transactional sending domain/);
  });

  it("uses MAILGUN_COLD_DOMAIN for cold and refuses to reuse the transactional one", () => {
    process.env.MAILGUN_DOMAIN = "mg.ventureco.group";
    process.env.MAILGUN_COLD_DOMAIN = "cold.ventureco.agency";
    const cold = resolveColdIdentity(null, { coldEmail: {} });
    expect(cold.domain).toBe("cold.ventureco.agency");
    expect(cold.fromEmail).toBe("outreach@cold.ventureco.agency");

    // A per-workspace override may not point cold traffic at transactional.
    expect(() =>
      resolveColdIdentity(null, { coldEmail: { coldDomain: "mg.ventureco.group" } }),
    ).toThrow(/transactional/);

    delete process.env.MAILGUN_COLD_DOMAIN;
    expect(() => resolveColdIdentity(null, { coldEmail: {} })).toThrow(
      /No cold sending domain/,
    );
  });
});
