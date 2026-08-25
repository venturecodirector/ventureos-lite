import type { WorkspaceBrand } from "@/modules/workspaces/brand";
import type { SectorStats } from "./stats";
import type { SectorNarrative } from "@/lib/ai/prompts/sector-report";

/**
 * The published report (playbook-v4 P12/2b).
 *
 * ── THE CHART IS DRAWN, NOT LOADED ─────────────────────────────────────────
 *
 * Bars are divs with a width. No chart library, no external font, no image
 * request — the PDF renderer prints this in a headless browser with no network,
 * and a chart that needs a CDN is a chart that renders as a blank box.
 *
 * ── AND IT NAMES NOBODY ────────────────────────────────────────────────────
 *
 * Every value below comes from `stats`, which has nowhere to put a company. The
 * only URL in the document is our own call to action.
 */
function esc(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

export function renderSectorReportHtml(input: {
  title: string;
  sector: string;
  location: string;
  brand: WorkspaceBrand;
  stats: SectorStats;
  narrative: SectorNarrative;
  ctaUrl: string;
  generatedOn: string;
}): string {
  const { stats, narrative, brand } = input;

  const bar = (label: string, share: number, of: number) => `
    <div class="row">
      <div class="label">${esc(label)}</div>
      <div class="track"><div class="fill" style="width:${Math.round(share * 100)}%"></div></div>
      <div class="num">${pct(share)} <span class="of">(${of})</span></div>
    </div>`;

  const bandTotal = stats.scoreBands.weak + stats.scoreBands.middling + stats.scoreBands.strong;
  const band = (label: string, n: number) =>
    bar(label, bandTotal > 0 ? n / bandTotal : 0, n);

  return `<!doctype html><html lang="hu"><head><meta charset="utf-8">
<style>
  @page { size: A4; margin: 18mm 16mm; }
  body { font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color:#11162B; font-size:11pt; line-height:1.5; }
  h1 { font-size:22pt; margin:0 0 4px; letter-spacing:-0.02em; }
  h2 { font-size:13pt; margin:22px 0 6px; color:${esc(brand.color)}; }
  .sub { color:#5A6180; font-size:10pt; margin:0 0 18px; }
  .lead { font-size:12pt; }
  .kpis { display:flex; gap:10px; margin:14px 0 6px; }
  .kpi { flex:1; border:1px solid #E2E5EF; border-radius:8px; padding:10px 12px; }
  .kpi b { display:block; font-size:19pt; line-height:1.1; }
  .kpi span { color:#5A6180; font-size:9pt; }
  .row { display:flex; align-items:center; gap:8px; margin:4px 0; }
  .label { width:46%; font-size:10pt; }
  .track { flex:1; height:9px; background:#EFF1F8; border-radius:5px; overflow:hidden; }
  .fill { height:100%; background:${esc(brand.color)}; }
  .num { width:76px; text-align:right; font-size:10pt; font-variant-numeric:tabular-nums; }
  .of { color:#8A90AA; font-size:8.5pt; }
  .note { background:#F6F7FB; border-radius:8px; padding:10px 12px; font-size:9.5pt; color:#5A6180; }
  .cta { margin-top:22px; border:1px solid ${esc(brand.color)}33; border-radius:10px; padding:14px 16px; }
  .foot { margin-top:24px; border-top:1px solid #E2E5EF; padding-top:8px; color:#8A90AA; font-size:8.5pt; }
</style></head><body>

<h1>${esc(input.title)}</h1>
<p class="sub">${esc(input.location)} · ${esc(input.sector)} · ${esc(input.generatedOn)} · ${stats.audited} megmért weboldal</p>

<p class="lead">${esc(narrative.summary)}</p>

<div class="kpis">
  <div class="kpi"><b>${stats.audited}</b><span>megmért oldal</span></div>
  <div class="kpi"><b>${stats.scoreMedian}</b><span>medián pontszám (100 = leggyengébb)</span></div>
  <div class="kpi"><b>${
    stats.loadMsMedian != null ? `${(stats.loadMsMedian / 1000).toFixed(1)}s` : "—"
  }</b><span>medián betöltés</span></div>
</div>

<h2>Hogyan oszlanak meg</h2>
${band("gyenge oldalak", stats.scoreBands.weak)}
${band("közepes", stats.scoreBands.middling)}
${band("erős", stats.scoreBands.strong)}

<h2>Mi hiányzik a leggyakrabban</h2>
${stats.failing.map((f) => bar(f.label, f.share, f.of)).join("")}

<h2>Módszertan</h2>
<p class="note">${esc(narrative.methodologyNote)} A minta ${stats.found} találatból ${
    stats.audited
  } weboldal nyilvános, automatizált vizsgálatán alapul. Egyetlen vállalkozás sem azonosítható belőle: a riport kizárólag összesített adatokat közöl.</p>

${narrative.findings
  .map((f) => `<h2>${esc(f.heading)}</h2><p>${esc(f.body)}</p>`)
  .join("")}

<div class="cta">
  <b>Mit érdemes most tenni?</b>
  <p style="margin:6px 0 0">${esc(narrative.closing)}</p>
  <p style="margin:8px 0 0">A saját oldalát 60 másodperc alatt átvilágíthatja: <b>${esc(input.ctaUrl)}</b></p>
</div>

<div class="foot">${esc(brand.name)} · ${esc(input.generatedOn)}</div>
</body></html>`;
}
