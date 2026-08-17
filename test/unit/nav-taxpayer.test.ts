import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildRequest,
  navQueryTaxpayer,
  navRiskFlags,
  parseTaxpayerResponse,
  type NavCredentials,
} from "../../src/modules/registry/nav-taxpayer";

/**
 * The NAV parser, against RESPONSES CAPTURED FROM PRODUCTION.
 *
 * The fixtures in test/fixtures/nav/ are real `queryTaxpayer` replies, recorded
 * on 2026-08-17 with live credentials and scrubbed of the requestId and
 * timestamp. They contain public register data only — no credential appears in
 * any of them.
 *
 * Recording them mattered because my first reading of the XSD was wrong about
 * the most important case. `minOccurs="0"` on `taxpayerValidity` suggested an
 * unknown taxpayer would omit it; production returns `false` instead, and the
 * thing that actually distinguishes "struck off" from "belongs to nobody" is
 * whether `taxpayerData` came with it. A mock built from the schema would have
 * encoded the wrong rule and passed.
 */
const FIXTURES = join(process.cwd(), "test/fixtures/nav");
const fixture = (name: string) => readFileSync(join(FIXTURES, `queryTaxpayer-${name}.xml`), "utf8");

const CREDS: NavCredentials = {
  login: "testlogin123456",
  password: "not-a-real-password",
  signKey: "test-sign-key",
  taxNumber: "32687062",
  environment: "test",
  // Supplied by the caller from the workspace brand, never defaulted in the
  // provider — a white-labelled deployment declares its own identity to NAV.
  softwareId: "TESTSOFTWARE000001",
  softwareName: "Test Software",
  softwareDevName: "Test Operator Kft.",
  softwareDevContact: "ops@example.test",
};

describe("a valid taxpayer (NAV's own record)", () => {
  const r = parseTaxpayerResponse(fixture("valid-organization"), 200);

  it("is reported valid", () => {
    expect(r.status).toBe("valid");
  });

  it("returns the legal name as the authoritative value", () => {
    expect(r.status === "valid" && r.taxpayer.legalName).toBe("NEMZETI ADÓ- ÉS VÁMHIVATAL");
  });

  it("reads the tax number detail", () => {
    expect(r.status === "valid" && r.taxpayer).toMatchObject({
      taxNumber: "15789934",
      vatCode: "2",
      countyCode: "51",
      incorporation: "ORGANIZATION",
    });
  });

  it("takes the registered seat from the HQ item, never a site", () => {
    // This record carries 47 SITE addresses alongside one HQ. Picking the first
    // address item would have produced a branch office as the székhely.
    const seat = r.status === "valid" ? r.taxpayer.seat : null;
    expect(seat).toMatchObject({ postalCode: "1054", city: "BUDAPEST" });
    expect(r.status === "valid" && r.taxpayer.otherAddressCount).toBeGreaterThan(10);
  });

  it("formats the seat in Hungarian address order for document pre-fill", () => {
    const seat = r.status === "valid" ? r.taxpayer.seat : null;
    expect(seat!.oneLine).toContain("1054 BUDAPEST");
    // Street name then type then number — "SZÉCHENYI UTCA 2", not "UTCA SZÉCHENYI".
    expect(seat!.oneLine).toMatch(/SZÉCHENYI\s+UTCA/);
  });

  it("carries no risk flag", () => {
    expect(navRiskFlags(r)).toEqual([]);
  });
});

describe("a deregistered taxpayer", () => {
  const r = parseTaxpayerResponse(fixture("deregistered"), 200);

  it("is distinguished from unknown, because data came back with the false", () => {
    expect(r.status).toBe("deregistered");
    expect(r.status === "deregistered" && r.taxpayer.legalName).toContain("BRO-KOMPLEX");
  });

  it("keeps the historic seat, which is what makes it identifiable", () => {
    expect(r.status === "deregistered" && r.taxpayer.seat?.city).toBe("VÁL");
  });

  it("reports the infoDate, which is how old the record is", () => {
    expect(r.status === "deregistered" && r.infoDate).toContain("2002");
  });

  it("raises the risk flag that blocks finalising a legal document", () => {
    // A deregistered counterparty is the strongest possible reason not to issue
    // a contract, so it joins the existing liquidation/risk chip path.
    expect(navRiskFlags(r)).toEqual(["nav_deregistered"]);
  });
});

describe("an unknown tax number", () => {
  const r = parseTaxpayerResponse(fixture("unknown"), 200);

  it("is unknown, not an error — NAV answers this with HTTP 200", () => {
    expect(r.status).toBe("unknown");
  });

  it("carries no company data to accidentally accept", () => {
    expect("taxpayer" in r).toBe(false);
  });

  it("is not confused with deregistered", () => {
    // Both return taxpayerValidity=false. Only the presence of taxpayerData
    // separates them, and they mean different things to a salesperson.
    expect(parseTaxpayerResponse(fixture("deregistered"), 200).status).toBe("deregistered");
  });
});

describe("a VAT group member (MOL)", () => {
  const r = parseTaxpayerResponse(fixture("vat-group-member"), 200);

  it("is a valid taxpayer, whatever VIES says about the number", () => {
    // VIES reports this number invalid, because a group MEMBER's number is not
    // a valid EU VAT identifier — the group's common number is. NAV is the
    // authority on whether the taxpayer exists, and it does.
    expect(r.status).toBe("valid");
    expect(r.status === "valid" && r.taxpayer.legalName).toContain("MOL");
  });

  it("surfaces the group membership rather than hiding it", () => {
    expect(r.status === "valid" && r.taxpayer.vatCode).toBe("4");
    expect(r.status === "valid" && r.taxpayer.vatGroupMembership).toBeTruthy();
  });

  it("flags it, because it changes how the company is invoiced", () => {
    expect(navRiskFlags(r)).toEqual(["vat_group_member"]);
  });
});

