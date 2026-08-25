import { describe, it, expect, vi } from "vitest";
import { checkLocal, isDisposable, ROLE_LOCAL_PARTS } from "../../src/modules/verification/local";
import { checkMx } from "../../src/modules/verification/dns";
import { verifyAddress } from "../../src/modules/verification/verify";
import { nullVerifier, type VerifierProvider } from "../../src/modules/verification/provider";
import { isStale, REASON_TEXT, REVERIFY_AFTER_DAYS } from "../../src/modules/verification/types";

/**
 * Email verification (playbook-v3 P9/2).
 *
 * The rule the whole design turns on: each layer can only make the answer
 * WORSE. A paid verifier saying "valid" must not rescue an address whose domain
 * has no mail server, and an MX record must not un-flag a role address.
 */

describe("layer 1 — text", () => {
  it("rejects what is not an address", () => {
    for (const raw of ["", "  ", "nope", "a@b", "two@@at.hu", "sp ace@x.hu", null, undefined]) {
      expect(checkLocal(raw).reason, String(raw)).toBe("syntax");
    }
  });

  it("normalises before judging", () => {
    expect(checkLocal("  MAILTO:Info@Példa.HU ".replace("Példa", "pelda")).address).toBe(
      "info@pelda.hu",
    );
  });

  it("catches throwaway mailboxes, including on a subdomain", () => {
    expect(isDisposable("mailinator.com")).toBe(true);
    expect(isDisposable("mail.mailinator.com")).toBe(true);
    expect(isDisposable("yopmail.fr")).toBe(true);
    expect(checkLocal("x@guerrillamail.com").reason).toBe("disposable");
  });

  it("does not mistake a real domain for a throwaway", () => {
    for (const d of ["gmail.com", "ventureco.agency", "pelda.hu", "notmailinator.com"]) {
      expect(isDisposable(d), d).toBe(false);
    }
  });

  /**
   * The judgement call the playbook is explicit about: for a ten-person
   * Hungarian bakery, info@ IS the owner's inbox. Refusing to mail it would
   * refuse the segment.
   */
  it("FLAGS a role address rather than blocking it", () => {
    const v = checkLocal("info@pelda.hu");
    expect(v.reason).toBeNull();
    expect(v.isRole).toBe(true);
  });

  it("sees through a plus tag and dots to the same shared inbox", () => {
    expect(checkLocal("info+campaign@pelda.hu").isRole).toBe(true);
    expect(checkLocal("in.fo@pelda.hu").isRole).toBe(true);
  });

  it("knows the Hungarian role names too", () => {
    for (const local of ["iroda", "kapcsolat", "ugyfelszolgalat", "titkarsag", "szamlazas"]) {
      expect(ROLE_LOCAL_PARTS).toContain(local);
      expect(checkLocal(`${local}@pelda.hu`).isRole, local).toBe(true);
    }
  });

  it("treats a no-reply mailbox as undeliverable, not merely risky", () => {
    expect(checkLocal("noreply@pelda.hu").reason).toBe("syntax");
    expect(checkLocal("postmaster@pelda.hu").reason).toBe("syntax");
  });

  it("leaves an ordinary personal address alone", () => {
    const v = checkLocal("kovacs.anna@pelda.hu");
    expect(v.reason).toBeNull();
    expect(v.isRole).toBe(false);
    expect(v.domain).toBe("pelda.hu");
  });
});

describe("layer 2 — DNS", () => {
  const mxOk = async () => [{ exchange: "mail.pelda.hu", priority: 10 }];
  const noRecords = async () => {
    const e = new Error("no data") as Error & { code: string };
    e.code = "ENODATA";
    throw e;
  };
  const nxdomain = async () => {
    const e = new Error("not found") as Error & { code: string };
    e.code = "ENOTFOUND";
    throw e;
  };
  const broken = async () => {
    const e = new Error("servfail") as Error & { code: string };
    e.code = "ESERVFAIL";
    throw e;
  };

  it("accepts a domain with mail servers, best priority first", async () => {
    const r = await checkMx("pelda.hu", {
      mx: async () => [
        { exchange: "backup.pelda.hu", priority: 20 },
        { exchange: "mail.pelda.hu", priority: 10 },
      ],
    });
    expect(r.reason).toBeNull();
    expect(r.hosts[0]).toBe("mail.pelda.hu");
  });

  it("refuses a domain that does not exist", async () => {
    expect((await checkMx("nincsilyen.hu", { mx: nxdomain })).reason).toBe("domain_not_found");
  });

  it("accepts an implicit MX — an A record means the host takes mail", async () => {
    const r = await checkMx("pelda.hu", { mx: noRecords, a: async () => ["93.184.1.1"] });
    expect(r.reason).toBeNull();
    expect(r.hosts).toEqual(["pelda.hu"]);
  });

  it("refuses a domain with neither MX nor address record", async () => {
    const r = await checkMx("pelda.hu", {
      mx: noRecords,
      a: async () => [],
      aaaa: async () => [],
    });
    expect(r.reason).toBe("no_mx");
  });

  /**
   * A resolver failing is OUR problem, not evidence about the address. Calling
   * it invalid would silently drop good prospects every time DNS hiccups.
   */
  it("says 'unavailable' when the resolver fails, never 'invalid'", async () => {
    expect((await checkMx("pelda.hu", { mx: broken })).reason).toBe("dns_unavailable");
  });

  it("ignores a null MX (a domain declaring it accepts no mail)", async () => {
    const r = await checkMx("pelda.hu", {
      mx: async () => [{ exchange: ".", priority: 0 }],
      a: async () => [],
      aaaa: async () => [],
    });
    expect(r.reason).toBe("no_mx");
  });
});

