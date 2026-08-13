/**
 * Branded log-analysis appendix (P2/8).
 *
 * Attaches to a client report. Same headless-Chrome pipeline and the same
 * workspace branding as every other document we print — nothing here is
 * Venture-specific.
 */
import { VENTURE_BRAND, brandGradient, type WorkspaceBrand } from "../workspaces/brand";
import type { LogAnalysis } from "./analyze";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function table(title: string, rows: Array<{ path: string; hits: number }>, empty: string): string {
  if (rows.length === 0) {
    return `<div class="block"><div class="h">${esc(title)}</div><div class="muted">${esc(empty)}</div></div>`;
  }
  return `<div class="block">
    <div class="h">${esc(title)}</div>
    <table>${rows
      .slice(0, 10)
      .map((r) => `<tr><td>${esc(r.path)}</td><td class="num">${r.hits}</td></tr>`)
      .join("")}</table>
  </div>`;
}

export function buildLogAppendixHtml(
  analysis: LogAnalysis,
  opts: { brand?: WorkspaceBrand; companyName?: string; generatedAt?: Date } = {},
): string {
  const brand = opts.brand ?? VENTURE_BRAND;
  const date = (opts.generatedAt ?? new Date()).toISOString().slice(0, 10);
  const period =
    analysis.from && analysis.to
      ? `${analysis.from.slice(0, 10)} – ${analysis.to.slice(0, 10)}`
      : "ismeretlen időszak";

  const mark = brand.logoUrl
    ? `<img class="logo" src="${esc(brand.logoUrl)}" alt="${esc(brand.name)}"/>`
    : `<b>${esc(brand.markBold)}</b>${brand.markLight ? `<span>${esc(brand.markLight)}</span>` : ""}`;

  const slow = analysis.hasTimings
    ? `<div class="block"><div class="h">Leglassabb végpontok</div><table>${analysis.slowEndpoints
        .slice(0, 10)
        .map(
          (s) =>
            `<tr><td>${esc(s.path)}</td><td class="num">${s.avgSeconds.toFixed(2)}s átlag</td><td class="num">${s.hits}×</td></tr>`,
        )
        .join("")}</table></div>`
    : `<div class="block"><div class="h">Válaszidők</div><div class="muted">A log formátuma nem tartalmaz válaszidőt.</div></div>`;

  return `<!doctype html>
<html lang="hu"><head><meta charset="utf-8"><style>
  @page { size: A4; margin: 0; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: #00051D; color: #EFF1F8; padding: 44px 40px;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .brand { font-size: 20px; letter-spacing: -0.02em; margin-bottom: 4px; }
  .brand b { font-weight: 800; } .brand span { font-weight: 300; color: #858CAE; margin-left: 6px; }
  .logo { max-height: 30px; max-width: 200px; }
  .kicker { font-size: 10px; letter-spacing: 0.16em; text-transform: uppercase; color: #858CAE; margin-bottom: 24px; }
  h1 { font-size: 22px; font-weight: 800; letter-spacing: -0.02em; margin-bottom: 4px;
       background: ${brandGradient(brand)}; -webkit-background-clip: text; background-clip: text; color: transparent; }
  .lede { font-size: 11.5px; color: #858CAE; margin-bottom: 20px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px 26px; }
  .block { break-inside: avoid; }
  .h { font-size: 10px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase;
       color: #858CAE; border-bottom: 1px solid rgba(239,241,248,0.09); padding-bottom: 3px; margin-bottom: 5px; }
  table { width: 100%; border-collapse: collapse; font-size: 10.5px; }
  td { padding: 2.5px 0; color: #C9CEE3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 200px; }
  td.num { text-align: right; color: #858CAE; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .muted { color: #858CAE; font-size: 10.5px; }
  .foot { margin-top: 28px; padding-top: 12px; border-top: 1px solid rgba(239,241,248,0.09); font-size: 10px; color: #858CAE; }
</style></head>
<body>
  <div class="brand">${mark}</div>
  <div class="kicker">Szerverlog-elemzés</div>
  <h1>${esc(opts.companyName ?? "Szerverlog-elemzés")}</h1>
  <div class="lede">
    ${period} · ${analysis.parsed.toLocaleString("hu-HU")} feldolgozott kérés ·
    Googlebot ${analysis.verifiedBotHits.googlebot}/${analysis.botHits.googlebot} igazolt,
    Bingbot ${analysis.verifiedBotHits.bingbot}/${analysis.botHits.bingbot} igazolt
  </div>

  <div class="grid">
    ${table("Crawl budget — hova jut a robot", analysis.crawlBudget, "Nem járt itt robot.")}
    ${table("404 gócpontok", analysis.notFoundHotspots, "Nincs ismétlődő 404.")}
    ${table("5xx hibák", analysis.serverErrorHotspots, "Nincs szerverhiba.")}
    ${table("Átirányítás-találatok", analysis.redirectHotspots, "Nincs jelentős átirányítás.")}
    ${table("Csak robot járt itt", analysis.botOnlyPaths, "Nincs ilyen oldal.")}
    ${table("Robot még nem járt itt", analysis.humanOnlyPaths, "Minden látogatott oldalt bejárt robot is.")}
    ${slow}
  </div>

  <div class="foot">
    ${esc(brand.footerIdentity)} · ${date} · A feltöltött logfájl a feldolgozás után törlésre kerül;
    ebben a kimutatásban egyetlen IP-cím vagy logsor sem szerepel.
  </div>
</body></html>`;
}
