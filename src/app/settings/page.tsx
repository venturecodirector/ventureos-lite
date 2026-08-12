import { AppShell } from "@/components/app-shell";
import { SettingsGrants } from "@/components/settings-grants";
import { SecurityPanel } from "@/components/security-panel";
import { SettingsUsers } from "@/components/settings-users";
import { ProposalQueue } from "@/components/proposal-queue";
import { GdprPanel } from "@/components/gdpr-panel";
import { WorkspaceAdmin } from "@/components/workspace-admin";
import { ColdSignoff } from "@/components/cold-signoff";
import { SzamlazzKey } from "@/components/szamlazz-key";
import { getColdStatus } from "@/modules/campaigns/actions";
import { hasSzamlazzKey } from "@/modules/invoicing/actions";
import { listMembers } from "@/modules/settings/actions";
import { getSecurityStatus } from "@/modules/auth/actions";
import { listWorkspaceUsers } from "@/modules/users/actions";
import { listProposals } from "@/modules/signal/actions";
import { getRetention, listErasableLeads } from "@/modules/gdpr/actions";
import { isOwner, hasGrant } from "@/lib/authz";

export const dynamic = "force-dynamic";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ security?: string }>;
}) {
  const { security } = await searchParams;
  const [members, owner, proposals, retention, leads, canExport, coldStatus, securityStatus] =
    await Promise.all([
    listMembers(),
    isOwner(),
    listProposals(),
    getRetention(),
    listErasableLeads(),
    hasGrant("exports.run"),
    getColdStatus(),
    getSecurityStatus(),
  ]);
  // Owner-only; listWorkspaceUsers throws for anyone else, so only ask when owner.
  const managedUsers = owner ? await listWorkspaceUsers() : [];
  const szamlazzKeySet = await hasSzamlazzKey();
  return (
    <AppShell activePath="/settings">
      <div className="grid gap-4">
        <SecurityPanel status={securityStatus} focusPassword={security === "password"} />
        {owner && (
          <SettingsUsers
            users={managedUsers}
            minPasswordLength={securityStatus.minPasswordLength}
          />
        )}
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
