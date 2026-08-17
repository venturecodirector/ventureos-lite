import { AppShell } from "@/components/app-shell";
import { SettingsGrants } from "@/components/settings-grants";
import { SecurityPanel } from "@/components/security-panel";
import { SettingsUsers } from "@/components/settings-users";
import { SettingsIntegrations } from "@/components/settings-integrations";
import { ApiCosts } from "@/components/api-costs";
import { SettingsEmail } from "@/components/settings-email";
import { SettingsNotifications } from "@/components/settings-notifications";
import { SettingsHealthRules } from "@/components/settings-health-rules";
import { SettingsBranding } from "@/components/settings-branding";
import { SettingsFields } from "@/components/settings-fields";
import { SettingsDataQuality } from "@/components/settings-data-quality";
import { SettingsWorkflows } from "@/components/settings-workflows";
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
import { getNotificationPreferences } from "@/modules/notifications/preference-actions";
import { getHealthRules } from "@/modules/revenue/health-actions";
import { getWorkspaceBrand } from "@/modules/workspaces/brand-actions";
import { listFieldDefs } from "@/modules/fields/store";
import { getDataQuality } from "@/modules/merge/actions";
import { getWorkflows } from "@/modules/workflow/actions";
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
  // Also personal — what reaches ME, and how (P6/1).
  const notificationPrefs = await getNotificationPreferences();
  // Workspace-wide, Owner-edited: the thresholds decide who lands on a list the
  // whole team works from (P11/1c).
  const healthRules = await getHealthRules();
  // Workspace-wide letterhead (audit-v2 item 6).
  const brand = await getWorkspaceBrand();
  // Owner-defined fields (P5/1). Read for everyone — a BDR needs to see what
  // the workspace's fields ARE even though only an Owner may change them.
  const customFields = await listFieldDefs(workspaceId);
  const canManageFields = await hasGrant("fields.manage");
  // Duplicates and merge history (P5/2). Read by everyone; merging is gated.
  const dataQuality = await getDataQuality();
  // Automation rules (P7/5). Read by everyone so a BDR can see what fires on
  // their leads; only an Owner may change them.
  const workflows = await getWorkflows();
  // Version only — the zip itself is built on demand by the download route.
  const extensionVersion = (await buildExtensionPackage()).version;
  return (
    <AppShell activePath="/settings">
      <div className="grid gap-4">
        <SecurityPanel status={securityStatus} focusPassword={security === "password"} />
        <SettingsNotifications initial={notificationPrefs} />
        <SettingsBranding initial={brand} isOwner={owner} />
        <SettingsFields defs={customFields} canManage={canManageFields} />
        <SettingsDataQuality view={dataQuality} />
        <SettingsWorkflows view={workflows} />
        <SettingsHealthRules initial={healthRules} isOwner={owner} />
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
