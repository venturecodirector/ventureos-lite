import { describe, it, expect } from "vitest";
import {
  composeInvoicePayload,
  buildBuyer,
  confirmationHash,
  assertConfirmed,
  ConfirmationError,
  buildInvoiceXml,
  parseSzamlaResponse,
  invoiceFailureActivity,
  type InvoicePayload,
} from "../../src/modules/invoicing/logic";
import type { QuoteItem } from "../../src/modules/documents/quote-math";

const ITEMS: QuoteItem[] = [
  { description: "Weboldal fejlesztés", baseNet: 1_000_000, preset: "none" },
  { description: "Hosting & fotó", baseNet: 200_000, preset: "passthrough" }, // +15% → 230 000
];

const HEADER = {
  issueDate: "2026-08-12",
  fulfillmentDate: "2026-08-12",
  dueDate: "2026-08-26",
  paymentMethod: "Átutalás",
  currency: "HUF",
  language: "hu",
};

function payload(): InvoicePayload {
  const buyer = buildBuyer(
    { legalName: "Fortuna Étterem Kft.", taxId: "12345678-1-42" },
    { name: "Fortuna Étterem Group", address: "1051 Budapest, Fő utca 1.", city: "Budapest", email: "info@fortuna.hu" },
  );
  return composeInvoicePayload({ items: ITEMS, vatRatePct: 27, buyer, header: HEADER });
}

describe("payload composition from the quote/contract chain (spec §4.23)", () => {
  it("computes per-line integer HUF math with VAT, satisfying Számla invariants", () => {
    const p = payload();
    expect(p.lines).toHaveLength(2);

    const [l1, l2] = p.lines;
    expect(l1.netValue).toBe(1_000_000);
    expect(l1.vatValue).toBe(270_000);
    expect(l1.grossValue).toBe(1_270_000);
    // preset applied from the quote chain: 200 000 +15% = 230 000
    expect(l2.netValue).toBe(230_000);
    expect(l2.vatValue).toBe(62_100);
    expect(l2.grossValue).toBe(292_100);

    for (const l of p.lines) {
      expect(l.netUnitPrice * l.quantity).toBe(l.netValue); // qty·unit = net
      expect(l.netValue + l.vatValue).toBe(l.grossValue); // net + vat = gross
      expect(Number.isInteger(l.netValue) && Number.isInteger(l.vatValue) && Number.isInteger(l.grossValue)).toBe(true);
    }
  });

  it("totals are the sum of the lines", () => {
    const p = payload();
    expect(p.totals).toEqual({ net: 1_230_000, vat: 332_100, gross: 1_562_100 });
  });

  it("partner data comes from registry enrichment, falling back to the company", () => {
    const p = payload();
    expect(p.buyer.name).toBe("Fortuna Étterem Kft."); // registry legal name wins
    expect(p.buyer.taxId).toBe("12345678-1-42"); // registry tax id
    expect(p.buyer.city).toBe("Budapest");
    expect(p.buyer.postalCode).toBe("1051"); // parsed from address
    // no registry legal name → fall back to company name
    const b2 = buildBuyer(null, { name: "Csak Cég Bt.", address: "Fő tér 2.", city: null, email: null });
    expect(b2.name).toBe("Csak Cég Bt.");
  });
});

describe("confirm-gate — nothing submits without confirming the exact payload", () => {
  it("hashes the exact payload; the same payload hashes stably", () => {
    const h1 = confirmationHash(payload());
    const h2 = confirmationHash(payload());
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[a-f0-9]{64}$/);
  });

  it("a changed payload produces a different hash", () => {
    const base = payload();
    const changed = { ...base, totals: { ...base.totals, gross: base.totals.gross + 1 } };
    expect(confirmationHash(changed)).not.toBe(confirmationHash(base));
  });

  it("assertConfirmed throws unless the provided hash matches the fresh payload", () => {
    const p = payload();
    expect(() => assertConfirmed(p, "deadbeef")).toThrow(ConfirmationError);
    expect(() => assertConfirmed(p, confirmationHash(p))).not.toThrow();
  });
});

describe("XML build (Számla Agent xmlszamla, fixed element order)", () => {
  it("includes the agent key and orders sections beallitasok→fejlec→elado→vevo→tetelek", () => {
    const xml = buildInvoiceXml(payload(), "AGENT-KEY-123");
    expect(xml).toContain("<szamlaagentkulcs>AGENT-KEY-123</szamlaagentkulcs>");
    expect(xml).toContain("<penznem>HUF</penznem>");
    expect(xml).toContain("<nev>Fortuna Étterem Kft.</nev>");
    expect(xml).toContain("<afakulcs>27</afakulcs>");
    const order = ["<beallitasok>", "<fejlec>", "<elado>", "<vevo>", "<tetelek>"].map((t) => xml.indexOf(t));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((i) => i >= 0)).toBe(true);
  });

  it("escapes XML-special characters in text", () => {
    const b = buildBuyer(null, { name: "A & B <Kft>", address: "x", city: "y", email: null });
    const xml = buildInvoiceXml(composeInvoicePayload({ items: ITEMS, vatRatePct: 27, buyer: b, header: HEADER }), "K");
    expect(xml).toContain("A &amp; B &lt;Kft&gt;");
  });
});

describe("Számla Agent response parsing", () => {
  it("reads the invoice number from success headers", () => {
    const r = parseSzamlaResponse({ szlahu_szamlaszam: "E-2026-42", szlahu_bruttovegosszeg: "1562100" });
    expect(r).toEqual({ ok: true, invoiceNumber: "E-2026-42" });
  });
  it("reads error code + message from failure headers", () => {
    const r = parseSzamlaResponse({ szlahu_error_code: "3", szlahu_error: "Hibas%20adoszam" });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("3");
    expect(r.error).toContain("Hibas"); // URL-decoded
  });
});

describe("failure-to-Today-Queue mapping", () => {
  it("builds an invoice_failed activity carrying the raw response", () => {
    const a = invoiceFailureActivity({ documentId: "d1", leadId: "L1", kind: "rejected", code: "3", error: "bad tax id", raw: "<xmlszamlavalasz>…</xmlszamlavalasz>" });
    expect(a.type).toBe("invoice_failed");
    expect(a.leadId).toBe("L1");
    expect(a.payload).toMatchObject({ documentId: "d1", kind: "rejected", code: "3", raw: expect.stringContaining("xmlszamlavalasz") });
  });
});
