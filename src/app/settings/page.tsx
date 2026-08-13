import { AppShell } from "@/components/app-shell";
import { SettingsGrants } from "@/components/settings-grants";
import { SecurityPanel } from "@/components/security-panel";
import { SettingsUsers } from "@/components/settings-users";
import { SettingsIntegrations } from "@/components/settings-integrations";
import { ApiCosts } from "@/components/api-costs";
import { SettingsEmail } from "@/components/settings-email";
import { SettingsExtension } from "@/components/settings-extension";
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
import { getIntegrations } from "@/modules/integrations/actions";
import { listCaptureTokens } from "@/modules/capture/actions";
import { buildExtensionPackage } from "@/modules/extension/package";
import { listProposals } from "@/modules/signal/actions";
import { getRetention, listErasableLeads } from "@/modules/gdpr/actions";
import { isOwner, hasGrant } from "@/lib/authz";
import { getApiCostReport } from "@/lib/api-usage";
import { getActiveContext } from "@/lib/session";

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
  const integrations = owner ? await getIntegrations() : null;
  const szamlazzKeySet = await hasSzamlazzKey();
  // Sits directly under Integrations: the keys are configured there, and what
  // they cost belongs next to them.
  const { workspaceId } = await getActiveContext();
  const apiCosts = owner ? await getApiCostReport(workspaceId) : null;
  // Personal, not workspace-wide: every user manages their own extension tokens.
  const captureTokens = await listCaptureTokens();
  // Version only — the zip itself is built on demand by the download route.
  const extensionVersion = (await buildExtensionPackage()).version;
  return (
    <AppShell activePath="/settings">
      <div className="grid gap-4">
        <SecurityPanel status={securityStatus} focusPassword={security === "password"} />
        <SettingsExtension tokens={captureTokens} version={extensionVersion} />
        {owner && (
          <SettingsUsers
            users={managedUsers}
            minPasswordLength={securityStatus.minPasswordLength}
          />
        )}
        {integrations && <SettingsIntegrations data={integrations} />}
        {apiCosts && <ApiCosts report={apiCosts} />}
        <SettingsEmail />
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