describe("the error taxonomy", () => {
  const errorBody = (code: string) =>
    `<?xml version="1.0"?><GeneralErrorResponse xmlns="http://schemas.nav.gov.hu/NTCA/1.0/common">
       <result><funcCode>ERROR</funcCode><errorCode>${code}</errorCode>
       <message>NAV message</message></result></GeneralErrorResponse>`;

  it.each([
    ["INVALID_REQUEST_SIGNATURE", 400, "invalid_signature"],
    ["INVALID_SECURITY_USER", 401, "invalid_credentials"],
    ["INVALID_USER_RELATION", 500, "user_not_related"],
    ["NOT_REGISTERED_CUSTOMER", 500, "not_registered_in_osa"],
    ["FORBIDDEN", 500, "forbidden"],
    ["REQUEST_ID_NOT_UNIQUE", 400, "request_id_not_unique"],
    ["INVALID_TIMESTAMP", 400, "invalid_timestamp"],
    ["REQUEST_VERSION_NOT_ALLOWED", 400, "version_not_allowed"],
    ["MAINTENANCE_MODE", 527, "maintenance"],
    ["INVALID_REQUEST", 400, "malformed_request"],
  ])("maps %s to %s", (code, http, kind) => {
    const r = parseTaxpayerResponse(errorBody(code), http);
    expect(r.status).toBe("error");
    expect(r.status === "error" && r.error).toBe(kind);
    expect(r.status === "error" && r.message.length).toBeGreaterThan(10);
  });

  it("never reports maintenance as a data conclusion", () => {
    // The dangerous confusion: "NAV is down" and "this company does not exist"
    // both look like absence to a caller that only checks for a taxpayer.
    const r = parseTaxpayerResponse(errorBody("MAINTENANCE_MODE"), 527);
    expect(r.status).not.toBe("unknown");
    expect(r.status === "error" && r.message).toContain("karbantartás");
  });

  it("maps an unmapped 429 to rate limiting rather than 'unexpected'", () => {
    // Not in NAV's published chart, but rate limiting exists — and an
    // unexplained "unexpected" sends someone hunting a bug that is a queue.
    const r = parseTaxpayerResponse("<html>Too many requests</html>", 429);
    expect(r.status === "error" && r.error).toBe("rate_limited");
  });

  it("falls back to 'unexpected' with the HTTP status, never silently", () => {
    const r = parseTaxpayerResponse(errorBody("SOME_NEW_CODE_2027"), 400);
    expect(r.status === "error" && r.error).toBe("unexpected");
    expect(r.status === "error" && r.code).toBe("SOME_NEW_CODE_2027");
  });
});

describe("refusing before spending a request", () => {
  it("refuses when the integration is not configured", async () => {
    const r = await navQueryTaxpayer("15789934", null);
    expect(r.status === "error" && r.error).toBe("not_configured");
  });

  it("refuses a bad-checksum number without calling NAV at all", async () => {
    let called = false;
    const r = await navQueryTaxpayer("12862208", CREDS, {
      fetch: (async () => {
        called = true;
        return new Response("", { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(called).toBe(false);
    expect(r.status === "error" && r.error).toBe("invalid_tax_number");
    expect(r.status === "error" && r.code).toBe("checksum_failed");
  });

  it("reports a timeout distinctly from a network failure", async () => {
    const timeout = await navQueryTaxpayer("15789934", CREDS, {
      fetch: (async () => {
        throw Object.assign(new Error("t"), { name: "TimeoutError" });
      }) as unknown as typeof fetch,
    });
    expect(timeout.status === "error" && timeout.error).toBe("timeout");

    const network = await navQueryTaxpayer("15789934", CREDS, {
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    expect(network.status === "error" && network.error).toBe("network");
  });
});

describe("the request it builds", () => {
  const xml = buildRequest({
    creds: CREDS,
    requestId: "VOSTEST123",
    at: new Date("2026-08-17T12:00:00.000Z"),
    queried: "15789934",
  });

  it("declares the two different hash algorithms correctly", () => {
    // The detail that would otherwise fail every request with no useful signal.
    expect(xml).toContain('cryptoType="SHA-512"');
    expect(xml).toContain('cryptoType="SHA3-512"');
  });

  it("carries the mandatory software block the brief omitted", () => {
    for (const tag of [
      "softwareId", "softwareName", "softwareOperation", "softwareMainVersion",
      "softwareDevName", "softwareDevContact", "softwareDevCountryCode",
      "softwareDevTaxNumber",
    ]) {
      expect(xml, tag).toContain(`<${tag}>`);
    }
    // SoftwareIdType is exactly 18 characters.
    expect(CREDS.softwareId).toHaveLength(18);
  });

  it("separates the requesting taxpayer from the queried one", () => {
    // Both are 8-digit tax numbers in the same document; swapping them queries
    // yourself and looks like it worked.
    expect(xml).toContain("<common:taxNumber>32687062</common:taxNumber>");
    expect(xml).toContain("<taxNumber>15789934</taxNumber>");
  });

  it("never contains the plaintext password", () => {
    expect(xml).not.toContain(CREDS.password);
  });

  it("uses the documented version values", () => {
    expect(xml).toContain("<common:requestVersion>3.0</common:requestVersion>");
    expect(xml).toContain("<common:headerVersion>1.0</common:headerVersion>");
  });
});
