import type { AuditView } from "./types";
import { scoreByCategory, ungroupedChecks, CATEGORY_LABEL } from "./categories";
import { analyzeStructure } from "./structure";

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

/**
 * Screenshots as data URIs, read from disk by the caller.
 *
 * The PDF is rendered by headless Chrome in the worker, which has no session
 * and cannot pull /api/files. Inlining the bytes is what makes the images
 * appear at all — a src pointing at the app would render two broken boxes,
 * which is exactly how they came to be missing from the PDF.
 */
export interface InlineShots {
  desktop?: string | null;
  mobile?: string | null;
}

/** Shared report body (used by both the PDF and the public share page). */
export function auditReportBody(view: AuditView, shots: InlineShots = {}): string {
  const flags = view.flags
    .map(
      (f) =>
        `<span class="tag">${esc(f)}</span>`,
    )
    .join("");

  // Grouped by category with a subscore each (P1/3d), so the reader sees
  // WHERE the site is weak rather than one number. Categories with nothing
  // measured are omitted entirely — printing "not measured" rows would pad the
  // report with our own gaps.
  const grouped = scoreByCategory(view.checks).filter((g) => g.total > 0);
  const checks = grouped
    .map(
      (g) => `
      <div class="cat">
        <div class="cat-head">
          <span class="cat-name">${esc(CATEGORY_LABEL[g.category].en)}</span>
          <span class="cat-score">${g.failed}/${g.total} issues</span>
        </div>
        ${g.checks
          .map(
            (c) => `
        <div class="check">
          <span class="ic ${c.pass ? "p" : "f"}">${c.pass ? "&#10003;" : "&#10007;"}</span>
          <span>${esc(c.label)}${c.detail ? ` <span class="muted">· ${esc(c.detail)}</span>` : ""}</span>
        </div>`,
          )
          .join("")}
      </div>`,
    )
    .join("");

  const otherChecks = ungroupedChecks(view.checks);
  const other =
    otherChecks.length === 0
      ? ""
      : `<div class="cat"><div class="cat-head"><span class="cat-name">Other</span></div>` +
        otherChecks
          .map(
            (c) =>
              `<div class="check"><span class="ic ${c.pass ? "p" : "f"}">${
                c.pass ? "&#10003;" : "&#10007;"
              }</span><span>${esc(c.label)}</span></div>`,
          )
          .join("") +
        `</div>`;

  const shotPairs: Array<[string, string | null | undefined]> = [
    ["Asztali nezet", shots.desktop],
    ["Mobil nezet", shots.mobile],
  ];
  const shotsHtml = shotPairs.some(([, src]) => src)
    ? '<div class="shots">' +
      shotPairs
        .filter(([, src]) => src)
        .map(
          ([label, src]) =>
            '<figure><img src="' + src + '" alt="' + esc(label) + '"/><figcaption>' +
            esc(label) + "</figcaption></figure>",
        )
        .join("") +
      "</div>"
    : "";

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
    <div class="checks">${checks}${other}</div>
    ${structureSection(view)}
    ${shotsHtml}
    ${pitch}
  `;
}

/**
 * Per-page detail from the crawl (P2/1) — the sales PDF only.
 *
 * The grouped findings above already carry the Site structure verdicts; this
 * is the evidence behind them, which is what makes the finding usable in a
 * conversation ("these four pages share one title, here they are").
 */
function structureSection(view: AuditView): string {
  const crawl = view.crawl;
  if (!crawl || crawl.pages.length === 0) return "";
  const { rows } = analyzeStructure(crawl);

  const kb = (b: number) => (b > 0 ? `${Math.round(b / 1000)} KB` : "—");
  const body = rows
    .map((r) => {
      const notes: string[] = [];
      if (r.titleDuplicate) notes.push("duplicate title");
      if (r.metaDuplicate) notes.push("duplicate meta");
      if (r.h1Count !== 1) notes.push(r.h1Count === 0 ? "no H1" : `${r.h1Count} H1s`);
      if (r.redirects.length >= 2) notes.push(`${r.redirects.length} redirects`);
      if (r.brokenLinksOut > 0) notes.push(`${r.brokenLinksOut} broken links`);
      if (r.weightOutlier) notes.push("heavy");
      if (r.deep?.a11y && r.deep.a11y.critical > 0) {
        notes.push(`${r.deep.a11y.critical} critical a11y`);
      }
      return `<tr>
        <td>${esc(r.path)}</td>
        <td class="num">${r.status ?? "—"}</td>
        <td>${esc(r.title ?? "—")}</td>
        <td class="num">${kb(r.bytes)}</td>
        <td class="muted">${esc(notes.join(", ") || "—")}</td>
      </tr>`;
    })
    .join("");

  const broken = crawl.brokenLinks.length
    ? `<div class="broken"><b>Broken links</b>${crawl.brokenLinks
        .slice(0, 12)
        .map(
          (b) =>
            `<div class="muted">${esc(pathOnly(b.from))} &rarr; ${esc(
              pathOnly(b.to),
            )} · ${b.status ?? "unreachable"}</div>`,
        )
        .join("")}${
        crawl.brokenLinks.length > 12
          ? `<div class="muted">+${crawl.brokenLinks.length - 12} more</div>`
          : ""
      }</div>`
    : "";

  const scope = `${crawl.pages.length} of ${crawl.discovered} pages crawled${
    crawl.deadlineHit ? " · stopped on time budget" : ""
  }${crawl.robotsSkipped > 0 ? ` · ${crawl.robotsSkipped} skipped per robots.txt` : ""}`;

  return `
    <div class="eyebrow">Site structure</div>
    <div class="muted scope">${esc(scope)}</div>
    <table class="pages">
      <thead><tr><th>Page</th><th>Status</th><th>Title</th><th>HTML</th><th>Notes</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
    ${broken}
  `;
}

function pathOnly(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}` || "/";
  } catch {
    return url;
  }
}

