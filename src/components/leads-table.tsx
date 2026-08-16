"use client";

import { useCallback, useMemo, useState, useTransition } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { moveLeadStage, runResearch } from "@/modules/leads/actions";
import { COLUMNS, columnDef } from "@/modules/leads/columns";
import type { FilterSet, SortField, SortSpec } from "@/modules/leads/filters";
import type { LeadFacets, LeadTableRow } from "@/modules/leads/table";
import { serializeColumns, serializeFilterSet, serializeSort } from "@/modules/leads/view-params";
import type { LeadView } from "@/modules/leads/views";
import { LeadBulkBar } from "./lead-bulk-bar";
import { LeadFilterBuilder } from "./lead-filter-builder";
import { LeadViewTabs } from "./lead-view-tabs";
import { LeadDetailModal } from "./lead-detail-modal";
import { EnrichDialog, OverrideDialog } from "./lead-dialogs";
import { LeadAvatar } from "./lead-avatar";
import { RiskChip } from "./risk-chip";

/**
 * The leads table (playbook-v2 P3/2): selectable columns, sorting, pagination
 * and the filter builder above it.
 *
 * All of the table's state — filter, sort, columns, page — lives in the URL.
 * That is what makes a filtered table linkable and refresh-proof, and it is
 * also what lets a saved view be nothing more cunning than a stored query
 * string. The server does the filtering; this component only navigates.
 */

export interface LeadsTableProps {
  rows: LeadTableRow[];
  columns: string[];
  sort: SortSpec;
  filters: FilterSet;
  facets: LeadFacets;
  threshold: number;
  page: number;
  pageCount: number;
  total: number;
  totalUnfiltered: number;
  views: LeadView[];
  activeViewId: string | null;
  currentUserId: string;
  canCurateViews: boolean;
  /** Owner-only, matching the single-lead delete. */
  canDelete: boolean;
  /** `exports.run` grant (spec §3). */
  canExport: boolean;
}

function Notches({ score }: { score: number | null }) {
  const n = score ?? 0;
  return (
    <span className="inline-flex gap-[3px] align-middle">
      {Array.from({ length: 5 }).map((_, i) => (
        <i key={i} className={`h-[5px] w-[9px] rounded-[2px] ${i < n ? "bg-grad" : "bg-line"}`} />
      ))}
    </span>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="mr-1 mb-1 inline-flex items-center rounded-full border border-accent-soft px-2 py-0.5 text-[11px] font-semibold text-accent-ink">
      {children}
    </span>
  );
}

