"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  issueCaptureToken,
  revokeCaptureToken,
  type CaptureTokenRow,
} from "@/modules/capture/actions";

/**
 * Settings → Extension (P1/1e). Personal capture tokens for the browser
 * extension. Shown once at creation — we store only a hash, so there is no
 * "show again".
 */
export function SettingsExtension({ tokens }: { tokens: CaptureTokenRow[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [label, setLabel] = useState("");
  const [issued, setIssued] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  function issue() {
    startTransition(async () => {
      const { token } = await issueCaptureToken({ label: label.trim() || undefined });
      setIssued(token);
      setCopied(false);
      setLabel("");
      router.refresh();
    });
  }

  return (
    <div className="rounded-card border border-line bg-panel p-[18px]">
      <div className="mb-2.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
        Browser extension
      </div>
      <p className="mb-3 text-[12.5px] text-muted">
        The capture extension signs in with a personal token, not your session —
        it runs on linkedin.com, where a cookie for this site is never sent.
        Create one per browser; revoke it if a machine is lost.
      </p>

      {issued && (
        <div
          className="mb-3 rounded-[10px] border border-accent-soft bg-accent-soft p-3.5"
          data-testid="issued-token"
        >
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-accent-ink">
            Copy it now — it is not shown again
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <code className="flex-1 break-all rounded-[8px] border border-line bg-[rgba(0,5,29,0.5)] px-2.5 py-1.5 text-[12px] text-ink">
              {issued}
            </code>
            <button
              onClick={async () => {
                await navigator.clipboard.writeText(issued);
                setCopied(true);
              }}
              className="rounded-[10px] border border-line bg-panel px-3 py-1.5 text-[12px] hover:bg-panel-2"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      )}

      <div className="mb-3 flex flex-wrap gap-2">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Which browser? e.g. work laptop"
          className="min-w-[180px] flex-1 rounded-[10px] border border-line bg-[rgba(0,5,29,0.5)] px-3 py-2 text-[13px] text-ink outline-none focus:border-accent"
        />
        <button
          onClick={issue}
          disabled={pending}
          data-testid="issue-capture-token"
          className="rounded-[10px] border-[1.5px] border-transparent bg-canvas px-4 py-2 text-[13px] font-semibold text-ink shadow-glow [background-clip:padding-box,border-box] [background-image:linear-gradient(#00051D,#00051D),linear-gradient(135deg,#310B59,#7427C6)] [background-origin:border-box] disabled:opacity-60"
        >
          {pending ? "Creating…" : "Create token"}
        </button>
      </div>

      {tokens.length === 0 ? (
        <p className="text-[12px] text-muted">No tokens yet.</p>
      ) : (
        <ul className="grid gap-1.5">
          {tokens.map((t) => (
            <li
              key={t.id}
              className="flex flex-wrap items-center gap-2 rounded-[10px] border border-line bg-panel-2 px-3 py-2 text-[12.5px]"
            >
              <b>{t.label ?? "Unlabelled"}</b>
              <span className="text-muted">
                {t.lastUsedAt ? `last used ${t.lastUsedAt.slice(0, 10)}` : "never used"}
              </span>
              <button
                onClick={() => {
                  if (!confirm("Revoke this token? The browser using it stops capturing.")) return;
                  startTransition(async () => {
                    await revokeCaptureToken({ id: t.id });
                    router.refresh();
                  });
                }}
                className="ml-auto rounded-[8px] border border-line px-2.5 py-1 text-[11.5px] text-[#FF8FA5] hover:border-[rgba(255,92,122,0.5)]"
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
