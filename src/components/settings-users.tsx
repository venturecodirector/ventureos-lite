"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  createPasswordResetLink,
  resetUserTotp,
  revokeUserSessions,
  setUserPassword,
  unlockUser,
  updateUserIdentity,
} from "@/modules/users/actions";
import type { ManagedUser } from "@/modules/users/actions";
import { Modal } from "./modal";

const CARD = "rounded-[14px] border border-line bg-[rgba(239,241,248,0.04)] p-4 sm:p-5";
const BTN =
  "min-h-[36px] rounded-[8px] border border-line px-2.5 py-1.5 text-[11.5px] font-semibold text-ink transition-colors hover:border-accent disabled:opacity-45";
const BTN_PRIMARY =
  "min-h-[40px] rounded-[9px] bg-grad px-3.5 py-2 text-[12.5px] font-semibold text-ink disabled:opacity-45";
const INPUT =
  "w-full rounded-[9px] border border-line bg-[rgba(0,5,29,0.5)] px-3 py-2 text-[13px] text-ink outline-none focus:border-accent";

type Msg = { kind: "ok" | "err"; text: string } | null;

export function SettingsUsers({
  users,
  minPasswordLength,
}: {
  users: ManagedUser[];
  minPasswordLength: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<Msg>(null);
  const [editing, setEditing] = useState<ManagedUser | null>(null);
  const [resetLink, setResetLink] = useState<{ user: string; url: string; expiresAt: string } | null>(
    null,
  );

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, okText: string) {
    setMsg(null);
    startTransition(async () => {
      const res = await fn();
      setMsg(res.ok ? { kind: "ok", text: okText } : { kind: "err", text: res.error ?? "Failed." });
      router.refresh();
    });
  }

  function confirmThen(question: string, fn: () => void) {
    // A browser confirm is the right weight here: these are destructive,
    // Owner-only actions that sign someone out.
    if (window.confirm(question)) fn();
  }

  return (
    <div className={CARD} id="users">
      <div className="mb-4">
        <h2 className="font-display text-2xl font-bold lowercase tracking-display">users</h2>
        <p className="mt-0.5 text-[12px] text-muted">
          Owner-only. Every change here is written to the audit log, and anything
          that changes how someone signs in also signs them out.
        </p>
      </div>

      {msg && (
        <p
          role="status"
          data-testid="users-message"
          className={`mb-4 rounded-[8px] border px-3 py-2 text-[12.5px] ${
            msg.kind === "ok"
              ? "border-[rgba(61,220,151,0.35)] bg-[rgba(61,220,151,0.08)] text-[#8CEFC0]"
              : "border-[rgba(255,92,122,0.35)] bg-[rgba(255,92,122,0.08)] text-[#FFB3C2]"
          }`}
        >
          {msg.text}
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] border-collapse text-[12.5px]">
          <thead>
            <tr className="border-b border-line text-left text-[10.5px] uppercase tracking-[0.1em] text-muted">
              <th className="px-2 py-1.5 font-semibold">User</th>
              <th className="px-2 py-1.5 font-semibold">Role</th>
              <th className="px-2 py-1.5 font-semibold">Sign-in</th>
              <th className="px-2 py-1.5 font-semibold">Sessions</th>
              <th className="px-2 py-1.5" />
            </tr>
          </thead>
          <tbody data-testid="users-table">
            {users.map((u) => (
              <tr key={u.userId} className="border-b border-line last:border-0">
                <td className="px-2 py-2.5">
                  <span className="block text-ink">
                    {u.name}
                    {u.isSelf && <span className="ml-1.5 text-[11px] text-muted">(you)</span>}
                  </span>
                  <span className="block text-[11.5px] text-muted">{u.email}</span>
                </td>
                <td className="px-2 py-2.5 text-muted">{u.role}</td>
                <td className="px-2 py-2.5">
                  <span className="flex flex-wrap gap-1.5">
                    {!u.hasPassword && (
                      <span className="rounded-[5px] bg-[rgba(245,184,65,0.15)] px-1.5 py-px text-[10px] text-[#FFD79A]">
                        no password
                      </span>
                    )}
                    {u.mustChangePassword && (
                      <span className="rounded-[5px] bg-panel-2 px-1.5 py-px text-[10px] text-muted">
                        must change
                      </span>
                    )}
                    {u.totpEnabled ? (
                      <span className="rounded-[5px] bg-[rgba(61,220,151,0.15)] px-1.5 py-px text-[10px] text-[#8CEFC0]">
                        2FA on
                      </span>
                    ) : u.mustEnrollTotp ? (
                      <span className="rounded-[5px] bg-[rgba(245,184,65,0.15)] px-1.5 py-px text-[10px] text-[#FFD79A]">
                        must enroll 2FA
                      </span>
                    ) : (
                      <span className="rounded-[5px] bg-panel-2 px-1.5 py-px text-[10px] text-muted">
                        2FA off
                      </span>
                    )}
                    {u.lockedUntil && new Date(u.lockedUntil) > new Date() && (
                      <span className="rounded-[5px] bg-[rgba(255,92,122,0.15)] px-1.5 py-px text-[10px] text-[#FFB3C2]">
                        locked
                      </span>
                    )}
                  </span>
                </td>
                <td className="px-2 py-2.5 tabular-nums text-muted">{u.activeSessions}</td>
                <td className="px-2 py-2.5">
                  <span className="flex flex-wrap justify-end gap-1.5">
                    <button
                      type="button"
                      className={BTN}
                      data-testid={`user-edit-${u.userId}`}
                      onClick={() => setEditing(u)}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className={BTN}
                      disabled={pending}
                      data-testid={`user-reset-link-${u.userId}`}
                      onClick={() =>
                        startTransition(async () => {
                          setMsg(null);
                          const res = await createPasswordResetLink({ userId: u.userId });
                          if (!res.ok) {
                            setMsg({ kind: "err", text: res.error });
                            return;
                          }
                          setResetLink({ user: u.email, url: res.url, expiresAt: res.expiresAt });
                          router.refresh();
                        })
                      }
                    >
                      Reset link
                    </button>
                    {(u.totpEnabled || u.mustEnrollTotp) && (
                      <button
                        type="button"
                        className={BTN}
                        disabled={pending}
                        data-testid={`user-reset-2fa-${u.userId}`}
                        onClick={() =>
                          confirmThen(
                            `Reset two-factor for ${u.email}? Their current authenticator stops working and they must scan a new QR at next sign-in.`,
                            () =>
                              run(
                                () => resetUserTotp({ userId: u.userId }),
                                `Two-factor reset for ${u.email}. They must enroll again.`,
                              ),
                          )
                        }
                      >
                        Reset 2FA
                      </button>
                    )}
                    {u.lockedUntil && new Date(u.lockedUntil) > new Date() && (
                      <button
                        type="button"
                        className={BTN}
                        disabled={pending}
                        onClick={() => run(() => unlockUser({ userId: u.userId }), "Account unlocked.")}
                      >
                        Unlock
                      </button>
                    )}
                    {u.activeSessions > 0 && (
                      <button
                        type="button"
                        className={BTN}
                        disabled={pending}
                        onClick={() =>
                          confirmThen(`Sign ${u.email} out of all devices?`, () =>
                            run(
                              () => revokeUserSessions({ userId: u.userId }),
                              `Signed ${u.email} out everywhere.`,
                            ),
                          )
                        }
                      >
                        Sign out
                      </button>
                    )}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && (
        <EditUser
          user={editing}
          minPasswordLength={minPasswordLength}
          pending={pending}
          onClose={() => setEditing(null)}
          onRun={(fn, text) => {
            run(fn, text);
            setEditing(null);
          }}
        />
      )}

      {resetLink && (
        <Modal onClose={() => setResetLink(null)} labelledBy="reset-link-title">
          <h3 id="reset-link-title" className="mb-2 font-display text-lg font-bold lowercase">
            reset link for {resetLink.user}
          </h3>
          <p className="mb-3 text-[12.5px] text-muted">
            Single use, valid until{" "}
            {resetLink.expiresAt.slice(0, 16).replace("T", " ")}. Send it over a
            channel you trust — anyone holding it can set this password.
          </p>
          <code
            data-testid="reset-link-url"
            className="block break-all rounded-[8px] border border-line bg-[rgba(0,5,29,0.5)] p-2.5 text-[11.5px] text-ink"
          >
            {resetLink.url}
          </code>
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              className={BTN}
              onClick={() => navigator.clipboard.writeText(resetLink.url).catch(() => {})}
            >
              Copy
            </button>
            <button type="button" className={BTN_PRIMARY} onClick={() => setResetLink(null)}>
              Done
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function EditUser({
  user,
  minPasswordLength,
  pending,
  onClose,
  onRun,
}: {
  user: ManagedUser;
  minPasswordLength: number;
  pending: boolean;
  onClose: () => void;
  onRun: (fn: () => Promise<{ ok: boolean; error?: string }>, okText: string) => void;
}) {
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email);
  const [password, setPassword] = useState("");
  const [requireChange, setRequireChange] = useState(true);

  return (
    <Modal onClose={onClose} labelledBy="edit-user-title">
      <div className="mb-3 flex items-center">
        <h3 id="edit-user-title" className="font-display text-lg font-bold lowercase">
          edit {user.email}
        </h3>
        <button type="button" aria-label="Close" onClick={onClose} className="ml-auto text-muted hover:text-ink">
          ✕
        </button>
      </div>

      <div className="grid gap-3">
        <section className="rounded-[11px] border border-line p-3">
          <p className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted">
            Identity
          </p>
          <div className="grid gap-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Display name"
              data-testid="edit-user-name"
              className={INPUT}
            />
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Email"
              type="email"
              data-testid="edit-user-email"
              className={INPUT}
            />
            {email !== user.email && (
              <p className="text-[11.5px] text-warn">
                Changing the email changes how they sign in — it will sign them out
                of every device.
              </p>
            )}
            <button
              type="button"
              className={BTN_PRIMARY}
              disabled={pending || !name.trim() || !email.trim()}
              data-testid="edit-user-save"
              onClick={() =>
                onRun(
                  () => updateUserIdentity({ userId: user.userId, name, email }),
                  "User updated.",
                )
              }
            >
              Save identity
            </button>
          </div>
        </section>

        <section className="rounded-[11px] border border-line p-3">
          <p className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted">
            Set a password directly
          </p>
          <p className="mb-2 text-[11.5px] text-muted">
            At least {minPasswordLength} characters. Prefer the reset link unless you
            are handing the password over in person.
          </p>
          <div className="grid gap-2">
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="New password"
              type="text"
              autoComplete="off"
              data-testid="edit-user-password"
              className={INPUT}
            />
            <label className="flex items-center gap-2 text-[12px] text-muted">
              <input
                type="checkbox"
                checked={requireChange}
                onChange={(e) => setRequireChange(e.target.checked)}
              />
              Make them choose their own at next sign-in
            </label>
            <button
              type="button"
              className={BTN}
              disabled={pending || password.length < minPasswordLength}
              data-testid="edit-user-set-password"
              onClick={() =>
                onRun(
                  () => setUserPassword({ userId: user.userId, password, requireChange }),
                  `Password set for ${user.email}; they are signed out everywhere.`,
                )
              }
            >
              Set password
            </button>
          </div>
        </section>
      </div>
    </Modal>
  );
}