/** "3 days ago" beats a timestamp for a column people scan rather than read. */
function relativeDays(date: Date | string | null): string {
  if (!date) return "—";
  const at = typeof date === "string" ? new Date(date) : date;
  const days = Math.floor((Date.now() - at.getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  if (days < 365) return `${Math.floor(days / 30)} mo ago`;
  return `${Math.floor(days / 365)} yr ago`;
}

function humanEnum(v: string): string {
  return v.toLowerCase().replace(/_/g, " ");
}

export function LeadsTable(props: LeadsTableProps) {
  const {
    rows,
    columns,
    sort,
    filters,
    facets,
    threshold,
    page,
    pageCount,
    total,
    totalUnfiltered,
    views,
    activeViewId,
    currentUserId,
    canCurateViews,
    canDelete,
    canExport,
  } = props;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [detailFor, setDetailFor] = useState<string | null>(null);
  const [overrideFor, setOverrideFor] = useState<string | null>(null);
  const [enrichFor, setEnrichFor] = useState<string | null>(null);
  const [showColumns, setShowColumns] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Ticked rows. Ids rather than indices, so paging cannot shift the meaning. */
  const [selected, setSelected] = useState<string[]>([]);
  /**
   * "Select all matching" is a MODE, not 5,000 ids in component state: the
   * server resolves the filter when the action runs, so the selection cannot go
   * stale between ticking it and using it.
   */
  const [allMatching, setAllMatching] = useState(false);

  const visible = useMemo(
    () => columns.map(columnDef).filter((c): c is NonNullable<typeof c> => !!c),
    [columns],
  );

  /**
   * Rewrite the query string. Any change of shape resets to page 1.
   *
   * Deliberately NOT wrapped in startTransition. A transition defers the URL
   * update until the new server render commits, and during that window the
   * query string still described the previous table — which is how "Save as
   * view" managed to store the filter you had before the one you were looking
   * at. The URL is the table's state, so it updates first and everything else
   * follows from it.
   */
  const navigate = useCallback(
    (changes: Record<string, string | undefined>, keepPage = false) => {
      const next = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(changes)) {
        if (value === undefined) next.delete(key);
        else next.set(key, value);
      }
      if (!keepPage) next.delete("page");
      router.push(`${pathname}?${next.toString()}`, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  function toggleSort(field: SortField) {
    const direction = sort.field === field && sort.direction === "desc" ? "asc" : "desc";
    navigate({ sort: serializeSort({ field, direction }) });
  }

  function applyFilters(next: FilterSet) {
    // Changing the filter abandons any saved view being previewed: the tab is
    // no longer describing what is on screen.
    navigate({ f: serializeFilterSet(next), view: undefined });
  }

  function toggleColumn(key: string) {
    const on = columns.includes(key);
    const next = on ? columns.filter((c) => c !== key) : [...columns, key];
    navigate({ cols: serializeColumns(next) }, true);
  }

  async function research(leadId: string) {
    setError(null);
    try {
      await runResearch(leadId);
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function toContacted(leadId: string) {
    setError(null);
    const res = await moveLeadStage(leadId, "CONTACTED");
    if (!res.ok) setError(res.error);
    else router.refresh();
  }

  const filtered = filters.conditions.length > 0;
  const pageIds = rows.map((r) => r.id);
  const allOnPage = pageIds.length > 0 && pageIds.every((id) => selected.includes(id));

  function toggleRow(id: string) {
    // Ticking a row leaves the "all matching" mode: the user is now naming
    // rows, so the selection must stop meaning "everything the filter finds".
    setAllMatching(false);
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  }

  function togglePage() {
    setAllMatching(false);
    setSelected((s) =>
      allOnPage ? s.filter((id) => !pageIds.includes(id)) : [...new Set([...s, ...pageIds])],
    );
  }

  function clearSelection() {
    setSelected([]);
    setAllMatching(false);
  }

  return (
    <div>
      {error && (
        <div className="mb-3 rounded-[10px] border border-[rgba(255,92,122,0.35)] bg-[rgba(255,92,122,0.1)] px-3.5 py-2.5 text-[12.5px] text-[#FFB3C2]">
          {error}
        </div>
      )}

      <LeadViewTabs
        views={views}
        filters={filters}
        sort={sort}
        columns={columns}
        activeViewId={activeViewId}
        currentUserId={currentUserId}
        canCurate={canCurateViews}
      />

      <div className="mb-3 flex flex-wrap items-start gap-x-3 gap-y-2">
        <LeadFilterBuilder
          value={filters}
          facets={facets}
          onApply={applyFilters}
          activeCount={filters.conditions.length}
        />

        <div className="relative ml-auto flex items-center gap-2">
          <span data-testid="lead-count" className="text-[12px] text-muted">
            {filtered ? `${total} of ${totalUnfiltered}` : `${total}`} leads
          </span>
          <button
            type="button"
            onClick={() => setShowColumns((s) => !s)}
            data-testid="column-toggle"
            className="rounded-[10px] border border-line bg-panel px-3 py-1.5 text-[12.5px] hover:bg-panel-2"
          >
            Columns
          </button>
          {showColumns && (
            <div
              data-testid="column-panel"
              className="absolute right-0 top-[calc(100%+8px)] z-30 w-[240px] rounded-card border border-line bg-[#050A25] p-2 shadow-glow-lg"
            >
              {COLUMNS.map((c) => {
                const on = columns.includes(c.key);
                const required = c.key === "contact";
                return (
                  <label
                    key={c.key}
                    className={`flex items-center gap-2 rounded-[8px] px-2 py-1.5 text-[12.5px] ${
                      required ? "text-muted" : "cursor-pointer text-ink hover:bg-panel-2"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={required}
                      onChange={() => toggleColumn(c.key)}
                      className="accent-[#7427C6]"
                    />
                    {c.label}
                    {required && <span className="ml-auto text-[10.5px]">always</span>}
                  </label>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <LeadBulkBar
        ids={selected}
        allMatching={allMatching}
        filters={filters}
        matchingTotal={total}
        pageIds={pageIds}
        columns={columns}
        facets={facets}
        canDelete={canDelete}
        canExport={canExport}
        onSelectAllMatching={() => setAllMatching(true)}
        onClear={clearSelection}
      />

      <div className="overflow-x-auto rounded-card border border-line bg-panel">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className="w-8 border-b border-line px-3 py-2.5 text-left">
                <input
                  type="checkbox"
                  checked={allOnPage}
                  onChange={togglePage}
                  aria-label="Select every lead on this page"
                  data-testid="select-page"
                  className="accent-[#7427C6]"
                />
              </th>
              {visible.map((c) => (
                <th
                  key={c.key}
                  className={`border-b border-line px-3 py-2.5 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-muted ${
                    c.numeric ? "text-right" : "text-left"
                  } ${c.secondary ? "hidden nav:table-cell" : ""}`}
                >
                  {c.sortField ? (
                    <button
                      type="button"
                      onClick={() => toggleSort(c.sortField!)}
                      data-testid={`sort-${c.key}`}
                      className="inline-flex items-center gap-1 uppercase tracking-[0.1em] hover:text-ink"
                    >
                      {c.label}
                      {sort.field === c.sortField && (
                        <span aria-hidden className="text-accent-ink">
                          {sort.direction === "asc" ? "↑" : "↓"}
                        </span>
                      )}
                    </button>
                  ) : (
                    c.label
                  )}
                </th>
              ))}
              <th className="border-b border-line px-3 py-2.5 text-right text-[10.5px] font-semibold uppercase tracking-[0.1em] text-muted" />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td
                  className="px-3 py-8 text-center text-[13px] text-muted"
                  colSpan={visible.length + 2}
                >
                  {filtered ? (
                    <>
                      No lead matches this filter.{" "}
                      <button
                        type="button"
                        onClick={() => applyFilters({ match: "all", conditions: [] })}
                        className="underline hover:text-ink"
                      >
                        Clear the filter
                      </button>{" "}
                      to see all {totalUnfiltered}.
                    </>
                  ) : (
                    "No leads yet. Capture one above."
                  )}
                </td>
              </tr>
            )}
            {rows.map((l) => {
              const ready = (l.icpScore ?? 0) >= threshold;
              return (
                <tr
                  key={l.id}
                  className={`hover:[&>td]:bg-panel ${
                    allMatching || selected.includes(l.id) ? "[&>td]:bg-accent-soft/20" : ""
                  }`}
                >
                  <td className="border-b border-line px-3 py-3 align-middle">
                    <input
                      type="checkbox"
                      checked={allMatching || selected.includes(l.id)}
                      onChange={() => toggleRow(l.id)}
                      aria-label={`Select ${l.contactName ?? "lead"}`}
                      data-testid="select-row"
                      className="accent-[#7427C6]"
                    />
                  </td>
                  {visible.map((c) => (
                    <td
                      key={c.key}
                      className={`border-b border-line px-3 py-3 align-middle text-[13px] ${
                        c.numeric ? "text-right tabular-nums" : ""
                      } ${c.secondary ? "hidden nav:table-cell" : ""}`}
                    >
                      {c.key === "contact" && (
                        <span className="flex items-center gap-2">
                          <LeadAvatar name={l.contactName} path={l.avatarPath} size={28} />
                          <button
                            type="button"
                            onClick={() => setDetailFor(l.id)}
                            data-testid="lead-open-detail"
                            title="Open to edit or delete"
                            className="text-left font-bold hover:text-accent-ink hover:underline"
                          >
                            {l.contactName ?? "Unnamed contact"}
                          </button>
                          {l.riskLabel && <RiskChip label={l.riskLabel} />}
                        </span>
                      )}
                      {c.key === "company" && (
                        <span>
                          {l.company ?? "—"}
                          {l.sizeBand && (
                            <span className="block text-[11.5px] text-muted">{l.sizeBand}</span>
                          )}
                        </span>
                      )}
                      {c.key === "title" && (l.title ?? "—")}
                      {c.key === "email" && (l.email ?? "—")}
                      {c.key === "phone" && (l.phone ?? "—")}
                      {c.key === "industry" && (l.industry ?? "—")}
                      {c.key === "city" && (l.city ?? "—")}
                      {c.key === "icpScore" && (
                        <span className="whitespace-nowrap">
                          <Notches score={l.icpScore} />
                          <b className="ml-1.5">{l.icpScore ?? "—"}</b>
                        </span>
                      )}
                      {c.key === "signals" &&
                        (l.signals.length === 0 ? (
                          <span className="text-muted">—</span>
                        ) : (
                          <>
                            {l.signals.slice(0, 3).map((s, i) => (
                              <Tag key={i}>{s}</Tag>
                            ))}
                            {l.signals.length > 3 && (
                              <span className="text-[11px] text-muted">
                                +{l.signals.length - 3}
                              </span>
                            )}
                          </>
                        ))}
                      {c.key === "stage" &&
                        (l.stage === "RESEARCHED" && l.icpScore != null && !ready ? (
                          <span className="rounded-[6px] border border-dashed border-line px-1.5 py-0.5 text-[10.5px] text-muted">
                            below gate — can&apos;t contact
                          </span>
                        ) : (
                          <span className="text-[12px] text-muted">{humanEnum(l.stage)}</span>
                        ))}
                      {c.key === "source" && (
                        <span className="text-[12px] text-muted">{humanEnum(l.source)}</span>
                      )}
                      {c.key === "owner" && (
                        <span className={l.ownerName ? "" : "text-muted"}>
                          {l.ownerName ?? "unassigned"}
                        </span>
                      )}
                      {c.key === "lastActivity" && (
                        <span className="text-[12px] text-muted">
                          {relativeDays(l.lastActivityAt)}
                        </span>
                      )}
                      {c.key === "created" && (
                        <span className="text-[12px] text-muted">{relativeDays(l.createdAt)}</span>
                      )}
                    </td>
                  ))}
                  <td className="border-b border-line px-3 py-3 align-middle text-[13px]">
                    <div className="flex justify-end gap-2">
                      {l.icpScore == null ? (
                        <button
                          onClick={() => startTransition(() => research(l.id))}
                          disabled={pending}
                          className="rounded-[10px] border border-line bg-panel px-3 py-1.5 text-[12px] hover:bg-panel-2 disabled:opacity-60"
                        >
                          Run research
                        </button>
                      ) : l.stage === "RESEARCHED" ? (
                        <button
                          onClick={() => startTransition(() => toContacted(l.id))}
                          disabled={pending}
                          className="rounded-[10px] border border-line bg-panel px-3 py-1.5 text-[12px] hover:bg-panel-2 disabled:opacity-60"
                          title={ready ? "Move to Contacted" : "Blocked by the score gate"}
                        >
                          → Contacted
                        </button>
                      ) : (
                        <span className="text-[11px] text-muted">—</span>
                      )}
                      {l.companyId && (
                        <button
                          onClick={() => setEnrichFor(l.companyId)}
                          className="hidden rounded-[10px] border border-line bg-panel px-3 py-1.5 text-[12px] hover:bg-panel-2 nav:inline-block"
                        >
                          Enrich
                        </button>
                      )}
                      <button
                        onClick={() => setOverrideFor(l.id)}
                        className="rounded-[10px] border border-line bg-panel px-3 py-1.5 text-[12px] hover:bg-panel-2"
                      >
                        Override
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {pageCount > 1 && (
        <div className="mt-3 flex items-center justify-between gap-3">
          <span className="text-[12px] text-muted">
            Page {page} of {pageCount}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              data-testid="page-prev"
              disabled={page <= 1 || pending}
              onClick={() => navigate({ page: String(page - 1) }, true)}
              className="rounded-[10px] border border-line bg-panel px-3 py-1.5 text-[12.5px] hover:bg-panel-2 disabled:opacity-40"
            >
              ← Previous
            </button>
            <button
              type="button"
              data-testid="page-next"
              disabled={page >= pageCount || pending}
              onClick={() => navigate({ page: String(page + 1) }, true)}
              className="rounded-[10px] border border-line bg-panel px-3 py-1.5 text-[12.5px] hover:bg-panel-2 disabled:opacity-40"
            >
              Next →
            </button>
          </div>
        </div>
      )}

      {detailFor && <LeadDetailModal leadId={detailFor} onClose={() => setDetailFor(null)} />}
      {overrideFor && (
        <OverrideDialog
          leadId={overrideFor}
          onClose={() => setOverrideFor(null)}
          onDone={() => {
            setOverrideFor(null);
            router.refresh();
          }}
        />
      )}
      {enrichFor && (
        <EnrichDialog
          companyId={enrichFor}
          onClose={() => setEnrichFor(null)}
          onDone={() => {
            setEnrichFor(null);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}
