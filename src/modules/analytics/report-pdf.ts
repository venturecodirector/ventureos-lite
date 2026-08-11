import type { WeeklyReport } from "./reports";

/**
 * Branded Friday-report PDF (spec §4.14), rendered through the shared
 * headless-Chrome pipeline. Consumes the deterministic report + optional
 * commentary/comment — no AI in the render path.
 */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function pct(n: number | null): string {
  return n == null ? "—" : `${Math.round(n * 100)}%`;
}
function huf(n: number): string {
  return `${n.toLocaleString("en-US").replace(/,/g, " ")} Ft`;
}

export function buildReportPdfHtml(
  r: WeeklyReport,
  commentary: string | null,
  comment: string | null,
): string {
  const kpis = r.kpis
    .map(
      (k) =>
        `<tr><td>${esc(k.metric)}</td><td class="num">${k.value}</td><td class="num">${
          k.target != null ? `${k.target} · ${pct(k.pct)}` : "—"
        }</td></tr>`,
    )
    .join("");
  const funnel = r.funnel
    .map((f) => `<tr><td>${esc(f.stage)}</td><td class="num">${f.count}</td><td class="num">${pct(f.conversion)}</td></tr>`)
    .join("");
  const sources = r.sources
    .map(
      (s) =>
        `<tr><td>${esc(s.source)}</td><td class="num">${s.leads}</td><td class="num">${pct(s.replyRate)}</td><td class="num">${s.won}</td><td class="num">${huf(s.revenue)}</td></tr>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><style>
  @page { size: A4; margin: 0; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; background: #00051D; color: #EFF1F8; padding: 44px 42px; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .brand { font-size: 22px; letter-spacing: -0.02em; margin-bottom: 2px; }
  .brand b { font-weight: 800; } .brand span { font-weight: 300; color: #858CAE; margin-left: 6px; }
  .kicker { font-size: 10px; letter-spacing: 0.16em; text-transform: uppercase; color: #858CAE; margin-bottom: 18px; }
  h2 { font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: #7427C6; margin: 18px 0 6px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  td, th { text-align: left; padding: 5px 0; border-bottom: 1px solid rgba(239,241,248,0.09); color: #C9CEE3; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  p { font-size: 12.5px; line-height: 1.6; color: #C9CEE3; }
  .note { border: 1px solid rgba(116,39,198,0.4); background: rgba(116,39,198,0.08); border-radius: 10px; padding: 10px 12px; margin-top: 6px; }
</style></head>
<body>
  <div class="brand"><b>venture</b><span>co.group</span></div>
  <div class="kicker">Weekly report · ${esc(r.weekLabel)}</div>

  ${commentary ? `<h2>What worked</h2><div class="note"><p>${esc(commentary)}</p></div>` : ""}

  <h2>KPIs vs target</h2>
  <table><tr><th>Metric</th><th class="num">Value</th><th class="num">Target</th></tr>${kpis}</table>

  <h2>Funnel</h2>
  <table><tr><th>Stage</th><th class="num">Count</th><th class="num">Conv.</th></tr>${funnel}</table>

  <h2>Per source</h2>
  <table><tr><th>Source</th><th class="num">Leads</th><th class="num">Reply</th><th class="num">Won</th><th class="num">Revenue</th></tr>${sources}</table>

  <h2>Audit → meeting</h2>
  <p>${pct(r.auditToMeeting.rate)} — ${r.auditToMeeting.meetings} of ${r.auditToMeeting.audited} audited leads booked a meeting.</p>

  <h2>Document chain</h2>
  <p>Quote acceptance ${pct(r.docChain.acceptanceRate)} (${r.docChain.accepted}/${r.docChain.quotes}) · avg days quote→signed ${r.docChain.avgDaysToSigned?.toFixed(1) ?? "—"}.</p>

  ${comment ? `<h2>Note from the team</h2><p>${esc(comment)}</p>` : ""}
</body></html>`;
}
