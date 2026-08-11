import { AppShell } from "@/components/app-shell";
import { Analytics } from "@/components/analytics";
import { getAnalytics } from "@/modules/analytics/actions";

export const dynamic = "force-dynamic";

export default async function AnalyticsPage() {
  const view = await getAnalytics();
  return (
    <AppShell activePath="/analytics">
      <Analytics view={view} />
    </AppShell>
  );
}
