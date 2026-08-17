"use client";

import Image from "next/image";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  beginTotpEnrollment,
  confirmTotpEnrollment,
  changePassword,
  disableTotp,
  revokeOneSession,
  revokeOtherSessions,
  signOutEverywhere,
  type SecurityStatus,
} from "@/modules/auth/actions";

const CARD =
  "rounded-[14px] border border-line bg-[rgba(239,241,248,0.04)] p-4 sm:p-5";
const INPUT =
  "min-h-[44px] w-full rounded-[9px] border border-line bg-[rgba(0,5,29,0.5)] px-3 py-2.5 text-[13px] text-ink outline-none focus:border-accent";
const BTN =
  "min-h-[44px] rounded-[9px] border border-line px-3.5 py-2 text-[12.5px] font-semibold text-ink transition-colors hover:border-accent disabled:opacity-50";
const BTN_PRIMARY =
  "min-h-[44px] rounded-[9px] bg-grad px-3.5 py-2 text-[12.5px] font-semibold text-ink transition-opacity disabled:opacity-50";

function Heading({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="mb-3">
      <h3 className="font-display text-[17px] font-bold lowercase tracking-display">{title}</h3>
      <p className="mt-0.5 text-[12px] text-muted">{hint}</p>
    </div>
  );
}

function shortAgent(ua: string | null): string {
  if (!ua) return "Unknown device";
  if (/iPhone|Android/i.test(ua)) return /iPhone/i.test(ua) ? "iPhone" : "Android";
  if (/Macintosh/i.test(ua)) return "Mac";
  if (/Windows/i.test(ua)) return "Windows";
  return "Browser";
}

