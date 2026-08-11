import type { MeetingBrief } from "../../lib/ai/prompts/meeting-brief";

/**
 * Branded one-page meeting-brief PDF (spec §4.8), rendered through the shared
 * headless-Chrome pipeline. No AI in this render path — it consumes the
 * already-generated structured brief only.
 */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface BriefPdfMeta {
  companyName: string;
  contactName: string;
  whenLabel: string;
}

export function buildBriefPdfHtml(meta: BriefPdfMeta, b: MeetingBrief): string {
  const findings = b.auditFindings.length
    ? `<ul>${b.auditFindings.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>`
    : `<p class="muted">No website audit on file.</p>`;
  const questions = b.discoveryQuestions
    .map((q) => `<li>${esc(q)}</li>`)
    .join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><style>
  @page { size: A4; margin: 0; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; background: #00051D; color: #EFF1F8; padding: 44px 42px; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .brand { font-size: 22px; letter-spacing: -0.02em; margin-bottom: 4px; }
  .brand b { font-weight: 800; } .brand span { font-weight: 300; color: #858CAE; margin-left: 6px; }
  .kicker { font-size: 10px; letter-spacing: 0.16em; text-transform: uppercase; color: #858CAE; margin-bottom: 18px; }
  h1 { font-size: 19px; font-weight: 800; }
  .meta { font-size: 12px; color: #858CAE; margin: 2px 0 18px; }
  h2 { font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: #7427C6; margin: 16px 0 5px; }
  p, li { font-size: 12.5px; line-height: 1.6; color: #C9CEE3; }
  ul { padding-left: 18px; } li { margin: 2px 0; }
  ol { padding-left: 18px; } ol li { margin: 5px 0; color: #EFF1F8; }
  .muted { color: #858CAE; }
</style></head>
<body>
  <div class="brand"><b>venture</b><span>co.group</span></div>
  <div class="kicker">Meeting brief</div>
  <h1>${esc(meta.companyName)}</h1>
  <div class="meta">${esc(meta.contactName || "Contact unknown")} · ${esc(meta.whenLabel)}</div>

  <h2>Company profile</h2><p>${esc(b.companyProfile)}</p>
  <h2>Person</h2><p>${esc(b.personBackground)}</p>
  <h2>Audit findings</h2>${findings}
  <h2>Hypothesised pain</h2><p>${esc(b.hypothesizedPain)}</p>
  <h2>Conversation so far</h2><p>${esc(b.conversationSummary)}</p>
  <h2>Discovery questions</h2><ol>${questions}</ol>
</body></html>`;
}
