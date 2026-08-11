import type { AuditView } from "./types";

/**
 * Branded audit one-pager (spec §4.4). A self-contained HTML doc — no external
 * assets — printed to PDF by the headless-Chrome pipeline. Venture letterhead
 * from the design tokens (docs/prototype.html). Also drives the public share
 * page's report body.
 */

const VERDICT_LABEL: Record<string, string> = {
  STRONG: "Strong prospect",
  POSSIBLE: "Possible",
  SKIP: "Skip",
};

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export interface AuditDocOptions {
  brandName?: string;
  generatedAt?: Date;
}

/** Shared report body (used by both the PDF and the public share page). */
export function auditReportBody(view: AuditView): string {
  const flags = view.flags
    .map(
      (f) =>
        `<span class="tag">${esc(f)}</span>`,
    )
    .join("");

  const checks = view.checks
    .map(
      (c) => `
      <div class="check">
        <span class="ic ${c.pass ? "p" : "f"}">${c.pass ? "&#10003;" : "&#10007;"}</span>
        <span>${esc(c.label)}${c.detail ? ` <span class="muted">· ${esc(c.detail)}</span>` : ""}</span>
      </div>`,
    )
    .join("");

  const pitch = view.pitchSummary
    ? `<div class="pitch"><div class="eyebrow">Pitch angle</div><p>${esc(view.pitchSummary)}</p></div>`
    : "";

  return `
    <div class="hero">
      <div class="score">${view.score}</div>
      <div>
        <div class="verdict">${VERDICT_LABEL[view.verdict] ?? "Skip"}</div>
        <div class="muted url">${esc(view.url)}</div>
        <div class="flags">${flags}</div>
      </div>
    </div>
    <div class="eyebrow">Findings</div>
    <div class="checks">${checks}</div>
    ${pitch}
  `;
}

export function buildAuditPdfHtml(
  view: AuditView,
  opts: AuditDocOptions = {},
): string {
  const brand = opts.brandName ?? "Venture CO Group";
  const date = fmtDate(opts.generatedAt ?? new Date());

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><style>
  @page { size: A4; margin: 0; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: #00051D; color: #EFF1F8; padding: 48px 44px;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .brand { font-size: 22px; letter-spacing: -0.02em; margin-bottom: 4px; }
  .brand b { font-weight: 800; } .brand span { font-weight: 300; color: #858CAE; margin-left: 6px; }
  .kicker { font-size: 10px; letter-spacing: 0.16em; text-transform: uppercase; color: #858CAE; margin-bottom: 34px; }
  .hero { display: flex; align-items: center; gap: 24px; padding: 22px 0 26px; border-bottom: 1px solid rgba(239,241,248,0.09); }
  .score {
    font-size: 76px; font-weight: 800; letter-spacing: -0.03em; line-height: 1;
    background: linear-gradient(135deg,#310B59,#7427C6); -webkit-background-clip: text; background-clip: text; color: transparent;
  }
  .verdict { font-size: 20px; font-weight: 700; margin-bottom: 6px; }
  .url { font-size: 12px; }
  .muted { color: #858CAE; }
  .flags { margin-top: 10px; }
  .tag {
    display: inline-block; font-size: 11px; font-weight: 700; color: #EFF1F8;
    background: linear-gradient(135deg,#310B59,#7427C6); border-radius: 20px; padding: 3px 10px; margin: 0 4px 4px 0;
  }
  .eyebrow { font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; color: #858CAE; margin: 26px 0 12px; }
  .checks { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 24px; }
  .check { display: flex; align-items: center; gap: 10px; font-size: 12.5px; color: #C9CEE3; }
  .ic { display: inline-grid; place-items: center; width: 17px; height: 17px; border-radius: 50%; font-size: 10px; }
  .ic.p { background: rgba(61,220,151,0.15); color: #3DDC97; }
  .ic.f { background: rgba(255,92,122,0.15); color: #FF5C7A; }
  .pitch { margin-top: 26px; border: 1px solid rgba(116,39,198,0.4); background: rgba(116,39,198,0.10); border-radius: 12px; padding: 16px 18px; }
  .pitch p { font-size: 12.5px; line-height: 1.6; color: #E4D3FF; }
  .foot { margin-top: 40px; padding-top: 14px; border-top: 1px solid rgba(239,241,248,0.09); font-size: 10.5px; color: #858CAE; }
</style></head>
<body>
  <div class="brand"><b>venture</b><span>co.group</span></div>
  <div class="kicker">Website Opportunity Audit</div>
  ${auditReportBody(view)}
  <div class="foot">Prepared by ${esc(brand)} · ${date} · High score = weak site = strong opportunity.</div>
</body></html>`;
}