export function buildAuditPdfHtml(
  view: AuditView,
  opts: AuditDocOptions & { shots?: InlineShots } = {},
): string {
  const brand = opts.brandName ?? "Venture CO Group";
  const date = fmtDate(opts.generatedAt ?? new Date());

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><style>
  @page { size: A4; margin: 0; }
  .cat { margin-top: 14px; break-inside: avoid; }
  .cat-head {
    display: flex; align-items: baseline; gap: 8px; padding-bottom: 4px;
    border-bottom: 1px solid rgba(239,241,248,0.09); margin-bottom: 6px;
  }
  .cat-name { font-size: 11px; font-weight: 700; letter-spacing: .04em; }
  .cat-score { margin-left: auto; font-size: 10px; color: #858CAE; }
  .shots { display: flex; gap: 12px; margin-top: 18px; }
  .shots figure { flex: 1; min-width: 0; }
  .shots img {
    width: 100%; height: 150px; object-fit: cover; object-position: top;
    border: 1px solid rgba(239,241,248,0.09); border-radius: 10px;
  }
  .shots figcaption {
    margin-top: 4px; text-align: center; font-size: 9px; color: #858CAE;
  }
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
  .scope { font-size: 10px; margin: -6px 0 8px; }
  .pages { width: 100%; border-collapse: collapse; font-size: 10px; table-layout: fixed; }
  .pages th {
    text-align: left; font-size: 9px; letter-spacing: .06em; text-transform: uppercase;
    color: #858CAE; border-bottom: 1px solid rgba(239,241,248,0.09); padding: 4px 6px 4px 0;
  }
  .pages td {
    padding: 4px 6px 4px 0; color: #C9CEE3; vertical-align: top;
    border-bottom: 1px solid rgba(239,241,248,0.05);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .pages td.num { font-variant-numeric: tabular-nums; }
  .pages th:nth-child(2), .pages td:nth-child(2) { width: 48px; }
  .pages th:nth-child(4), .pages td:nth-child(4) { width: 56px; }
  .pages th:nth-child(5), .pages td:nth-child(5) { width: 150px; white-space: normal; }
  .broken { margin-top: 10px; font-size: 10px; }
  .broken b { display: block; margin-bottom: 3px; font-size: 10px; }
  .pitch { margin-top: 26px; border: 1px solid rgba(116,39,198,0.4); background: rgba(116,39,198,0.10); border-radius: 12px; padding: 16px 18px; }
  .pitch p { font-size: 12.5px; line-height: 1.6; color: #E4D3FF; }
  .foot { margin-top: 40px; padding-top: 14px; border-top: 1px solid rgba(239,241,248,0.09); font-size: 10.5px; color: #858CAE; }
</style></head>
<body>
  <div class="brand"><b>venture</b><span>co.group</span></div>
  <div class="kicker">Website Opportunity Audit</div>
  ${auditReportBody(view, opts.shots ?? {})}
  <div class="foot">Prepared by ${esc(brand)} · ${date} · High score = weak site = strong opportunity.</div>
</body></html>`;
}
