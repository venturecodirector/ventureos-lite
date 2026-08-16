import { AppShell } from "@/components/app-shell";
import { LeadEngine } from "@/components/lead-engine";
import { LeadsTable } from "@/components/leads-table";
import { prismaUnsafe } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { hasGrant, isOwner } from "@/lib/authz";
import { loadLeadsTable } from "@/modules/leads/table";
import { listViews } from "@/modules/leads/view-store";
import { parseColumns, parseFilterSet, parseSort } from "@/modules/leads/view-params";

// Reads tenant data per request — never statically cached.
export const dynamic = "force-dynamic";

/**
 * The table's whole state lives in the query string (playbook-v2 P3/2): `f`
 * carries the filter set, `sort`, `cols` and `page` the rest. That is what
 * makes a filtered table linkable and refresh-proof — and it is why a saved
 * view can be stored as data rather than as session state.
 *
 * Every parser here is total: a hand-edited or stale parameter degrades to the
 * default instead of throwing, because a page render must never 500 over a
 * query string.
 */
function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId, userId } = await getActiveContext();
  const params = await searchParams;

  const filters = parseFilterSet(first(params.f));
  const sort = parseSort(first(params.sort));
  const columns = parseColumns(first(params.cols));
  const page = Number(first(params.page) ?? 1);

  const [data, views, membership, owner, exporter] = await Promise.all([
    loadLeadsTable(workspaceId, { filters, sort, page }),
    listViews(workspaceId, userId),
    prismaUnsafe.membership.findUnique({
      where: { userId_workspaceId: { userId, workspaceId } },
      select: { role: true },
    }),
    isOwner(),
    hasGrant("exports.run"),
  ]);
  const canCurateViews = membership?.role === "OWNER" || membership?.role === "ADMIN";

  return (
    <AppShell activePath="/leads">
      <LeadEngine
        threshold={data.threshold}
        table={
          <LeadsTable
            rows={data.rows}
            columns={columns}
            sort={sort}
            filters={filters}
            facets={data.facets}
            threshold={data.threshold}
            page={data.page}
            pageCount={data.pageCount}
            total={data.total}
            totalUnfiltered={data.totalUnfiltered}
            views={views}
            activeViewId={first(params.view) ?? null}
            currentUserId={userId}
            canCurateViews={canCurateViews}
            canDelete={owner}
            canExport={exporter}
          />
        }
      />
    </AppShell>
  );
}
