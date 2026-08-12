"use client";

import Image from "next/image";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { beginTotpEnrollment, confirmTotpEnrollment } from "@/modules/auth/actions";

/** Standalone enrollment used by the forced re-enrollment screen. */
export function EnrollTotp() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [enroll, setEnroll] = useState<{ secret: string; qrDataUrl: string } | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  // The QR is the whole point of this screen — fetch it immediately.
  useEffect(() => {
    beginTotpEnrollment()
      .then(setEnroll)
      .catch((e: Error) => setError(e.message));
  }, []);

  const INPUT =
    "w-full rounded-[9px] border border-line bg-[rgba(0,5,29,0.6)] px-3 py-3 text-center text-[20px] tracking-[0.4em] tabular-nums text-ink outline-none focus:border-accent";

  return (
    <div className="rounded-card border border-line bg-panel p-5">
      {error && (
        <p role="alert" data-testid="enroll-error" className="mb-3 rounded-[8px] border border-[rgba(255,92,122,0.35)] bg-[rgba(255,92,122,0.08)] px-3 py-2 text-[12.5px] text-[#FFB3C2]">
          {error}
        </p>
      )}

      {enroll ? (
        <div className="grid justify-items-center gap-3">
          <Image
            src={enroll.qrDataUrl}
            alt="Two-factor setup QR code"
            width={200}
            height={200}
            unoptimized
            className="rounded-[10px] bg-ink p-1.5"
            data-testid="enroll-qr"
          />
          <details className="w-full text-[11.5px] text-muted">
            <summary className="cursor-pointer">Can&apos;t scan? Enter this key</summary>
            <code className="mt-1.5 block break-all rounded-[6px] bg-[rgba(0,5,29,0.5)] p-2 text-[11px] text-ink">
              {enroll.secret}
            </code>
          </details>
          <input
            inputMode="numeric"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            placeholder="000000"
            data-testid="enroll-code"
            className={INPUT}
          />
          <button
            type="button"
            disabled={pending || code.length < 6}
            data-testid="enroll-confirm"
            className="min-h-[44px] w-full rounded-[10px] bg-grad px-4 py-3 text-[14px] font-semibold text-ink shadow-glow disabled:opacity-60"
            onClick={() =>
              startTransition(async () => {
                setError(null);
                const res = await confirmTotpEnrollment({ code });
                if (!res.ok) {
                  setError(res.error);
                  setCode("");
                  return;
                }
                router.replace("/");
                router.refresh();
              })
            }
          >
            {pending ? "Verifying…" : "Confirm and continue"}
          </button>
        </div>
      ) : (
        !error && <p className="text-[12.5px] text-muted">Preparing your QR code…</p>
      )}
    </div>
  );
}
