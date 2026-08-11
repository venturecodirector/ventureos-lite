import { parseSzamlaResponse, type SzamlaResult } from "./logic";

/**
 * Számla Agent transport (spec §4.23). Real implementation posts multipart XML
 * to szamlazz.hu; a mock is used in dev/test. Endpoint + field names verified
 * against docs.szamlazz.hu (Aug 2026):
 *   - create: POST https://www.szamlazz.hu/szamla/, field `action-xmlagentxmlfile`.
 *   - query (payment status): field `action-szamla_agent_xml`, root <xmlszamlaxml>.
 *     ASSUMPTION: the response XML carries <kifizetve>true|false</kifizetve>; the
 *     exact query-XML fields aren't re-verified here (docs behind a portal).
 */
const ENDPOINT = "https://www.szamlazz.hu/szamla/";

export interface CreateInvoiceResult {
  result: SzamlaResult;
  pdf: Buffer | null;
  raw: string;
}

export interface SzamlaProvider {
  readonly name: string;
  createInvoice(agentKey: string, xml: string): Promise<CreateInvoiceResult>;
  queryPaid(agentKey: string, invoiceNumber: string): Promise<{ paid: boolean | null; raw: string }>;
}

function headersToRecord(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => (out[k.toLowerCase()] = v));
  return out;
}

class SzamlazzProvider implements SzamlaProvider {
  readonly name = "szamlazz";

  async createInvoice(agentKey: string, xml: string): Promise<CreateInvoiceResult> {
    const form = new FormData();
    form.append(
      "action-xmlagentxmlfile",
      new Blob([xml], { type: "text/xml" }),
      "invoice.xml",
    );
    const res = await fetch(ENDPOINT, { method: "POST", body: form });
    const headers = headersToRecord(res.headers);
    const result = parseSzamlaResponse(headers);

    // On success with szamlaLetoltes=true the body is the PDF; on error it's XML.
    if (result.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      const raw = `HTTP ${res.status}; szlahu_szamlaszam=${headers.szlahu_szamlaszam ?? ""}`;
      // Heuristic: a PDF starts with %PDF; otherwise treat body as text.
      const isPdf = buf.subarray(0, 4).toString("latin1") === "%PDF";
      return { result, pdf: isPdf ? buf : null, raw };
    }
    const text = await res.text();
    return { result, pdf: null, raw: `HTTP ${res.status}\n${text}` };
  }

  async queryPaid(agentKey: string, invoiceNumber: string): Promise<{ paid: boolean | null; raw: string }> {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<xmlszamlaxml xmlns="http://www.szamlazz.hu/xmlszamlaxml">
  <szamlaagentkulcs>${agentKey}</szamlaagentkulcs>
  <szamlaszam>${invoiceNumber}</szamlaszam>
</xmlszamlaxml>`;
    const form = new FormData();
    form.append("action-szamla_agent_xml", new Blob([xml], { type: "text/xml" }), "query.xml");
    const res = await fetch(ENDPOINT, { method: "POST", body: form });
    const raw = await res.text();
    const m = raw.match(/<kifizetve>\s*(true|false)\s*<\/kifizetve>/i);
    return { paid: m ? m[1].toLowerCase() === "true" : null, raw };
  }
}

class MockSzamlaProvider implements SzamlaProvider {
  readonly name = "mock";
  async createInvoice(_agentKey: string, xml: string): Promise<CreateInvoiceResult> {
    // eslint-disable-next-line no-console
    console.log(`[szamla:mock] create invoice (${xml.length} bytes XML)`);
    const num = `MOCK-${new Date().getUTCFullYear()}-${Math.abs(hash(xml)) % 100000}`;
    return { result: { ok: true, invoiceNumber: num }, pdf: Buffer.from(`%PDF-1.4 mock ${num}`), raw: `mock szlahu_szamlaszam=${num}` };
  }
  async queryPaid(): Promise<{ paid: boolean | null; raw: string }> {
    return { paid: false, raw: "<xmlszamlavalasz><kifizetve>false</kifizetve></xmlszamlavalasz>" };
  }
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

let provider: SzamlaProvider | null = null;
export function getSzamlaProvider(): SzamlaProvider {
  if (!provider) {
    const which = (process.env.SZAMLAZZ_PROVIDER ?? "").toLowerCase();
    provider = which === "szamlazz" ? new SzamlazzProvider() : new MockSzamlaProvider();
  }
  return provider;
}

export function __setSzamlaProvider(p: SzamlaProvider | null) {
  provider = p;
}
