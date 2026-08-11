import type { TemplateType, Lang } from "@prisma/client";

/**
 * Base template set (spec §4.10). Hungarian + English variants for quote,
 * contract, certificate and email — each with the legal-review footer built in.
 * The DRAFT watermark is applied by the render pipeline while a document is
 * unfinalized (CLAUDE.md hard rule #4), not baked into the body.
 */
export interface BaseTemplate {
  type: TemplateType;
  lang: Lang;
  name: string;
  body: string;
}

const FOOTER_HU =
  "Ez a dokumentum tervezet — véglegesítés előtt jogi átnézés javasolt.";
const FOOTER_EN =
  "This document is a draft — legal review is recommended before finalization.";

export const BASE_TEMPLATES: BaseTemplate[] = [
  {
    type: "QUOTE",
    lang: "HU",
    name: "Árajánlat",
    body: `<h1>Árajánlat</h1>
<p><b>{{workspace.legal_name}}</b> · Adószám: {{workspace.tax_id}}<br>{{workspace.address}}</p>
<p>Ügyfél: <b>{{client.company}}</b> ({{client.name}})<br>Adószám: {{client.tax_id}}</p>
<p>Ajánlat száma: {{quote.number}} · Kelt: {{quote.date}} · Érvényes: {{quote.valid_until}}</p>
{{items_table}}
<p>Összesen (nettó): <b>{{quote.total_net}}</b><br>ÁFA ({{quote.vat}}) · Bruttó: <b>{{quote.total_gross}}</b></p>
<hr><p><small>${FOOTER_HU}</small></p>`,
  },
  {
    type: "QUOTE",
    lang: "EN",
    name: "Quote",
    body: `<h1>Quote</h1>
<p><b>{{workspace.legal_name}}</b> · Tax ID: {{workspace.tax_id}}<br>{{workspace.address}}</p>
<p>Client: <b>{{client.company}}</b> ({{client.name}})<br>Tax ID: {{client.tax_id}}</p>
<p>Quote no.: {{quote.number}} · Date: {{quote.date}} · Valid until: {{quote.valid_until}}</p>
{{items_table}}
<p>Total (net): <b>{{quote.total_net}}</b><br>VAT ({{quote.vat}}) · Gross: <b>{{quote.total_gross}}</b></p>
<hr><p><small>${FOOTER_EN}</small></p>`,
  },
  {
    type: "CONTRACT",
    lang: "HU",
    name: "Vállalkozási szerződés",
    body: `<h1>Vállalkozási szerződés</h1>
<p>Megbízó: <b>{{client.company}}</b> ({{client.name}}) · Adószám: {{client.tax_id}}<br>{{client.address}}</p>
<p>Vállalkozó: <b>{{workspace.legal_name}}</b> · Adószám: {{workspace.tax_id}}</p>
<h2>1. A szerződés tárgya</h2><p>{{contract.scope}}</p>
<h2>2. Mérföldkövek</h2><p>{{contract.milestones}}</p>
<h2>3. Fizetési feltételek</h2><p>{{contract.payment_terms}}</p>
<hr><p><small>${FOOTER_HU}</small></p>`,
  },
  {
    type: "CONTRACT",
    lang: "EN",
    name: "Service agreement",
    body: `<h1>Service agreement</h1>
<p>Client: <b>{{client.company}}</b> ({{client.name}}) · Tax ID: {{client.tax_id}}<br>{{client.address}}</p>
<p>Contractor: <b>{{workspace.legal_name}}</b> · Tax ID: {{workspace.tax_id}}</p>
<h2>1. Scope</h2><p>{{contract.scope}}</p>
<h2>2. Milestones</h2><p>{{contract.milestones}}</p>
<h2>3. Payment terms</h2><p>{{contract.payment_terms}}</p>
<hr><p><small>${FOOTER_EN}</small></p>`,
  },
  {
    type: "CERTIFICATE",
    lang: "HU",
    name: "Teljesítésigazolás",
    body: `<h1>Teljesítésigazolás</h1>
<p>Megbízó: <b>{{client.company}}</b> ({{client.name}})</p>
<p>Vállalkozó: <b>{{workspace.legal_name}}</b></p>
<p>Teljesítés dátuma: {{certificate.date}}</p>
<h2>Átadott teljesítés</h2><p>{{certificate.deliverables}}</p>
<p>A Megbízó a fenti teljesítést elfogadja.</p>
<hr><p><small>${FOOTER_HU}</small></p>`,
  },
  {
    type: "CERTIFICATE",
    lang: "EN",
    name: "Completion certificate",
    body: `<h1>Completion certificate</h1>
<p>Client: <b>{{client.company}}</b> ({{client.name}})</p>
<p>Contractor: <b>{{workspace.legal_name}}</b></p>
<p>Completion date: {{certificate.date}}</p>
<h2>Delivered</h2><p>{{certificate.deliverables}}</p>
<p>The Client accepts the deliverables above.</p>
<hr><p><small>${FOOTER_EN}</small></p>`,
  },
  {
    type: "EMAIL",
    lang: "HU",
    name: "Árajánlat e-mail",
    body: `Tárgy: Árajánlat – {{quote.number}}

Kedves {{client.name}}!

Mellékelten küldjük árajánlatunkat ({{quote.number}}), amely {{quote.valid_until}}-ig érvényes. Az online változat itt érhető el: {{document.link}}

Üdvözlettel,
{{workspace.legal_name}}

—
${FOOTER_HU}`,
  },
  {
    type: "EMAIL",
    lang: "EN",
    name: "Quote email",
    body: `Subject: Quote – {{quote.number}}

Dear {{client.name}},

Please find our quote ({{quote.number}}) attached, valid until {{quote.valid_until}}. The online version is available here: {{document.link}}

Kind regards,
{{workspace.legal_name}}

—
${FOOTER_EN}`,
  },
];
