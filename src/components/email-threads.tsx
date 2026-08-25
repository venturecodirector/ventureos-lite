"use client";

import { useEffect, useState } from "react";
import {
  listLeadThreads,
  openMessage,
  type EmailThreadView,
  type ThreadMessageView,
} from "@/modules/email/thread-actions";
import { sendThreadReply } from "@/modules/email/send-gmail";

/**
 * Synced correspondence on the lead (playbook-v2 P2c, P2d).
 *
 * Sits under the existing pasted-message thread rather than replacing it: the
 * manual paste flow stays as the fallback for anyone whose mailbox is not
 * connected, and for LinkedIn, which is not email at all.
 *
 * Message bodies render in a SANDBOXED IFRAME. They are already sanitized on
 * ingest; the iframe is the second layer, because one layer of defence against
 * a stranger's HTML in an authenticated session is not enough.
 */
function AttachmentRow({ a }: { a: { filename: string; sizeBytes: number } }) {
  return (
    <span className="mr-2 inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-[11px] text-muted">
      📎 {a.filename}
      <span className="opacity-70">{Math.round(a.sizeBytes / 1024)} KB</span>
    </span>
  );
}

function MessageBody({ message }: { message: ThreadMessageView }) {
  const [showImages, setShowImages] = useState(false);

  // Remote images arrive parked in data-blocked-src. Loading them tells the
  // sender the message was opened, so it stays the operator's choice.
  const html = showImages
    ? message.bodyHtml.replace(/data-blocked-src=/g, "src=")
    : message.bodyHtml;
  const blocked = (message.bodyHtml.match(/data-blocked-src=/g) ?? []).length;

  return (
    <>
      <iframe
        // No allow-scripts, no allow-same-origin: the body cannot run anything
        // and cannot reach the app's origin even if it tried.
        sandbox=""
        title="Email body"
        srcDoc={`<!doctype html><meta charset="utf-8"><style>
          body{font:13px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#C9CEE3;background:transparent;margin:0}
          a{color:#B98BFF}img{max-width:100%}table{max-width:100%}
        </style>${html || "<p style='opacity:.6'>(no content)</p>"}`}
        className="min-h-[120px] w-full rounded-[8px] border border-line bg-[rgba(0,5,29,0.35)]"
      />
      {blocked > 0 && !showImages && (
        <button
          onClick={() => setShowImages(true)}
          className="mt-1.5 rounded-full border border-line px-2.5 py-1 text-[11px] text-muted hover:border-accent hover:text-ink"
        >
          Load {blocked} blocked image{blocked > 1 ? "s" : ""} — the sender will know you opened
          this
        </button>
      )}
    </>
  );
}

