import { AppShell } from "@/components/app-shell";
import { Analytics } from "@/components/analytics";
import { AnalyticsTabs } from "@/components/analytics-tabs";
import { RevenueTab } from "@/components/revenue-tab";
import { getAnalytics } from "@/modules/analytics/actions";
import { loadRevenue } from "@/modules/revenue/dashboard";
import { getActiveContext } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Analytics, now with two surfaces (playbook-v3 P11/1b).
 *
 * Only the chosen tab's data is loaded: the Revenue tab reads the whole
 * subscription event log, and there is no reason to pay for that when someone
 * opened the funnel.
 */
export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab } = await searchParams;
  const active = tab === "revenue" ? "revenue" : "performance";

  if (active === "revenue") {
    const { workspaceId } = await getActiveContext();
    const view = await loadRevenue(workspaceId);
    return (
      <AppShell activePath="/analytics">
        <div className="mx-auto w-full max-w-[1400px]">
          <AnalyticsTabs active={active} />
          <RevenueTab view={view} />
        </div>
      </AppShell>
    );
  }

  const view = await getAnalytics();
  return (
    <AppShell activePath="/analytics">
      <div className="mx-auto w-full max-w-[1400px]">
        <AnalyticsTabs active={active} />
      </div>
      <Analytics view={view} />
    </AppShell>
  );
}
