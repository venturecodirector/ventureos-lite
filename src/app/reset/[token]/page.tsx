import { ResetPasswordForm } from "@/components/reset-password-form";
import { inspectResetToken } from "@/modules/users/reset-tokens";

export const dynamic = "force-dynamic";

const REASON_TEXT: Record<string, string> = {
  unknown: "This reset link is not valid.",
  used: "This reset link has already been used.",
  expired: "This reset link has expired.",
};

/**
 * Consume a one-time reset link. Deliberately unauthenticated — the token IS
 * the credential, which is why it is single-use and short-lived.
 */
export default async function ResetPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const state = await inspectResetToken(token);

  return (
    <main className="grid min-h-screen place-items-center px-5 py-10">
      <div className="w-full max-w-[380px]">
        <div className="mb-6 text-center">
          <div className="font-display text-[26px] tracking-display">
            <b className="font-extrabold">venture</b>
            <span className="ml-1.5 font-light text-muted">os</span>
          </div>
          <h1 className="mt-3 font-display text-xl font-bold lowercase tracking-display">
            choose a new password
          </h1>
          {state.valid && state.email && (
            <p className="mt-1.5 text-[12.5px] text-muted">for {state.email}</p>
          )}
        </div>

        {state.valid ? (
          <ResetPasswordForm token={token} />
        ) : (
          <div className="rounded-card border border-line bg-panel p-5 text-center">
            <p className="text-[13px] text-[#FFB3C2]" data-testid="reset-invalid">
              {REASON_TEXT[state.reason] ?? "This reset link is not valid."}
            </p>
            <p className="mt-2 text-[12px] text-muted">
              Ask an Owner to issue a new one from Settings → Users.
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
