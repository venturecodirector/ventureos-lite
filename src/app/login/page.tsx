import { redirect } from "next/navigation";
import { LoginForm } from "@/components/login-form";
import { tryGetActiveContext } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Only same-origin app paths are accepted, so ?next= cannot be an open redirect. */
function safeNext(raw: string | undefined): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/";
  if (raw.startsWith("/login")) return "/";
  return raw;
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  const target = safeNext(next);

  // Already signed in — don't show a login form to an authenticated user.
  if (await tryGetActiveContext()) redirect(target);

  return (
    <main className="grid min-h-screen place-items-center px-5 py-10">
      <div className="flex w-full max-w-[360px] flex-col items-center">
        <div className="mb-7 text-center">
          <div className="font-display text-[30px] tracking-display">
            <b className="font-extrabold">venture</b>
            <span className="ml-1.5 font-light text-muted">os</span>
          </div>
          <p className="mt-1.5 text-[12.5px] text-muted">Sign in to continue</p>
        </div>

        <LoginForm next={target} />

        <p className="mt-7 max-w-[300px] text-center text-[11.5px] leading-relaxed text-muted">
          Accounts are created by an Owner in Settings. If you cannot get in, ask
          them to reset your password.
        </p>
      </div>
    </main>
  );
}
