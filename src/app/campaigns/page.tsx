import { AppShell } from "@/components/app-shell";
import { Campaigns } from "@/components/campaigns";
import { getColdStatus, listCampaigns } from "@/modules/campaigns/actions";

export const dynamic = "force-dynamic";

export default async function CampaignsPage() {
  const status = await getColdStatus();
  const campaigns = status.allowed ? await listCampaigns() : [];
  return (
    <AppShell activePath="/campaigns">
      <Campaigns status={status} campaigns={campaigns} />
    </AppShell>
  );
}
