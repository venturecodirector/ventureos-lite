import { AppShell } from "@/components/app-shell";
import Link from "next/link";
import { SettingsProfile } from "@/components/settings-profile";
import { SecurityPanel } from "@/components/security-panel";
import { SettingsNotifications } from "@/components/settings-notifications";
import { SettingsExtension } from "@/components/settings-extension";
import { SettingsEmail } from "@/components/settings-email";
import { getSecurityStatus } from "@/modules/auth/actions";
import { getNotificationPreferences } from "@/modules/notifications/preference-actions";
import { listCaptureTokens } from "@/modules/capture/actions";
import { buildExtensionPackage } from "@/modules/extension/package";
import { getMyProfile } from "@/modules/users/profile";
import { isSuperAdmin } from "@/lib/authz";

/**
 * Settings — YOURS.
 *
 * "A settings oldal szedd ketté: a settings maradjon a saját profil beállításai,
 * plusz tegyél ide profilkép feltöltési lehetőséget."
 *
 * This page was sixteen panels long and mixed four unrelated things: who you
 * are, what reaches you, how the workspace behaves, and how the installation is
 * configured. What is left here is the first two — everything that is about the
 * person signed in:
 *
 *   profile         name, photo, which workspaces they are in
 *   security        password, 2FA, active sessions
 *   notifications   what reaches ME, and how
 *   extension       MY capture tokens — one per browser, per person
 *
 * Everything else moved to /settings/admin.
 */
export const dynamic = "force-dynamic";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ security?: string }>;
}) {
  const { security } = await searchParams;
  const [profile, securityStatus, notificationPrefs, captureTokens, superAdmin] =
    await Promise.all([
      getMyProfile(),
      getSecurityStatus(),
      getNotificationPreferences(),
      listCaptureTokens(),
      isSuperAdmin(),
    ]);
  const extensionVersion = (await buildExtensionPackage()).version;

  return (
    <AppShell activePath="/settings">
      <div className="grid gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-display text-2xl font-bold lowercase tracking-display">
              settings
            </h2>
            <p className="mt-0.5 text-[12.5px] text-muted">
              Your profile, your sign-in, and what reaches you.
            </p>
          </div>
          {superAdmin && (
            <Link
              href="/settings/admin"
              data-testid="settings-admin-link"
              className="min-h-[40px] rounded-[9px] border border-line bg-panel px-3.5 py-2 text-[12.5px] font-semibold text-ink hover:border-accent"
            >
              Admin settings →
            </Link>
          )}
        </div>

        <SettingsProfile profile={profile} />
        <SecurityPanel status={securityStatus} focusPassword={security === "password"} />
        {/*
          The mailbox is YOURS (playbook-v2 P2b: "OAuth connect/disconnect in
          Settings → Email per user"). It sat on /settings/admin after the
          settings split, which on a one-person installation looked fine and
          would have meant a second user could never connect their own mail at
          all — the page 404s for anyone but the super admin.
        */}
        <SettingsEmail />
        <SettingsNotifications initial={notificationPrefs} />
        <SettingsExtension tokens={captureTokens} version={extensionVersion} />
      </div>
    </AppShell>
  );
}
