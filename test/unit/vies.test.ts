import { describe, it, expect } from "vitest";
import { viesCheck, viesSummary } from "../../src/modules/registry/vies";

/**
 * VIES, and the one misreading that would do real damage.
 *
 * VIES answers "is this a valid EU VAT identifier". NAV answers "does this
 * taxpayer exist". For a Hungarian VAT-group member those diverge legitimately —
 * measured during this integration, MOL Nyrt.'s own number is `valid: false` in
 * VIES and a fully valid taxpayer in NAV, because a group MEMBER's number is not
 * a trading identifier.
 *
 * So every test below that could be read as "company not found" asserts the
 * opposite: the verdict is `not_valid`, the copy says so explicitly, and nothing
 * in this module produces a status a caller could mistake for absence.
 *
 * The responses are the real shapes, captured live on 2026-08-17.
 */

/** A real VIES reply for HU15789934 (NAV's own number). */
const VALID_BODY = {
  countryCode: "HU",
  vatNumber: "15789934",
  requestDate: "2026-08-17T13:58:53.869Z",
  valid: true,
  requestIdentifier: "",
  name: "NEMZETI ADÓ- ÉS VÁMHIVATAL",
  address: "SZÉCHENYI UTCA 2 1054 BUDAPEST",
  traderName: "---",
  traderStreet: "---",
  traderNameMatch: "NOT_PROCESSED",
};

/** A real VIES reply for a number it does not recognise. */
const INVALID_BODY = {
  countryCode: "HU",
  vatNumber: "10625790",
  requestDate: "2026-08-17T13:58:54.016Z",
  valid: false,
  name: "---",
  address: "---",
  traderNameMatch: "NOT_PROCESSED",
};

const jsonFetch = (body: unknown, status = 200) =>
  (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

describe("a valid EU VAT number", () => {
  it("returns the name and address VIES holds", async () => {
    const v = await viesCheck("15789934-2-51", { fetch: jsonFetch(VALID_BODY) });
    expect(v.status).toBe("valid");
    expect(v.status === "valid" && v.result.name).toBe("NEMZETI ADÓ- ÉS VÁMHIVATAL");
    expect(v.status === "valid" && v.result.address).toContain("1054 BUDAPEST");
  });

  it("strips the '---' VIES uses instead of omitting a field", async () => {
    const v = await viesCheck("15789934", {
      fetch: jsonFetch({ ...VALID_BODY, name: "---", address: "---" }),
    });
    expect(v.status === "valid" && v.result.name).toBeNull();
    expect(v.status === "valid" && v.result.address).toBeNull();
  });

  it("sends the trader name when given one, to enable approximate matching", async () => {
    let sent: string | null = null;
    await viesCheck("15789934", {
      traderName: "Danubia Fogászat",
      fetch: (async (_url: string, init: RequestInit) => {
        sent = String(init.body);
        return new Response(JSON.stringify(VALID_BODY), { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(sent).toContain("traderName");
    expect(sent).toContain("Danubia Fogászat");
  });

  it("queries the 8-digit törzsszám, not the 11-digit form", async () => {
    let sent = "";
    await viesCheck("15789934-2-51", {
      fetch: (async (_url: string, init: RequestInit) => {
        sent = String(init.body);
        return new Response(JSON.stringify(VALID_BODY), { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(sent).toContain('"vatNumber":"15789934"');
    expect(sent).not.toContain("15789934251");
  });
});

describe("a number VIES does not recognise — the dangerous case", () => {
  it("reports not_valid, never a status meaning 'does not exist'", async () => {
    const v = await viesCheck("10625790", { fetch: jsonFetch(INVALID_BODY) });
    expect(v.status).toBe("not_valid");
    // There is deliberately no "unknown" or "not_found" status in this module.
    expect(["valid", "not_valid", "unavailable"]).toContain(v.status);
  });

  it("says in words that this does not mean the company is absent", async () => {
    // MOL is the worked example: valid:false here, a real company at NAV. The
    // copy has to carry that, because the obvious reading is wrong.
    const v = await viesCheck("10625790", { fetch: jsonFetch(INVALID_BODY) });
    const text = viesSummary(v);
    expect(text).toContain("nem jelenti, hogy a cég nem létezik");
    expect(text).toContain("áfacsoport");
  });
});

describe("downtime never breaks the flow", () => {
  it("reports unavailable on a timeout", async () => {
    const v = await viesCheck("15789934", {
      fetch: (async () => {
        throw Object.assign(new Error("t"), { name: "TimeoutError" });
      }) as unknown as typeof fetch,
    });
    expect(v).toEqual({ status: "unavailable", reason: "timeout" });
  });

  it("reports unavailable on a network failure", async () => {
    const v = await viesCheck("15789934", {
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    expect(v).toEqual({ status: "unavailable", reason: "network" });
  });

  it.each([[500], [502], [503], [429]])("reports unavailable on HTTP %s", async (status) => {
    const v = await viesCheck("15789934", { fetch: jsonFetch({}, status) });
    expect(v.status).toBe("unavailable");
  });

  it("reports unavailable on the fault object VIES returns with a 200", async () => {
    // VIES answers some failures with a 200 and an error wrapper, which is how a
    // naive client turns an outage into "not valid".
    const v = await viesCheck("15789934", {
      fetch: jsonFetch({ errorWrappers: [{ error: "MS_MAX_CONCURRENT_REQ" }] }),
    });
    expect(v.status).toBe("unavailable");
    expect(v.status === "unavailable" && v.reason).toBe("service_error");
  });

  it("reports unavailable on a response with no verdict at all", async () => {
    const v = await viesCheck("15789934", { fetch: jsonFetch({ countryCode: "HU" }) });
    expect(v.status === "unavailable" && v.reason).toBe("no_verdict_in_response");
  });

  it("reports unavailable on unparseable JSON", async () => {
    const v = await viesCheck("15789934", {
      fetch: (async () => new Response("<html>oops</html>", { status: 200 })) as unknown as typeof fetch,
    });
    expect(v.status === "unavailable" && v.reason).toBe("unparseable_response");
  });

  it("never returns 'valid' when it could not reach the service", async () => {
    // The failure mode that would matter: an unavailable VIES must not silently
    // become a positive cross-check.
    for (const f of [
      jsonFetch({}, 503),
      jsonFetch({ errorWrappers: [] }, 200),
      jsonFetch({ countryCode: "HU" }),
    ]) {
      const v = await viesCheck("15789934", { fetch: f });
      expect(v.status).not.toBe("valid");
    }
  });

  it("says the NAV answer is independent, so an outage reads as harmless", async () => {
    const v = await viesCheck("15789934", { fetch: jsonFetch({}, 503) });
    expect(viesSummary(v)).toContain("A NAV adata ettől független");
  });
});

describe("refusing before spending a request", () => {
  it("does not call VIES for a bad-checksum number", async () => {
    let called = false;
    const v = await viesCheck("12862208", {
      fetch: (async () => {
        called = true;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(called).toBe(false);
    expect(v.status).toBe("unavailable");
    expect(v.status === "unavailable" && v.reason).toContain("checksum_failed");
  });
});
