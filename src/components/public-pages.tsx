"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { attempt } from "@/lib/client/server-action";
import {
  deleteAuditShare,
  revokeAuditShare,
  setBookingPageActive,
  type PublicPagesView,
} from "@/modules/public-pages/actions";

const CARD = "rounded-card border border-line bg-panel p-4";
const BTN =
  "min-h-[36px] rounded-[8px] border border-line px-2.5 py-1.5 text-[11.5px] font-semibold text-ink transition-colors hover:border-accent disabled:opacity-45";

function CopyLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={BTN}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(url);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          /* clipboard blocked — the URL is visible next to the button anyway */
        }
      }}
    >
      {copied ? "Copied ✓" : "Copy"}
    </button>
  );
}

function Url({ url }: { url: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="break-all text-[11.5px] text-accent-ink underline-offset-2 hover:underline"
    >
      {url}
    </a>
  );
}

function when(iso: string | null): string {
  return iso ? iso.slice(0, 16).replace("T", " ") : "—";
}

export function PublicPages({
  data,
  isOwner,
}: {
  data: PublicPagesView;
  isOwner: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  /** Which share is one click away from being deleted. */
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setMsg(null);
    startTransition(async () => {
      const res = await attempt(fn());
      if (!res.ok) setMsg(res.error ?? "That did not work.");
      router.refresh();
    });
  }

  return (
    <div className="grid gap-4">
      <div>
        <h2 className="font-display text-2xl font-bold lowercase tracking-display">
          public pages
        </h2>
        <p className="mt-0.5 text-[12.5px] text-muted">
          Every link this workspace has handed to a prospect. These pages need no
          sign-in — anyone with the URL can open them.
        </p>
      </div>

      {msg && (
        <p
          role="alert"
          className="rounded-[8px] border border-[rgba(255,92,122,0.35)] bg-[rgba(255,92,122,0.08)] px-3 py-2 text-[12.5px] text-[#FFB3C2]"
        >
          {msg}
        </p>
      )}

      {/* ---------- booking ---------- */}
      <section className={CARD} data-testid="public-bookings">
        <h3 className="mb-2 font-display text-[17px] font-bold lowercase tracking-display">
          booking page
        </h3>
        {data.bookings.length === 0 ? (
          <p className="text-[12.5px] text-muted">No booking page yet.</p>
        ) : (
          <ul className="grid gap-2">
            {data.bookings.map((b) => (
              <li
                key={b.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-[9px] border border-line px-3 py-2.5"
              >
                <span className="text-[13px] text-ink">{b.title}</span>
                <span className="text-[11.5px] text-muted">
                  {b.hostName} · {b.upcomingMeetings} upcoming
                </span>
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] ${
                    b.active ? "bg-[rgba(61,220,151,0.15)] text-[#8CEFC0]" : "bg-panel-2 text-muted"
                  }`}
                >
                  {b.active ? "live" : "off"}
                </span>
                <span className="w-full sm:w-auto">
                  <Url url={b.url} />
                </span>
                <span className="ml-auto flex gap-2">
                  <CopyLink url={b.url} />
                  {isOwner && (
                    <button
                      type="button"
                      disabled={pending}
                      className={BTN}
                      onClick={() =>
                        run(() =>
                          setBookingPageActive({ bookingPageId: b.id, active: !b.active }),
                        )
                      }
                    >
                      {b.active ? "Take offline" : "Put live"}
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ---------- audit shares ---------- */}
      <section className={CARD} data-testid="public-shares">
        <h3 className="mb-2 font-display text-[17px] font-bold lowercase tracking-display">
          audit reports <span className="text-[12px] font-normal text-muted">({data.shares.length})</span>
        </h3>
        {data.shares.length === 0 ? (
          <p className="text-[12.5px] text-muted">
            No shared audits yet. Run an audit, then publish its report to get a link.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-[12.5px]">
              <thead>
                <tr className="border-b border-line text-left text-[10.5px] uppercase tracking-[0.1em] text-muted">
                  <th className="px-2 py-1.5 font-semibold">Company</th>
                  <th className="px-2 py-1.5 font-semibold">Link</th>
                  <th className="px-2 py-1.5 font-semibold">Opens</th>
                  <th className="px-2 py-1.5 font-semibold">Expires</th>
                  <th className="px-2 py-1.5" />
                </tr>
              </thead>
              <tbody>
                {data.shares.map((s) => (
                  <tr key={s.id} className="border-b border-line last:border-0">
                    <td className="px-2 py-2">
                      <span className="block text-ink">{s.companyName}</span>
                      <span className="block text-[11px] text-muted">
                        {s.auditUrl}
                        {s.score !== null && ` · ${s.score}/100`}
                      </span>
                    </td>
                    <td className="max-w-[220px] px-2 py-2">
                      <Url url={s.url} />
                    </td>
                    <td className="px-2 py-2 tabular-nums">
                      {s.openCount > 0 ? (
                        <span className="text-ink">
                          {s.openCount}
                          <span className="block text-[11px] text-muted">
                            first {when(s.firstOpenedAt)}
                          </span>
                        </span>
                      ) : (
                        <span className="text-muted">not opened</span>
                      )}
                    </td>
                    <td className="px-2 py-2 tabular-nums">
                      {s.expired ? (
                        <span className="text-warn">expired</span>
                      ) : (
                        <span className="text-muted">{s.expiresAt.slice(0, 10)}</span>
                      )}
                    </td>
                    <td className="px-2 py-2 text-right">
                      <span className="inline-flex gap-2">
                        <CopyLink url={s.url} />
                        {!s.expired && (
                          <button
                            type="button"
                            disabled={pending}
                            className={BTN}
                            data-testid={`share-revoke-${s.id}`}
                            title="Stop the link working, keep the record of who opened it"
                            onClick={() => run(() => revokeAuditShare({ shareId: s.id }))}
                          >
                            Revoke
                          </button>
                        )}
                        {/*
                          Delete, next to Revoke, because they are different acts:
                          revoke backdates the expiry and keeps the row, so the
                          opens survive; delete takes the link off the list for
                          good. Two clicks, since there is no undo — and the audit
                          entry copies the open count before the row goes.
                        */}
                        {confirmDelete === s.id ? (
                          <>
                            <button
                              type="button"
                              disabled={pending}
                              data-testid={`share-delete-confirm-${s.id}`}
                              className="min-h-[36px] rounded-[8px] border border-[rgba(255,92,122,0.5)] bg-[rgba(255,92,122,0.12)] px-2.5 py-1.5 text-[11.5px] font-semibold text-[#FFB3C2] hover:bg-[rgba(255,92,122,0.2)] disabled:opacity-45"
                              onClick={() => {
                                setConfirmDelete(null);
                                run(() => deleteAuditShare({ shareId: s.id }));
                              }}
                            >
                              Delete for good
                            </button>
                            <button
                              type="button"
                              className={BTN}
                              onClick={() => setConfirmDelete(null)}
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            disabled={pending}
                            className={BTN}
                            data-testid={`share-delete-${s.id}`}
                            title="Remove the link from this list entirely"
                            onClick={() => setConfirmDelete(s.id)}
                          >
                            Delete
                          </button>
                        )}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ---------- quote acceptance ---------- */}
      <section className={CARD} data-testid="public-quotes">
        <h3 className="mb-2 font-display text-[17px] font-bold lowercase tracking-display">
          quote acceptance <span className="text-[12px] font-normal text-muted">({data.quotes.length})</span>
        </h3>
        {data.quotes.length === 0 ? (
          <p className="text-[12.5px] text-muted">
            No published quotes yet. Sending a quote publishes its acceptance link.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-[12.5px]">
              <thead>
                <tr className="border-b border-line text-left text-[10.5px] uppercase tracking-[0.1em] text-muted">
                  <th className="px-2 py-1.5 font-semibold">Quote</th>
                  <th className="px-2 py-1.5 font-semibold">Client</th>
                  <th className="px-2 py-1.5 font-semibold">Link</th>
                  <th className="px-2 py-1.5 font-semibold">Status</th>
                  <th className="px-2 py-1.5" />
                </tr>
              </thead>
              <tbody>
                {data.quotes.map((q) => (
                  <tr key={q.id} className="border-b border-line last:border-0">
                    <td className="px-2 py-2 text-ink">{q.number}</td>
                    <td className="px-2 py-2">{q.clientName}</td>
                    <td className="max-w-[220px] px-2 py-2">
                      <Url url={q.url} />
                    </td>
                    <td className="px-2 py-2">
                      {q.acceptedByName ? (
                        <span className="text-[#8CEFC0]">
                          accepted
                          <span className="block text-[11px] text-muted">
                            {q.acceptedByName} · {when(q.acceptedAt)}
                          </span>
                        </span>
                      ) : (
                        <span className="text-muted">{q.status.toLowerCase()}</span>
                      )}
                    </td>
                    <td className="px-2 py-2 text-right">
                      <CopyLink url={q.url} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
