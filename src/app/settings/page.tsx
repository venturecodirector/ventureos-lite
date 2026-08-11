import { AppShell } from "@/components/app-shell";
import { SettingsGrants } from "@/components/settings-grants";
import { ProposalQueue } from "@/components/proposal-queue";
import { GdprPanel } from "@/components/gdpr-panel";
import { WorkspaceAdmin } from "@/components/workspace-admin";
import { ColdSignoff } from "@/components/cold-signoff";
import { SzamlazzKey } from "@/components/szamlazz-key";
import { getColdStatus } from "@/modules/campaigns/actions";
import { hasSzamlazzKey } from "@/modules/invoicing/actions";
import { listMembers } from "@/modules/settings/actions";
import { listProposals } from "@/modules/signal/actions";
import { getRetention, listErasableLeads } from "@/modules/gdpr/actions";
import { isOwner, hasGrant } from "@/lib/authz";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const [members, owner, proposals, retention, leads, canExport, coldStatus] = await Promise.all([
    listMembers(),
    isOwner(),
    listProposals(),
    getRetention(),
    listErasableLeads(),
    hasGrant("exports.run"),
    getColdStatus(),
  ]);
  const szamlazzKeySet = await hasSzamlazzKey();
  return (
    <AppShell activePath="/settings">
      <div className="grid gap-4">
        <WorkspaceAdmin isOwner={owner} />
        <ColdSignoff status={coldStatus} isOwner={owner} />
        <SzamlazzKey hasKey={szamlazzKeySet} isOwner={owner} />
        <ProposalQueue proposals={proposals} isOwner={owner} />
        <SettingsGrants members={members} isOwner={owner} />
        <GdprPanel retention={retention} leads={leads} isOwner={owner} canExport={canExport} />
      </div>
    </AppShell>
  );
}
