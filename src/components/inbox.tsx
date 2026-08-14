"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { EmailThreads } from "./email-threads";
import { UnmatchedThreads } from "./unmatched-threads";
import {
  getThread,
  logInboundReply,
  logOutboundReply,
  setQualification,
  type ThreadSummary,
  type ThreadView,
} from "@/modules/inbox/actions";
import { moveLeadStage } from "@/modules/leads/actions";
import {
  QUAL_ITEMS,
  QUAL_LABEL,
  QUAL_QUESTIONS,
  type QualItem,
} from "@/modules/inbox/qualification";

const INTENT: Record<string, { label: string; cls: string }> = {
  interested: { label: "interested", cls: "bg-[rgba(61,220,151,0.12)] text-[#3DDC97]" },
  objection: { label: "objection", cls: "bg-[rgba(245,184,65,0.12)] text-warn" },
  not_now: { label: "not now", cls: "bg-panel-2 text-muted" },
  referral: { label: "referral", cls: "bg-accent-soft text-accent-ink" },
};

export function Inbox({
  threads,
  leads,
}: {
  threads: ThreadSummary[];
  leads: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<string | null>(threads[0]?.leadId ?? null);
  const [thread, setThread] = useState<ThreadView | null>(null);
  const [composer, setComposer] = useState("");
  const [paste, setPaste] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mobileThread, setMobileThread] = useState(false);
  const [newLead, setNewLead] = useState<string>(leads[0]?.id ?? "");
  const [newBody, setNewBody] = useState("");

  useEffect(() => {
    if (!selected) {
      setThread(null);
      return;
    }
    getThread(selected).then(setThread);
  }, [selected]);

  async function reload() {
    if (selected) setThread(await getThread(selected));
    router.refresh();
  }

  async function logInbound(leadId: string, body: string) {
    setBusy(true);
    setError(null);
    await logInboundReply({ leadId, body });
    setBusy(false);
    await reload();
  }

  async function sendOutbound() {
    if (!thread || !composer.trim()) return;
    setBusy(true);
    setError(null);
    const res = await logOutboundReply({ leadId: thread.leadId, body: composer });
    if (!res.ok) setError(res.error);
    else {
      setComposer("");
      await reload();
    }
    setBusy(false);
  }

  async function toggleQual(item: QualItem, value: boolean) {
    if (!thread) return;
    const res = await setQualification({ leadId: thread.leadId, item, value });
    setThread({ ...thread, qualification: res.qualification, canQualify: res.canQualify, answered: Object.values(res.qualification).filter(Boolean).length });
    router.refresh();
  }

  async function qualify() {
    if (!thread) return;
    const res = await moveLeadStage(thread.leadId, "QUALIFIED");
    if (!res.ok) setError(res.error);
    else {
      setError(null);
      router.refresh();
    }
  }

  function insertSuggestion(item: QualItem) {
    setComposer((c) => (c ? `${c}\n${QUAL_QUESTIONS[item]}` : QUAL_QUESTIONS[item]));
  }

  const showList = !mobileThread;

  return (
    <div className="max-w-[1400px]">
      {error && (
        <div className="mb-3 rounded-[10px] border border-[rgba(255,92,122,0.35)] bg-[rgba(255,92,122,0.1)] px-3.5 py-2.5 text-[12.5px] text-[#FFB3C2]">
          {error}
        </div>
      )}

      {/* Correspondence we synced but could not place. Above the fold on
          purpose: an unmatched thread is a lead's conversation sitting in the
          wrong place, and it stays wrong until someone links it. */}
      <UnmatchedThreads leads={leads} />

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[290px_1fr_300px]">
        {/* thread list */}
        <div className={`${showList ? "block" : "hidden"} rounded-card border border-line bg-panel p-2 lg:block`}>
          <div className="mb-2 grid gap-1.5 border-b border-line px-1.5 pb-2">
            <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
              New reply
            </div>
            <select
              value={newLead}
              onChange={(e) => setNewLead(e.target.value)}
              className="rounded-[7px] border border-line bg-[rgba(0,5,29,0.5)] px-2 py-1.5 text-[12px] text-ink outline-none focus:border-accent"
            >
              {leads.map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </select>
            <textarea
              value={newBody}
              onChange={(e) => setNewBody(e.target.value)}
              placeholder="Paste their reply…"
              className="min-h-[44px] rounded-[7px] border border-line bg-[rgba(0,5,29,0.5)] px-2 py-1.5 text-[12px] text-ink outline-none focus:border-accent"
            />
            <div className="flex gap-1.5">
              <button
                onClick={async () => {
                  if (!newLead || !newBody.trim()) return;
                  await logInbound(newLead, newBody);
                  setNewBody("");
                  setSelected(newLead);
                }}
                disabled={busy}
                className="flex-1 rounded-[8px] border border-line bg-panel px-2 py-1.5 text-[11.5px] hover:bg-panel-2 disabled:opacity-60"
              >
                Log reply
              </button>
              <button
                disabled
                title="Browser-extension hook — captures the thread you're viewing"
                className="rounded-[8px] border border-line bg-panel px-2 py-1.5 text-[11.5px] text-muted"
              >
                ⎘ Extension
              </button>
            </div>
          </div>
          {threads.length === 0 && <p className="px-2 py-2 text-[12px] text-muted">No threads yet.</p>}
          {threads.map((t) => (
            <button
              key={t.leadId}
              onClick={() => {
                setSelected(t.leadId);
                setMobileThread(true);
              }}
              className={`block w-full rounded-[10px] p-3 text-left ${
                selected === t.leadId ? "bg-panel-2" : "hover:bg-panel-2"
              }`}
            >
              <b className="flex items-center gap-2 text-[13px]">
                {t.unread && <span className="h-1.5 w-1.5 rounded-full bg-accent shadow-[0_0_8px_var(--tw-shadow-color)] shadow-accent" />}
                {t.name}
                {t.escalated && <span className="text-[10px] text-warn">⚠</span>}
              </b>
              <span className="mt-0.5 block truncate text-[12px] text-muted">
                {t.company} · {t.snippet}
              </span>
            </button>
          ))}
        </div>

        {/* conversation */}
        <div className={`${!showList ? "block" : "hidden"} rounded-card border border-line bg-panel p-[18px] lg:block`}>
          {!thread ? (
            <p className="text-[13px] text-muted">Select a thread.</p>
          ) : (
            <>
              <div className="mb-3 flex items-center gap-2">
                <button
                  onClick={() => setMobileThread(false)}
                  className="text-[12px] text-muted hover:text-ink lg:hidden"
                >
                  ← Threads
                </button>
                <b className="text-[14px]">{thread.name}</b>
                <span className="text-[12px] text-muted">{thread.company}</span>
                {thread.escalated && (
                  <span className="ml-auto rounded-full bg-[rgba(245,184,65,0.12)] px-2.5 py-0.5 text-[11px] font-semibold text-warn">
                    ⚠ escalated — money-talk locked
                  </span>
                )}
              </div>

              <div className="mb-3 max-h-[46vh] overflow-auto">
                {thread.messages.map((m) => (
                  <div
                    key={m.id}
                    className={`mb-2.5 max-w-[80%] rounded-[13px] px-3.5 py-2.5 text-[13px] leading-relaxed ${
                      m.direction === "OUTBOUND"
                        ? "ml-auto border border-[rgba(116,39,198,0.4)] bg-accent-soft"
                        : "border border-line bg-panel-2"
                    }`}
                  >
                    {m.body}
                  </div>
                ))}
              </div>

              <textarea
                value={composer}
                onChange={(e) => setComposer(e.target.value)}
                placeholder="Your reply — insert a suggested question from the right, then copy or log as sent."
                className="min-h-[70px] w-full resize-y rounded-[10px] border border-line bg-[rgba(0,5,29,0.5)] p-3 text-[13px] text-ink outline-none focus:border-accent"
              />
              <div className="mt-2 flex flex-wrap gap-2">
                <button onClick={sendOutbound} disabled={busy || !composer.trim()} className="rounded-[10px] border border-line bg-panel px-3.5 py-1.5 text-[12.5px] hover:bg-panel-2 disabled:opacity-60">
                  Log as sent
                </button>
                <button
                  onClick={() => navigator.clipboard?.writeText(composer)}
                  disabled={!composer.trim()}
                  className="rounded-[10px] border border-line bg-panel px-3.5 py-1.5 text-[12.5px] hover:bg-panel-2 disabled:opacity-60"
                >
                  Copy
                </button>
                <span className="self-center text-[11px] text-muted">Never auto-sent.</span>
              </div>

              {selected && <EmailThreads leadId={selected} />}
            </>
          )}
        </div>

        {/* analysis + qualification */}
        <div className={`${!showList ? "block" : "hidden"} grid gap-3 lg:block`}>
          {thread?.latestAnalysis && (
            <div className="rounded-card border border-line bg-panel p-[18px]">
              <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
                ✦ Claude analysis
              </div>
              <div className="mb-2 flex flex-wrap gap-1.5">
                <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${INTENT[thread.latestAnalysis.intent]?.cls}`}>
                  intent: {INTENT[thread.latestAnalysis.intent]?.label}
                </span>
                {thread.latestAnalysis.objection && (
                  <span className="rounded-full bg-[rgba(245,184,65,0.12)] px-2.5 py-0.5 text-[11px] font-semibold text-warn">
                    objection: {thread.latestAnalysis.objection}
                  </span>
                )}
              </div>
              <div className="text-[11px] text-muted">Suggested next questions</div>
              {thread.latestAnalysis.suggestions.map((s) => (
                <button
                  key={s}
                  onClick={() => insertSuggestion(s as QualItem)}
                  className="mt-1.5 block w-full rounded-[9px] border border-line bg-panel px-3 py-2 text-left text-[12.5px] text-[#C9CEE3] hover:border-accent"
                >
                  → {QUAL_QUESTIONS[s as QualItem]}
                </button>
              ))}
            </div>
          )}

          {thread && (
            <div className="mt-3 rounded-card border border-line bg-panel p-[18px] lg:mt-0">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
                Qualification · {thread.answered} of 4
              </div>
              {QUAL_ITEMS.map((item) => (
                <label key={item} className="flex items-center gap-2 py-1.5 text-[12.5px] text-[#C9CEE3]">
                  <input
                    type="checkbox"
                    checked={thread.qualification[item]}
                    onChange={(e) => toggleQual(item, e.target.checked)}
                    style={{ accentColor: "#7427C6" }}
                  />
                  {QUAL_LABEL[item]}
                </label>
              ))}
              <button
                onClick={qualify}
                disabled={!thread.canQualify}
                className="mt-2 w-full rounded-[10px] border border-line bg-panel px-3 py-2 text-[12.5px] font-semibold hover:bg-panel-2 disabled:opacity-50"
              >
                {thread.canQualify ? "Move to Qualified" : "Qualified unlocks at 3 of 4"}
              </button>
              <p className="mt-2 text-[11px] text-muted">Price mentions auto-escalate to the Owner.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
