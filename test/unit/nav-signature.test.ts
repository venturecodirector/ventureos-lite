import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  NAV_BASE_URL,
  navInvoiceRequestSignature,
  navPasswordHash,
  navRequestId,
  navRequestSignature,
  navTimestamp,
  navTimestampMask,
} from "../../src/modules/registry/nav-signature";

/**
 * NAV request authentication, against the specification's own worked example.
 *
 * This is the rare integration where the vendor publishes a known-answer vector,
 * and it is worth using rather than testing our implementation against our own
 * reading of the prose. The example in §1.5.1 of the 2026.02.12 interface
 * specification gives four intermediate values and a final signature; all five
 * are asserted below.
 *
 * It also settles a disagreement. The brief for this work specified SHA-512 for
 * requestSignature. The spec says SHA3-512 is the only accepted value, and these
 * assertions are what makes that concrete: the same inputs under SHA-512 do not
 * produce NAV's published answer.
 */

/** Spec §1.5.1, verbatim. */
const VECTOR = {
  requestId: "TSTKFT1222564",
  timestamp: new Date("2017-12-30T18:25:45.000Z"),
  signKey: "ce-8f5e-215119fa7dd621DLMRHRLH2S",
  partialBase: "TSTKFT122256420171230182545ce-8f5e-215119fa7dd621DLMRHRLH2S",
  index1: {
    operation: "CREATE",
    base64Data: "QWJjZDEyMzQ=",
    hash:
      "4317798460962869BC67F07C48EA7E4A3AFA301513CEB87B8EB94ECF92BC220A" +
      "89C480F87F0860E85E29A3B6C0463D4F29712C5AD48104A6486CE839DC2F24CB",
  },
  index2: {
    operation: "MODIFY",
    base64Data: "RGNiYTQzMjE=",
    hash:
      "A881218238933F6FFB9E167445CB4DAA9749BCF484FDE48AB7649FD25E8B634A" +
      "4736A65A7C4A8E2831119F739837E006566F97370415AAD55E268605206F2A6C",
  },
  finalSignature:
    "60BC80609EE3B8F42FE904200A49A1921A1DADA08D55319ACD40C59F626514B7" +
    "4EEA49011D372600A10DBCF8199D590DA9C2841D987308F2D83DAE17C2470C42",
};

describe("the timestamp mask the signature is built from", () => {
  it("strips separators and the zone, keeping UTC", () => {
    expect(navTimestampMask(VECTOR.timestamp)).toBe("20171230182545");
  });

  it("produces the base string the spec publishes", () => {
    const base = `${VECTOR.requestId}${navTimestampMask(VECTOR.timestamp)}${VECTOR.signKey}`;
    expect(base).toBe(VECTOR.partialBase);
  });

  it("emits the wire format with milliseconds and a trailing Z", () => {
    expect(navTimestamp(VECTOR.timestamp)).toBe("2017-12-30T18:25:45.000Z");
    // The pattern the XSD enforces.
    expect(navTimestamp(new Date())).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

describe("requestSignature against NAV's published vector", () => {
  it("reproduces both per-index hashes the spec publishes", () => {
    // Asserted directly rather than inferred from the final signature: if one of
    // the two were wrong and the other compensating, only the end value would
    // match and the bug would surface on a real invoice instead of here.
    const indexHash = (operation: string, base64Data: string) =>
      createHash("sha3-512").update(`${operation}${base64Data}`, "utf8").digest("hex").toUpperCase();

    expect(indexHash(VECTOR.index1.operation, VECTOR.index1.base64Data)).toBe(VECTOR.index1.hash);
    expect(indexHash(VECTOR.index2.operation, VECTOR.index2.base64Data)).toBe(VECTOR.index2.hash);
  });

  it("reproduces the full manageInvoice signature exactly", () => {
    // The decisive assertion. Four inputs, one published answer, no tolerance.
    const sig = navInvoiceRequestSignature({
      requestId: VECTOR.requestId,
      timestamp: VECTOR.timestamp,
      signKey: VECTOR.signKey,
      indices: [VECTOR.index1, VECTOR.index2],
    });
    expect(sig).toBe(VECTOR.finalSignature);
  });

  it("computes the queryTaxpayer-shaped signature from the same partial base", () => {
    // No invoice indices, so the signature is the hash of the partial base
    // alone (spec §1.5.2) — which is the form every taxpayer lookup uses.
    const sig = navRequestSignature({
      requestId: VECTOR.requestId,
      timestamp: VECTOR.timestamp,
      signKey: VECTOR.signKey,
    });
    expect(sig).toBe(
      "0493F2F0247A2DF076775631FFDFA8B6D39D051F4928D26426CD29895EEDB249" +
        "60A23E4C6443A54806EA8B0E126A7B97940169FEADE6EE42FC99E3BE6F74AB04",
    );
  });

  it("is SHA3-512, not SHA-512 — the two are not interchangeable", () => {
    const sig = navRequestSignature({
      requestId: VECTOR.requestId,
      timestamp: VECTOR.timestamp,
      signKey: VECTOR.signKey,
    });
    // Same length, entirely different value. A SHA-512 implementation would
    // pass a length check and fail every real request.
    const sha512OfSameBase = navPasswordHash(VECTOR.partialBase);
    expect(sha512OfSameBase).toHaveLength(128);
    expect(sig).not.toBe(sha512OfSameBase);
  });

  it("returns uppercase hex of the documented length", () => {
    const sig = navRequestSignature({ ...VECTOR });
    expect(sig).toMatch(/^[0-9A-F]{128}$/);
  });
});

describe("passwordHash", () => {
  it("is SHA-512 in capitals", () => {
    // Independently checkable: SHA-512("password").
    expect(navPasswordHash("password")).toBe(
      "B109F3BBBC244EB82441917ED06D618B9008DD09B3BEFD1B5E07394C706A8BB9" +
        "80B1D7785E5976EC049B46DF5F1326AF5A2EA6D103FD07C95385FFAB0CACBC86",
    );
  });

  it("is not the same function as the signature", () => {
    expect(navPasswordHash("x")).not.toBe(
      navRequestSignature({ requestId: "x", timestamp: new Date(0), signKey: "" }),
    );
  });
});

describe("requestId", () => {
  it("matches the pattern the XSD enforces", () => {
    for (let i = 0; i < 50; i += 1) {
      expect(navRequestId()).toMatch(/^[+a-zA-Z0-9_]{1,30}$/);
    }
  });

  it("is unique across calls, because a retry may not reuse one", () => {
    // Uniqueness is enforced by NAV across REJECTED requests too, so a retry
    // after a signature failure must mint a new id rather than resend.
    const ids = new Set(Array.from({ length: 500 }, () => navRequestId()));
    expect(ids.size).toBe(500);
  });
});

describe("endpoints", () => {
  it("points at the documented v3 hosts", () => {
    expect(NAV_BASE_URL.test).toBe("https://api-test.onlineszamla.nav.gov.hu/invoiceService/v3");
    expect(NAV_BASE_URL.production).toBe("https://api.onlineszamla.nav.gov.hu/invoiceService/v3");
  });

  it("keeps test and production distinct, since credentials are not shared", () => {
    expect(NAV_BASE_URL.test).not.toBe(NAV_BASE_URL.production);
  });
});
