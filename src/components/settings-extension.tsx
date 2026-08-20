"use client";
import { attemptVoid, attempt } from "@/lib/client/server-action";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  issueCaptureToken,
  revokeCaptureToken,
  type CaptureTokenRow,
} from "@/modules/capture/actions";
import { extensionPresence, configureExtension } from "@/lib/extension-bridge";

/**
 * Settings → Extension (P1/1e). Personal capture tokens for the browser
 * extension. Shown once at creation — we store only a hash, so there is no
 * "show again".
 */
export function SettingsExtension({
  tokens,
  version,
}: {
  tokens: CaptureTokenRow[];
  version: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [label, setLabel] = useState("");
  const [issued, setIssued] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  /** Set when the token was handed straight to the extension. */
  const [connected, setConnected] = useState<string | null>(null);
  /** This panel had nowhere at all to report a failure. */
  const [error, setError] = useState<string | null>(null);

  function issue() {
    setError(null);
    startTransition(async () => {
      const res = await attempt(
        issueCaptureToken({ label: label.trim() || undefined }).then((r) => ({
          ok: true as const,
          ...r,
        })),
      );
      if (!res.ok) {
        setError(res.error);
        return;
      }
      const token = res.token;
      setIssued(token);

      // If the extension is here, hand it the token directly. Copying a token by
      // hand is what made people re-enter it after every reinstall — and a
      // token that is never displayed is a token that cannot be pasted into the
      // wrong window.
      const presence = await extensionPresence();
      if (presence.present) {
        const res = await configureExtension(window.location.origin, token);
        setConnected(
          res.ok
            ? "Sent to the extension in this browser — nothing to copy."
            : `Extension found but refused the token (${res.error ?? "unknown"}).`,
        );
      }
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
      {error && (
        <p
          role="alert"
          data-testid="extension-error"
          className="mb-3 rounded-[8px] border border-[rgba(255,92,122,0.35)] bg-[rgba(255,92,122,0.08)] px-3 py-2 text-[12.5px] text-[#FFB3C2]"
        >
          {error}
        </p>
      )}
      <p className="mb-3 text-[12.5px] text-muted">
        The capture extension signs in with a personal token, not your session —
        it runs on linkedin.com, where a cookie for this site is never sent.
        Create one per browser; revoke it if a machine is lost.
      </p>

      <div className="mb-4 rounded-[10px] border border-line bg-panel-2 p-3.5">
        <div className="flex flex-wrap items-center gap-2.5">
          <a
            href="/api/extension/download"
            data-testid="download-extension"
            className="rounded-[10px] border-[1.5px] border-transparent bg-canvas px-4 py-2 text-[13px] font-semibold text-ink shadow-glow [background-clip:padding-box,border-box] [background-image:linear-gradient(#00051D,#00051D),linear-gradient(135deg,#310B59,#7427C6)] [background-origin:border-box]"
          >
            Download extension ↓
          </a>
          <span className="text-[11.5px] text-muted">
            v{version} · Chrome, Edge, Brave · packaged from this deployment
          </span>
        </div>
        <ol className="mt-3 grid gap-1 pl-4 text-[12px] text-muted [list-style:decimal]">
          <li>Unzip it somewhere permanent — Chrome loads it from that folder.</li>
          <li>
            Open <code className="text-[#C9CEE3]">chrome://extensions</code>, turn on
            Developer mode, choose <b>Load unpacked</b>, pick the folder.
          </li>
          <li>Create a token below and paste it into the extension, with this site&apos;s address.</li>
        </ol>
        <p className="mt-2 text-[11.5px] text-muted">
          Developer mode is required because the extension is distributed by us
          rather than through the Chrome Web Store. Chrome refuses to install
          self-hosted packages any other way.
        </p>
      </div>

      {issued && (
        <div
          className="mb-3 rounded-[10px] border border-accent-soft bg-accent-soft p-3.5"
          data-testid="issued-token"
        >
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-accent-ink">
            {connected ? "Sent to this browser's extension" : "Copy it now — it is not shown again"}
          </div>
          {connected && (
            <p className="mb-2 text-[12px] leading-relaxed text-[#C9CEE3]" data-testid="extension-connected">
              {connected} Keep the token below only if you also use the extension in
              another browser.
            </p>
          )}
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
                    /**
                     * The most important one in this file to not fail silently:
                     * a revoked token is a security action, and believing a
                     * browser has been cut off when it has not is worse than
                     * being told the revoke did not work.
                     */
                    const failed = await attemptVoid(revokeCaptureToken({ id: t.id }));
                    if (failed) {
                      setError(failed);
                      return;
                    }
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