export function SecurityPanel({
  status,
  focusPassword,
}: {
  status: SecurityStatus;
  focusPassword: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // password
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");

  // totp enrollment
  const [enroll, setEnroll] = useState<{ secret: string; qrDataUrl: string } | null>(null);
  const [enrollCode, setEnrollCode] = useState("");

  // totp removal
  const [offPassword, setOffPassword] = useState("");
  const [offCode, setOffCode] = useState("");

  function run(fn: () => Promise<void>) {
    setMsg(null);
    startTransition(async () => {
      try {
        await fn();
      } catch (e) {
        setMsg({ kind: "err", text: (e as Error).message });
      }
    });
  }

  const others = status.activeSessions.filter((s) => !s.current);

  return (
    <div className={CARD} id="security">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-2xl font-bold lowercase tracking-display">security</h2>
        <span className="text-[12px] text-muted">{status.email}</span>
      </div>

      {msg && (
        <p
          role="status"
          className={`mb-4 rounded-[8px] border px-3 py-2 text-[12.5px] ${
            msg.kind === "ok"
              ? "border-[rgba(116,39,198,0.4)] bg-[rgba(116,39,198,0.1)] text-ink"
              : "border-[rgba(255,107,107,0.35)] bg-[rgba(255,107,107,0.08)] text-[#FF9B9B]"
          }`}
        >
          {msg.text}
        </p>
      )}

      {status.mustChangePassword && (
        <p className="mb-4 rounded-[8px] border border-[rgba(255,193,94,0.4)] bg-[rgba(255,193,94,0.09)] px-3 py-2 text-[12.5px] text-[#FFD79A]">
          Choose your own password below — this account is still on the one an
          Owner set for you.
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* ---------- password ---------- */}
        <section className="rounded-[11px] border border-line p-3.5">
          <Heading
            title="password"
            hint={`At least ${status.minPasswordLength} characters. Changing it signs out your other devices.`}
          />
          <div className="grid gap-2">
            <input
              type="password"
              autoComplete="current-password"
              placeholder="Current password"
              autoFocus={focusPassword}
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              className={INPUT}
            />
            <input
              type="password"
              autoComplete="new-password"
              placeholder="New password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className={INPUT}
            />
            <button
              type="button"
              disabled={pending || !currentPassword || !newPassword}
              className={BTN_PRIMARY}
              onClick={() =>
                run(async () => {
                  const res = await changePassword({ currentPassword, newPassword });
                  if (!res.ok) {
                    setMsg({ kind: "err", text: res.error });
                    return;
                  }
                  setCurrentPassword("");
                  setNewPassword("");
                  setMsg({
                    kind: "ok",
                    text:
                      res.revoked > 0
                        ? `Password changed. ${res.revoked} other session(s) signed out.`
                        : "Password changed.",
                  });
                  router.refresh();
                })
              }
            >
              Change password
            </button>
          </div>
        </section>

        {/* ---------- two-factor ---------- */}
        <section className="rounded-[11px] border border-line p-3.5">
          <Heading
            title="two-factor"
            hint="A 6-digit code from your phone, required at every sign-in."
          />

          {status.totpEnabled ? (
            <div className="grid gap-2">
              <p className="text-[12.5px] text-ink">
                <span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-[#5BE49B] align-middle" />
                On — codes are required to sign in.
              </p>
              <p className="text-[11.5px] text-muted">
                Turning it off needs your password and a current code.
              </p>
              <input
                type="password"
                autoComplete="current-password"
                placeholder="Password"
                value={offPassword}
                onChange={(e) => setOffPassword(e.target.value)}
                className={INPUT}
              />
              <input
                inputMode="numeric"
                maxLength={6}
                placeholder="6-digit code"
                value={offCode}
                onChange={(e) => setOffCode(e.target.value.replace(/\D/g, ""))}
                className={`${INPUT} tabular-nums`}
              />
              <button
                type="button"
                disabled={pending || !offPassword || offCode.length < 6}
                className={BTN}
                onClick={() =>
                  run(async () => {
                    const res = await disableTotp({ password: offPassword, code: offCode });
                    if (!res.ok) {
                      setMsg({ kind: "err", text: res.error });
                      return;
                    }
                    setOffPassword("");
                    setOffCode("");
                    setMsg({ kind: "ok", text: "Two-factor authentication turned off." });
                    router.refresh();
                  })
                }
              >
                Turn off two-factor
              </button>
            </div>
          ) : enroll ? (
            <div className="grid gap-3">
              <p className="text-[12.5px] text-muted">
                Scan this with Google Authenticator, 1Password or similar, then
                enter the code it shows.
              </p>
              <Image
                src={enroll.qrDataUrl}
                alt="Two-factor setup QR code"
                width={180}
                height={180}
                unoptimized
                className="rounded-[10px] bg-ink p-1.5"
              />
              <details className="text-[11.5px] text-muted">
                <summary className="cursor-pointer">Can&apos;t scan? Enter this key</summary>
                <code className="mt-1.5 block break-all rounded-[6px] bg-[rgba(0,5,29,0.5)] p-2 text-[11px] text-ink">
                  {enroll.secret}
                </code>
              </details>
              <input
                inputMode="numeric"
                maxLength={6}
                placeholder="6-digit code"
                value={enrollCode}
                onChange={(e) => setEnrollCode(e.target.value.replace(/\D/g, ""))}
                className={`${INPUT} tabular-nums`}
                data-testid="totp-enroll-code"
              />
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={pending || enrollCode.length < 6}
                  className={BTN_PRIMARY}
                  onClick={() =>
                    run(async () => {
                      const res = await confirmTotpEnrollment({ code: enrollCode });
                      if (!res.ok) {
                        setMsg({ kind: "err", text: res.error });
                        return;
                      }
                      setEnroll(null);
                      setEnrollCode("");
                      setMsg({ kind: "ok", text: "Two-factor authentication is on." });
                      router.refresh();
                    })
                  }
                >
                  Confirm
                </button>
                <button type="button" className={BTN} onClick={() => setEnroll(null)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="grid gap-2">
              <p className="text-[12.5px] text-muted">
                <span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-[#FFC15E] align-middle" />
                Off — your account is protected by a password only.
              </p>
              <button
                type="button"
                disabled={pending}
                className={BTN_PRIMARY}
                onClick={() =>
                  run(async () => {
                    setEnroll(await beginTotpEnrollment());
                  })
                }
              >
                Set up two-factor
              </button>
            </div>
          )}
        </section>
      </div>

      {/* ---------- sessions ---------- */}
      <section className="mt-4 rounded-[11px] border border-line p-3.5">
        <Heading
          title="signed-in devices"
          hint="A session ends after 30 days, or after 7 days without use — whichever comes first."
        />
        <ul className="grid gap-1.5" data-testid="session-list">
          {status.activeSessions.map((s) => (
            <li
              key={s.id}
              data-testid="session-row"
              className={`flex flex-wrap items-center justify-between gap-2 rounded-[8px] border px-3 py-2 text-[12.5px] ${
                s.current ? "border-accent bg-accent-soft" : "border-line"
              }`}
            >
              <span className="text-ink">
                {s.device}
                {s.current && (
                  <span className="ml-2 rounded-[5px] border border-line px-1.5 py-px text-[10px] uppercase tracking-[0.1em] text-accent-ink">
                    this device
                  </span>
                )}
                <span className="block text-[11px] text-muted">{shortAgent(s.userAgent)}</span>
              </span>
              <span className="flex items-center gap-2">
                <span className="tabular-nums text-muted">
                  {s.ip ?? "—"} ·{" "}
                  {new Date(s.lastSeenAt).toISOString().slice(0, 16).replace("T", " ")}
                </span>
                {!s.current && (
                  <button
                    type="button"
                    disabled={pending}
                    data-testid="session-revoke"
                    className={BTN}
                    onClick={() =>
                      run(async () => {
                        const res = await revokeOneSession(s.id);
                        setMsg(
                          res.ok
                            ? { kind: "ok", text: "That device was signed out." }
                            : { kind: "err", text: res.error },
                        );
                        router.refresh();
                      })
                    }
                  >
                    Revoke
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={pending || others.length === 0}
            className={BTN}
            onClick={() =>
              run(async () => {
                const res = await revokeOtherSessions();
                setMsg({ kind: "ok", text: `Signed out ${res.revoked} other session(s).` });
                router.refresh();
              })
            }
          >
            Sign out other devices{others.length > 0 ? ` (${others.length})` : ""}
          </button>
          <button
            type="button"
            disabled={pending}
            className={BTN}
            onClick={() => run(async () => void (await signOutEverywhere()))}
          >
            Sign out
          </button>
        </div>
      </section>
    </div>
  );
}
