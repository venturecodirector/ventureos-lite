import { redirect } from "next/navigation";
import { EnrollTotp } from "@/components/enroll-totp";
import { getSecurityStatus } from "@/modules/auth/actions";
import { tryGetActiveContext } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Forced 2FA enrollment. Reached when an Owner has reset someone's second
 * factor: the old secret is gone and they cannot use the app until a new
 * authenticator is registered.
 */
export default async function EnrollTwoFactorPage() {
  if (!(await tryGetActiveContext())) redirect("/login");
  const status = await getSecurityStatus();
  // Nothing to do — don't strand anyone on a dead-end screen.
  if (!status.mustEnrollTotp || status.totpEnabled) redirect("/");

  return (
    <main className="grid min-h-screen place-items-center px-5 py-10">
      <div className="w-full max-w-[420px]">
        <div className="mb-6 text-center">
          <div className="font-display text-[26px] tracking-display">
            <b className="font-extrabold">venture</b>
            <span className="ml-1.5 font-light text-muted">os</span>
          </div>
          <h1 className="mt-3 font-display text-xl font-bold lowercase tracking-display">
            set up two-factor authentication
          </h1>
          <p className="mt-1.5 text-[12.5px] text-muted">
            An Owner reset the second factor on {status.email}. Register a new
            authenticator to continue.
          </p>
        </div>
        <EnrollTotp />
      </div>
    </main>
  );
}
