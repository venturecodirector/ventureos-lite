/**
 * Variable catalog for {{...}} autocompletion, and sample data for the live
 * preview (spec §4.10).
 */
export interface CatalogVar {
  key: string;
  label: string;
}

export const VARIABLE_CATALOG: CatalogVar[] = [
  { key: "workspace.legal_name", label: "Workspace legal name" },
  { key: "workspace.address", label: "Workspace address" },
  { key: "workspace.tax_id", label: "Workspace tax id" },
  { key: "client.name", label: "Client contact name" },
  { key: "client.company", label: "Client company" },
  { key: "client.tax_id", label: "Client adószám" },
  { key: "client.address", label: "Client address" },
  { key: "quote.number", label: "Quote number" },
  { key: "quote.date", label: "Quote date" },
  { key: "quote.valid_until", label: "Quote validity date" },
  { key: "quote.total_net", label: "Total net" },
  { key: "quote.vat", label: "VAT" },
  { key: "quote.total_gross", label: "Total gross" },
  { key: "items_table", label: "Line-items table (HTML)" },
  { key: "contract.scope", label: "Contract scope" },
  { key: "contract.milestones", label: "Milestones" },
  { key: "contract.payment_terms", label: "Payment terms" },
  { key: "certificate.date", label: "Completion date" },
  { key: "certificate.deliverables", label: "Deliverables" },
  { key: "document.link", label: "Public document link" },
];

const CATALOG_KEYS = new Set(VARIABLE_CATALOG.map((v) => v.key));

export function isKnownVariable(path: string): boolean {
  return CATALOG_KEYS.has(path);
}

export const SAMPLE_DATA: Record<string, unknown> = {
  workspace: {
    legal_name: "Venture CO Group Kft.",
    address: "1052 Budapest, Váci utca 1.",
    tax_id: "26841512-2-41",
  },
  client: {
    name: "Horváth Judit",
    company: "Aventa Logistics Kft.",
    tax_id: "12345678-1-42",
    address: "1097 Budapest, Gyáli út 12.",
  },
  quote: {
    number: "Q-2026-014",
    date: "2026. 08. 11.",
    valid_until: "2026. 09. 10.",
    total_net: "2 313 000 Ft",
    vat: "27%",
    total_gross: "2 937 510 Ft",
  },
  contract: {
    scope: "Weboldal fejlesztés (10 oldal, HU/EN), SEO technikai beállítás.",
    milestones: "Terv (2 hét) · Fejlesztés (6 hét) · Élesítés (1 hét)",
    payment_terms: "40% előleg, 60% átadáskor.",
  },
  certificate: {
    date: "2026. 10. 15.",
    deliverables: "10 oldalas weboldal, SEO beállítás, betanítás.",
  },
  // Overwritten per-render with the real quote origin (see sampleData()).
  document: { link: "" },
  items_table:
    "<table style='width:100%;border-collapse:collapse'>" +
    "<tr><td>Weboldal fejlesztés</td><td style='text-align:right'>1 820 000 Ft</td></tr>" +
    "<tr><td>SEO technikai beállítás</td><td style='text-align:right'>286 000 Ft</td></tr>" +
    "<tr><td>Hosting &amp; fotó</td><td style='text-align:right'>207 000 Ft</td></tr>" +
    "</table>",
};

/**
 * Preview sample data. The document link is passed in by the server so the
 * preview shows the real public quote origin (PUBLIC_QUOTE_URL) — this module
 * is imported by a client component and must never resolve a host itself.
 */
export function sampleData(documentLink: string): Record<string, unknown> {
  return { ...SAMPLE_DATA, document: { link: documentLink } };
}
