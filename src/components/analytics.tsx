import type { AnalyticsView } from "@/modules/analytics/actions";
import type { AggRow } from "@/modules/analytics/aggregate";
import { STAGE_LABELS } from "@/modules/pipeline/transitions";
import type { Stage } from "@prisma/client";
import { ReportComment } from "./report-comment";

function huf(n: number): string {
  return `${n.toLocaleString("en-US").replace(/,/g, " ")} Ft`;
}
function pct(n: number | null): string {
  return n == null ? "—" : `${Math.round(n * 100)}%`;
}

function DimTable({ title, rows }: { title: string; rows: AggRow[] }) {
  return (
    <div className="rounded-card border border-line bg-panel p-4">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">{title}</div>
      {rows.length === 0 ? (
        <p className="text-[12px] text-muted">No closed deals yet.</p>
      ) : (
        <div className="grid gap-1.5">
          {rows.slice(0, 6).map((r) => (
            <div key={r.key} className="grid grid-cols-[1fr_auto] items-baseline gap-2">
              <span className="truncate text-[12.5px] text-[#C9CEE3]" title={r.key}>{r.key}</span>
              <span className="text-right text-[11.5px] text-muted tabular-nums">
                <b className="text-ink">{huf(r.revenue)}</b> · {pct(r.closeRate)} · {r.won}W/{r.lost}L
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One row of a bar chart: label, a track the fill lives INSIDE, and a value.
 *
 * The track is a real element with overflow-hidden, and the fill is clamped to
 * 0–100%. Both matter: the funnel previously scaled each bar against the FIRST
 * stage, so any stage larger than it (leads that enter directly at Contacted)
 * produced widths like 400% that escaped the card and drew across the rest of
 * the page. A percentage width alone cannot overflow its own track — but only
 * if there IS a track and it clips.
 *
 * The three columns are a fixed grid so labels, bars and values line up down
 * the column at every viewport width.
 */
function BarRow({
  label,
  fillPct,
  value,
  over = false,
  height = "h-[22px]",
}: {
  label: string;
  fillPct: number;
  value: string;
  /** Value exceeds the reference — shown as a marker, never as a wider bar. */
  over?: boolean;
  height?: string;
}) {
  const width = Math.max(0, Math.min(100, Number.isFinite(fillPct) ? fillPct : 0));
  return (
    <div className="grid grid-cols-[minmax(88px,110px)_1fr_minmax(72px,96px)] items-center gap-3 py-[7px] text-[12.5px]">
      <span className="truncate" title={label}>
        {label}
      </span>
      <span
        className={`relative ${height} w-full overflow-hidden rounded-[6px] bg-panel-2`}
        role="img"
        aria-label={`${label}: ${value}`}
      >
        <span
          className="absolute inset-y-0 left-0 rounded-[6px] bg-[linear-gradient(135deg,#310B59,#7427C6)] opacity-90"
          style={{ width: `${width}%` }}
        />
        {over && (
          // The bar is full; this marks that the real value is past the
          // reference, instead of letting the bar run off the card.
          <span className="absolute inset-y-0 right-0 w-[3px] bg-pos" title="Above the reference" />
        )}
      </span>
      <span className="text-right tabular-nums text-muted">{value}</span>
    </div>
  );
}

export function Analytics({ view }: { view: AnalyticsView }) {
  const r = view.report;
  // Scale against the LARGEST stage, not the first — a funnel is not always
  // monotonically decreasing, and dividing by the first stage is what produced
  // the 400%-wide bars.
  const top = Math.max(1, ...r.funnel.map((f) => f.count));
  const t = view.totals;

  return (
    <div className="mx-auto w-full max-w-[1400px]">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.1fr_1fr]">
        {/* funnel with per-step conversion */}
        <div className="min-w-0 rounded-card border border-line bg-panel p-[18px]">
          <div className="mb-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">Funnel</div>
          {r.funnel.map((f) => (
            <BarRow
              key={f.stage}
              label={STAGE_LABELS[f.stage as Stage] ?? f.stage}
              fillPct={(f.count / top) * 100}
              value={`${f.count}${f.conversion != null ? ` · ${pct(f.conversion)}` : ""}`}
            />
          ))}
        </div>

        {/* KPIs vs target (milestone overlay) */}
        <div className="rounded-card border border-line bg-panel p-[18px]">
          <div className="mb-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">KPIs vs target</div>
          {r.kpis.map((k) => (
            <div key={k.metric} className="mb-2.5">
              <div className="mb-1 grid grid-cols-[1fr_auto] items-baseline gap-3 text-[12.5px]">
                <span className="truncate text-[#C9CEE3]">{k.metric.replace(/_/g, " ")}</span>
                <span className="tabular-nums text-muted">
                  <b className="text-ink">{k.value}</b>
                  {k.target != null ? ` / ${k.target} · ${pct(k.pct)}` : ""}
                </span>
              </div>
              <div className="relative h-[6px] w-full overflow-hidden rounded-full bg-panel-2">
                <div
                  className="absolute inset-y-0 left-0 rounded-full bg-[linear-gradient(135deg,#310B59,#7427C6)]"
                  style={{ width: `${Math.max(0, Math.min(100, Math.round((k.pct ?? 0) * 100)))}%` }}
                />
                {(k.pct ?? 0) > 1 && (
                  <span className="absolute inset-y-0 right-0 w-[3px] bg-pos" title="Above target" />
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* per-source + audit→meeting + doc-chain */}
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[1.4fr_1fr]">
        <div className="rounded-card border border-line bg-panel p-[18px]">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">Per-source performance</div>
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-muted">
                <th className="py-1 text-left font-medium">Source</th>
                <th className="py-1 text-right font-medium">Leads</th>
                <th className="py-1 text-right font-medium">Reply</th>
                <th className="py-1 text-right font-medium">Won</th>
                <th className="py-1 text-right font-medium">Revenue</th>
              </tr>
            </thead>
            <tbody>
              {r.sources.length === 0 && (
                <tr><td colSpan={5} className="py-2 text-muted">No leads yet.</td></tr>
              )}
              {r.sources.map((s) => (
                <tr key={s.source} className="border-t border-line">
                  <td className="py-1.5 text-[#C9CEE3]">{s.source.toLowerCase()}</td>
                  <td className="py-1.5 text-right tabular-nums">{s.leads}</td>
                  <td className="py-1.5 text-right tabular-nums text-muted">{pct(s.replyRate)}</td>
                  <td className="py-1.5 text-right tabular-nums">{s.won}</td>
                  <td className="py-1.5 text-right tabular-nums">{huf(s.revenue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="grid gap-4">
          <div className="rounded-card border border-line bg-panel p-[18px]">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">Audit → meeting</div>
            <div className="text-[15px] font-extrabold">{pct(r.auditToMeeting.rate)}</div>
            <p className="text-[11.5px] text-muted">
              {r.auditToMeeting.meetings} of {r.auditToMeeting.audited} audited leads booked a meeting.
            </p>
          </div>
          <div className="rounded-card border border-line bg-panel p-[18px]">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">Document chain</div>
            <div className="text-[15px] font-extrabold">{pct(r.docChain.acceptanceRate)}</div>
            <p className="text-[11.5px] text-muted">
              Quote acceptance ({r.docChain.accepted}/{r.docChain.quotes}) · avg{" "}
              {r.docChain.avgDaysToSigned != null ? `${r.docChain.avgDaysToSigned.toFixed(1)} days` : "—"} quote→signed.
            </p>
          </div>
        </div>
      </div>

      {/* what closes + top referrers */}
      <div className="mt-4 rounded-card border border-line bg-[radial-gradient(400px_200px_at_90%_-20%,rgba(116,39,198,0.12),transparent_60%),rgba(239,241,248,0.02)] p-[18px]">
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">What closes</div>
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[12.5px]">
          <span className="text-[15px] font-extrabold text-ink">{huf(t.revenue)}</span>
          <span className="text-muted">{t.won} won · {t.lost} lost · {t.postponed} postponed</span>
          <span className="text-muted">close rate {t.won + t.lost > 0 ? pct(t.won / (t.won + t.lost)) : "—"}</span>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <DimTable title="By hook" rows={view.whatCloses.byHook} />
        <DimTable title="By signal" rows={view.whatCloses.bySignal} />
        <DimTable title="By source" rows={view.whatCloses.bySource} />
        <DimTable title="By segment" rows={view.whatCloses.bySegment} />
        <DimTable title="By audit-score band" rows={view.whatCloses.byScoreBand} />
        <TopReferrersPanel rows={view.topReferrers} />
      </div>

      {/* weekly report (in-app view + Fanni's comment + PDF) */}
      <div className="mt-4 rounded-card border border-line bg-panel p-[18px]">
        <div className="mb-2 flex items-center gap-2">
          <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">Friday report</div>
          {view.latestReport && <span className="text-[11px] text-muted">{view.latestReport.weekLabel}</span>}
          {view.latestReport?.pdfPath && (
            <a
              href={`/api/files/${view.latestReport.pdfPath}`}
              target="_blank"
              rel="noreferrer"
              className="ml-auto rounded-[8px] border border-line bg-panel px-3 py-1.5 text-[12px] hover:bg-panel-2"
            >
              ⬇ Branded PDF
            </a>
          )}
        </div>
        {view.latestReport ? (
          <>
            {view.latestReport.commentary && (
              <p className="mb-3 rounded-[10px] border border-[rgba(116,39,198,0.4)] bg-accent-soft px-3.5 py-2.5 text-[12.5px] leading-relaxed text-[#D8DCEF]">
                ✦ {view.latestReport.commentary}
              </p>
            )}
            <ReportComment id={view.latestReport.id} initial={view.latestReport.comment} />
          </>
        ) : (
          <p className="text-[12.5px] text-muted">
            The Friday report generates automatically at 16:00 — deterministic numbers plus one Claude
            note. It appears here with a PDF export and a comment field.
          </p>
        )}
      </div>
    </div>
  );
}

function TopReferrersPanel({ rows }: { rows: AnalyticsView["topReferrers"] }) {
  return (
    <div className="rounded-card border border-line bg-panel p-4">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">Top referrers</div>
      {rows.length === 0 ? (
        <p className="text-[12px] text-muted">No referred revenue yet.</p>
      ) : (
        <div className="grid gap-1.5">
          {rows.map((r) => (
            <div key={r.referrerId} className="grid grid-cols-[1fr_auto] items-baseline gap-2">
              <span className="truncate text-[12.5px] text-[#C9CEE3]" title={r.name}>{r.name}</span>
              <span className="text-right text-[11.5px] text-muted tabular-nums">
                <b className="text-ink">{huf(r.attributedRevenue)}</b> · {r.won}/{r.referred} won
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