// ---------------------------------------------------------------------------

const goodMx = async () => ({ reason: null, hosts: ["mail.pelda.hu"] });
const noMx = async () => ({ reason: "no_mx" as const, hosts: [] });
const deadDns = async () => ({ reason: "dns_unavailable" as const, hosts: [] });

function fakeProvider(status: "valid" | "risky" | "invalid" | "unknown"): VerifierProvider {
  return { name: "fake", costPerCheckUsd: 0.01, verify: async () => ({ status }) };
}

describe("the layered verdict", () => {
  it("works with no provider at all — that is the default", async () => {
    const r = await verifyAddress("anna@pelda.hu", { mxCheck: goodMx });
    expect(r).toMatchObject({ status: "valid", reason: "ok", address: "anna@pelda.hu" });
    expect(nullVerifier.costPerCheckUsd).toBe(0);
  });

  it("never asks DNS about an address that is not an address", async () => {
    const mx = vi.fn(goodMx);
    const r = await verifyAddress("nope", { mxCheck: mx });
    expect(r.status).toBe("invalid");
    expect(mx).not.toHaveBeenCalled();
  });

  it("does not pay a provider for an address DNS already refused", async () => {
    const provider = { ...fakeProvider("valid"), verify: vi.fn(async () => ({ status: "valid" as const })) };
    const r = await verifyAddress("anna@nincsilyen.hu", { mxCheck: noMx, provider });
    expect(r.status).toBe("invalid");
    expect(provider.verify).not.toHaveBeenCalled();
  });

  it("a provider saying valid cannot rescue a role address", async () => {
    const r = await verifyAddress("info@pelda.hu", {
      mxCheck: goodMx,
      provider: fakeProvider("valid"),
    });
    expect(r.status).toBe("risky");
    expect(r.reason).toBe("role_address");
  });

  it("a provider saying invalid overrides a clean local + DNS pass", async () => {
    const r = await verifyAddress("anna@pelda.hu", {
      mxCheck: goodMx,
      provider: fakeProvider("invalid"),
    });
    expect(r).toMatchObject({ status: "invalid", reason: "provider_invalid" });
  });

  it("a provider that cannot decide leaves the answer unknown, not valid", async () => {
    const r = await verifyAddress("anna@pelda.hu", {
      mxCheck: goodMx,
      provider: fakeProvider("unknown"),
    });
    expect(r.status).toBe("unknown");
  });

  it("a provider that throws does not fail the check", async () => {
    const provider: VerifierProvider = {
      name: "fake",
      costPerCheckUsd: 0.01,
      verify: async () => {
        throw new Error("402 out of credits");
      },
    };
    const r = await verifyAddress("anna@pelda.hu", { mxCheck: goodMx, provider });
    expect(r.status).toBe("unknown");
  });

  it("a broken resolver produces unknown, so nobody is dropped for our outage", async () => {
    const r = await verifyAddress("anna@pelda.hu", { mxCheck: deadDns });
    expect(r).toMatchObject({ status: "unknown", reason: "dns_unavailable" });
  });

  it("has readable text for every reason it can return", async () => {
    for (const key of Object.keys(REASON_TEXT)) {
      expect(REASON_TEXT[key as keyof typeof REASON_TEXT].length).toBeGreaterThan(5);
    }
  });
});

describe("staleness", () => {
  it("re-verifies after 90 days and not before", () => {
    const now = new Date("2026-06-01T00:00:00Z");
    const day = 24 * 60 * 60 * 1000;
    expect(REVERIFY_AFTER_DAYS).toBe(90);
    expect(isStale(null, now)).toBe(true);
    expect(isStale(new Date(now.getTime() - 89 * day), now)).toBe(false);
    expect(isStale(new Date(now.getTime() - 91 * day), now)).toBe(true);
  });
});
