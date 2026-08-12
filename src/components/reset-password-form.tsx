"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { consumeResetToken } from "@/modules/users/reset-tokens";

export function ResetPasswordForm({ token }: { token: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const FIELD =
    "w-full rounded-[9px] border border-line bg-[rgba(0,5,29,0.6)] px-3 py-3 text-[14px] text-ink outline-none focus:border-accent";

  if (done) {
    return (
      <div className="rounded-card border border-line bg-panel p-5 text-center">
        <p className="text-[13px] text-[#8CEFC0]" data-testid="reset-done">
          Password set. You can sign in now.
        </p>
        <button
          type="button"
          onClick={() => router.replace("/login")}
          className="mt-3 min-h-[44px] w-full rounded-[10px] bg-grad px-4 py-3 text-[14px] font-semibold text-ink shadow-glow"
        >
          Go to sign in
        </button>
      </div>
    );
  }

  return (
    <form
      className="grid gap-3 rounded-card border border-line bg-panel p-5"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        if (password !== confirm) {
          setError("The two passwords do not match.");
          return;
        }
        startTransition(async () => {
          const res = await consumeResetToken({ token, password });
          if (!res.ok) {
            setError(res.error);
            return;
          }
          setDone(true);
        });
      }}
    >
      <input
        type="password"
        autoComplete="new-password"
        placeholder="New password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
        autoFocus
        data-testid="reset-password"
        className={FIELD}
      />
      <input
        type="password"
        autoComplete="new-password"
        placeholder="Repeat it"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        required
        data-testid="reset-confirm"
        className={FIELD}
      />
      {error && (
        <p role="alert" data-testid="reset-error" className="rounded-[8px] border border-[rgba(255,92,122,0.35)] bg-[rgba(255,92,122,0.08)] px-3 py-2 text-[12.5px] text-[#FFB3C2]">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={pending || !password || !confirm}
        data-testid="reset-submit"
        className="min-h-[44px] rounded-[10px] bg-grad px-4 py-3 text-[14px] font-semibold text-ink shadow-glow disabled:opacity-60"
      >
        {pending ? "Setting…" : "Set password"}
      </button>
    </form>
  );
}