export function EmailThreads({ leadId }: { leadId: string }) {
  const [threads, setThreads] = useState<EmailThreadView[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [escalationPrompt, setEscalationPrompt] = useState<string | null>(null);

  async function refresh() {
    setThreads(await listLeadThreads(leadId));
  }

  useEffect(() => {
    let active = true;
    listLeadThreads(leadId).then((t) => {
      if (active) {
        setThreads(t);
        setOpenId(t[0]?.id ?? null);
      }
    });
    return () => {
      active = false;
    };
  }, [leadId]);

  /**
   * Tracking, remembered per browser (playbook-v3 P9/1 asks for "per user").
   *
   * localStorage rather than a column: it is a composer convenience, it is
   * per-person on a personal machine, and a preference that costs a schema
   * change and a round trip to remember a checkbox is a bad trade.
   *
   * ABOVE the early return, and it has to be: hooks after a conditional exit
   * run in a different order once the thread list stops being empty, which is
   * exactly the transition this component makes on every lead that has mail.
   */
  const [track, setTrack] = useState(true);
  useEffect(() => {
    try {
      const saved = localStorage.getItem("vo_mail_track");
      if (saved !== null) setTrack(saved === "1");
    } catch {
      /* private window — the default stands */
    }
  }, []);
  function setTrackRemembered(next: boolean) {
    setTrack(next);
    try {
      localStorage.setItem("vo_mail_track", next ? "1" : "0");
    } catch {
      /* nothing to remember it with */
    }
  }

  if (!threads || threads.length === 0) return null;
  const thread = threads.find((t) => t.id === openId) ?? threads[0]!;
  const last = thread.messages[thread.messages.length - 1];

  async function send(acknowledge: boolean) {
    if (!reply.trim() || !last) return;
    setBusy(true);
    setNotice(null);
    try {
      const counterparts = [last.fromAddress, ...last.toAddresses].filter(
        (a) => a !== thread.accountEmail,
      );
      const res = await sendThreadReply({
        threadId: thread.id,
        to: [...new Set(counterparts)].slice(0, 5),
        subject: thread.subject?.startsWith("Re:")
          ? thread.subject
          : `Re: ${thread.subject ?? ""}`.trim(),
        body: reply,
        acknowledgeEscalation: acknowledge,
        track,
      });
      if (res.ok) {
        setReply("");
        setEscalationPrompt(null);
        setNotice("Sent from your mailbox.");
        await refresh();
      } else if (res.error === "escalated") {
        setEscalationPrompt(res.message);
      } else {
        setNotice(res.message);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3.5 rounded-card border border-line bg-panel p-[18px]">
      <div className="mb-2.5 flex flex-wrap items-baseline gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
          Email
        </span>
        <span className="text-[11px] text-muted">
          synced from {thread.accountEmail}
          {thread.matchType === "domain" && " · matched by company domain"}
        </span>
      </div>

      {threads.length > 1 && (
        <div className="mb-2.5 flex flex-wrap gap-1.5">
          {threads.map((t) => (
            <button
              key={t.id}
              onClick={() => setOpenId(t.id)}
              className={`max-w-[240px] truncate rounded-full border px-2.5 py-1 text-[11.5px] ${
                t.id === thread.id
                  ? "border-accent text-ink"
                  : "border-line text-muted hover:border-accent"
              }`}
            >
              {t.unread && <span className="mr-1 text-accent-ink">●</span>}
              {t.subject || "(no subject)"}
            </button>
          ))}
        </div>
      )}

      <div className="max-h-[46vh] space-y-3 overflow-auto">
        {thread.messages.map((m) => (
          <div key={m.id}>
            <div className="mb-1 flex flex-wrap items-baseline gap-2 text-[11.5px]">
              <span className={m.direction === "OUTBOUND" ? "text-accent-ink" : "text-[#C9CEE3]"}>
                {m.direction === "OUTBOUND" ? "You" : m.fromAddress}
              </span>
              <span className="text-muted">
                {new Date(m.sentAt).toLocaleString("hu-HU")}
              </span>
              {!m.analyzed && m.direction === "INBOUND" && (
                <button
                  onClick={async () => {
                    const res = await openMessage(m.id);
                    setNotice(
                      res.escalated
                        ? "Money talk detected — the Owner has been notified."
                        : res.analysis
                          ? "Analysed."
                          : "Opened.",
                    );
                    await refresh();
                  }}
                  className="ml-auto rounded-full border border-line px-2 py-0.5 text-[10.5px] text-muted hover:border-accent hover:text-ink"
                  title="Runs one Haiku call to summarise intent and objections"
                >
                  Analyse · 1 Claude call
                </button>
              )}
            </div>

            {/*
              Open/click feedback (P9/1). An open is labelled a SIGNAL, never a
              fact: Apple Mail pre-fetches images and other clients block them,
              so the number is wrong in both directions. A click is evidence.
            */}
            {m.tracking && (m.tracking.opens > 0 || m.tracking.clicks.length > 0) && (
              <div className="mb-1 text-[11px] text-muted" data-testid="mail-tracking">
                {m.tracking.opens > 0 && (
                  <span title="A képblokkolás és az Apple Mail előtöltése miatt ez jelzés, nem bizonyíték.">
                    megnyitás jelzés: {m.tracking.opens}×
                    {m.tracking.lastOpenAt &&
                      ` · utoljára ${new Date(m.tracking.lastOpenAt).toLocaleString("hu-HU")}`}
                  </span>
                )}
                {m.tracking.clicks.length > 0 && (
                  <span className="ml-2 text-[#8CEFC0]">
                    kattintás: {m.tracking.clicks.length}× ({m.tracking.clicks[0]!.url.slice(0, 40)}
                    {m.tracking.clicks[0]!.url.length > 40 ? "…" : ""})
                  </span>
                )}
              </div>
            )}
            <MessageBody message={m} />
            {m.hasAttachments && (
              <div className="mt-1.5">
                {m.attachments.map((a) => (
                  <AttachmentRow key={a.filename} a={a} />
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="mt-3 border-t border-line pt-3">
        <textarea
          value={reply}
          onChange={(e) => {
            setReply(e.target.value);
            setEscalationPrompt(null);
          }}
          placeholder="Reply — sends from your own mailbox, so it threads properly for them."
          className="min-h-[80px] w-full resize-y rounded-[10px] border border-line bg-[rgba(0,5,29,0.5)] p-3 text-[13px] text-ink outline-none focus:border-accent"
        />

        {escalationPrompt && (
          <div className="mt-2 rounded-[10px] border border-[rgba(245,184,65,0.4)] bg-[rgba(245,184,65,0.08)] px-3 py-2.5 text-[12.5px] text-warn">
            {escalationPrompt}
            <button
              onClick={() => send(true)}
              disabled={busy}
              className="ml-2 rounded-[8px] border border-line bg-panel px-2.5 py-1 text-[12px] text-ink hover:border-accent"
            >
              Send anyway
            </button>
          </div>
        )}

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            onClick={() => send(false)}
            disabled={busy || !reply.trim()}
            className="rounded-[10px] border-[1.5px] border-transparent bg-canvas px-4 py-1.5 text-[12.5px] font-semibold text-ink shadow-glow [background-clip:padding-box,border-box] [background-image:linear-gradient(#00051D,#00051D),linear-gradient(135deg,#310B59,#7427C6)] [background-origin:border-box] disabled:opacity-60"
          >
            {busy ? "Sending…" : "Send reply"}
          </button>
          <span className="text-[11px] text-muted">
            Goes out through your Gmail — never a campaign.
          </span>
          {/*
            Tracking, off-able per message (P9/1). Off means the recipient gets
            exactly what was typed: no pixel, no rewritten link, no notice.
          */}
          <label
            className="flex items-center gap-1.5 text-[11px] text-muted"
            title="Megnyitás- és kattintás-visszajelzés. Kikapcsolva a levél teljesen tiszta."
          >
            <input
              type="checkbox"
              checked={track}
              data-testid="reply-track"
              onChange={(e) => setTrackRemembered(e.target.checked)}
              className="h-3.5 w-3.5 accent-[#7427C6]"
            />
            Követés
          </label>
          {notice && <span className="ml-auto text-[11.5px] text-muted">{notice}</span>}
        </div>
      </div>
    </div>
  );
}
