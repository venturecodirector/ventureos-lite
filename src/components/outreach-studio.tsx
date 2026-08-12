"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import {
  critiqueOutreach,
  draftOutreach,
  getOutreachLead,
  markOutreachSent,
  saveOutreachDraft,
  startBlankDraft,
  type OutreachLeadView,
  type OutreachMessageView,
} from "@/modules/outreach/actions";
import {
  CONNECTION_MAX_CHARS,
  STEP_LABEL,
  isHumanEdited,
  type OutreachStep,
} from "@/modules/outreach/sequence";

const CARD = "rounded-card border border-line bg-panel p-4";
const BTN =
  "min-h-[44px] rounded-[9px] border border-line px-3 py-2 text-[12.5px] font-semibold text-ink transition-colors hover:border-accent disabled:opacity-45";
const BTN_PRIMARY =
  "min-h-[44px] rounded-[9px] bg-grad px-3.5 py-2 text-[12.5px] font-semibold text-ink shadow-glow transition-opacity disabled:opacity-45 disabled:shadow-none";

interface LeadRow {
  id: string;
  name: string;
  company: string;
  stage: string;
  pending: string | null;
}

export function OutreachStudio({
  leads,
  initialLead,
}: {
  leads: LeadRow[];
  initialLead: OutreachLeadView | null;
}) {
  const [pending, startTransition] = useTransition();
  const [lead, setLead] = useState<OutreachLeadView | null>(initialLead);
  const [step, setStep] = useState<OutreachStep>(initialLead?.nextStep ?? "connection");
  const [body, setBody] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "err" | "warn"; text: string } | null>(null);
  const [rationale, setRationale] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const current: OutreachMessageView | null = useMemo(
    () => lead?.messages.find((m) => m.step === step) ?? null,
    [lead, step],
  );

  /**
   * Load the stored text when the SELECTED MESSAGE changes — keyed on its id,
   * deliberately not on its body.
   *
   * Depending on the body too meant every post-action reload re-ran this and
   * overwrote whatever had been typed since: start a blank draft, begin typing,
   * and the refresh silently reset the box to "". Local text is always the
   * newer of the two, so only a genuine change of message replaces it.
   */
  useEffect(() => {
    const stored = current?.body ?? "";
    // Starting a blank draft creates an EMPTY message, so this effect fires
    // moments after the box became typeable. Never let that overwrite text the
    // operator has already put there — an empty stored body has nothing to
    // restore anyway.
    setBody((local) => (stored === "" && local.trim() !== "" ? local : stored));
    setRationale(null);
    setCopied(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);

  const maxChars = step === "connection" ? CONNECTION_MAX_CHARS : null;
  const over = maxChars !== null && body.length > maxChars;
  const sent = current?.status === "SENT";

  /**
   * Mirrors the server-side gate (CLAUDE.md hard rule #6) so the button explains
   * itself before you press it. The server re-checks — this is UX, not the rule.
   *
   * Uses the SAME comparison the server uses, so padding the draft with spaces
   * cannot make the button look enabled only for the send to be refused.
   */
  const uneditedAiDraft =
    !!current?.aiDrafted && !isHumanEdited(current.aiDraftBody, body);

  /**
   * Note what is NOT disabled here: an unedited draft or an over-length note
   * still submits, and the SERVER answers with the reason. An inert button
   * teaches nobody why they are stuck, and it would also mean the rule was only
   * ever visible as a greyed-out control rather than as an enforced answer.
   * The warning below states the rule up front; the server states it again if
   * you press on.
   */
  const canSend = !sent && body.trim().length > 0;

  /**
   * Refetch just this lead after an action.
   *
   * Deliberately no `router.refresh()`: it was inside the same transition, so
   * `pending` stayed true until the whole route re-rendered — which left every
   * button, including Mark sent, disabled after any action. The composer reads
   * its data from this state, not from the route, so refetching the lead is
   * both sufficient and immediate.
   */
  function reload(leadId: string) {
    startTransition(async () => {
      setLead(await getOutreachLead(leadId));
    });
  }

  function pickLead(id: string) {
    setMsg(null);
    startTransition(async () => {
      const next = await getOutreachLead(id);
      setLead(next);
      setStep(next?.nextStep ?? "connection");
    });
  }

  function onDraft() {
    if (!lead) return;
    setMsg(null);
    startTransition(async () => {
      const res = await draftOutreach({ leadId: lead.id, step, language: "HU" });
      if (!res.ok) {
        setMsg({ kind: "err", text: res.error });
        return;
      }
      setBody(res.body);
      setRationale(res.rationale || null);
      setMsg({
        kind: "warn",
        text: "Draft ready — edit it before you can mark it sent.",
      });
      reload(lead.id);
    });
  }

  function onCritique() {
    if (!current) return;
    setMsg(null);
    startTransition(async () => {
      // Save first so Claude reviews what is on screen, not the stored copy.
      await saveOutreachDraft({ messageId: current.id, body });
      const res = await critiqueOutreach({ messageId: current.id });
      if (!res.ok) setMsg({ kind: "err", text: res.error });
      if (lead) reload(lead.id);
    });
  }

  function onSave() {
    if (!current) return;
    startTransition(async () => {
      const res = await saveOutreachDraft({ messageId: current.id, body });
      if (!res.ok) {
        setMsg({ kind: "err", text: res.error });
        return;
      }
      setMsg({ kind: "ok", text: "Saved." });
      if (lead) reload(lead.id);
    });
  }

  function onBlank() {
    if (!lead) return;
    startTransition(async () => {
      const res = await startBlankDraft({ leadId: lead.id, step });
      if (!res.ok) {
        setMsg({ kind: "err", text: res.error });
        return;
      }
      setMsg({ kind: "ok", text: "Blank draft started — no AI involved." });
      reload(lead.id);
    });
  }

  function onMarkSent() {
    if (!current || !lead) return;
    setMsg(null);
    startTransition(async () => {
      const res = await markOutreachSent({ messageId: current.id, body });
      if (!res.ok) {
        setMsg({ kind: "err", text: res.error });
        return;
      }
      setMsg({
        kind: "ok",
        text: res.parked
          ? "Marked sent. Two follow-ups with no reply — the lead is parked as Not now."
          : "Marked sent.",
      });
      reload(lead.id);
    });
  }

  async function onCopyAndOpen() {
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setMsg({ kind: "err", text: "Could not copy — select the text and copy it manually." });
    }
    if (lead?.linkedinUrl) window.open(lead.linkedinUrl, "_blank", "noopener,noreferrer");
  }

  function insertHook(line: string) {
    setBody((b) => (b.trim() ? `${line}\n\n${b}` : line));
  }

  return (
    <div className="grid gap-4 nav:grid-cols-[260px_1fr]">
      {/* ---------- lead list ---------- */}
      <aside className={`${CARD} max-h-[70vh] overflow-y-auto`}>
        <h2 className="mb-2 font-display text-[17px] font-bold lowercase tracking-display">
          leads
        </h2>
        {leads.length === 0 && (
          <p className="text-[12.5px] text-muted">
            No leads in play. Capture or prospect some first.
          </p>
        )}
        <ul className="grid gap-1">
          {leads.map((l) => (
            <li key={l.id}>
              <button
                type="button"
                onClick={() => pickLead(l.id)}
                className={[
                  "flex min-h-[44px] w-full flex-col items-start justify-center rounded-[9px] border px-2.5 py-1.5 text-left transition-colors",
                  lead?.id === l.id
                    ? "border-line bg-panel-2 text-ink"
                    : "border-transparent text-muted hover:bg-panel",
                ].join(" ")}
              >
                <span className="text-[13px] font-semibold text-ink">{l.name}</span>
                <span className="truncate text-[11.5px] text-muted">{l.company}</span>
                {l.pending && (
                  <span className="mt-0.5 text-[10.5px] uppercase tracking-[0.1em] text-accent-ink">
                    next: {l.pending}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </aside>

      {/* ---------- composer ---------- */}
      {!lead ? (
        <div className={CARD}>
          <p className="text-[13px] text-muted">Pick a lead to start a sequence.</p>
        </div>
      ) : (
        <div className="grid gap-3">
          <div className={CARD}>
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <h2 className="font-display text-2xl font-bold lowercase tracking-display">
                  {lead.contactName || "(no name)"}
                </h2>
                <p className="text-[12.5px] text-muted">
                  {[lead.title, lead.companyName, lead.city].filter(Boolean).join(" · ")}
                </p>
              </div>
              <span className="rounded-full border border-line px-2.5 py-1 text-[11px] text-muted">
                {lead.stage} · score {lead.icpScore ?? "—"}
              </span>
            </div>

            {!lead.canContact && (
              <p className="mb-3 rounded-[8px] border border-[rgba(255,193,94,0.4)] bg-[rgba(255,193,94,0.09)] px-3 py-2 text-[12px] text-[#FFD79A]">
                Below the ICP threshold — this lead cannot enter Contacted until it
                scores higher.
              </p>
            )}

            {/* step tabs */}
            <div className="mb-3 flex flex-wrap gap-1.5">
              {(Object.keys(STEP_LABEL) as OutreachStep[]).map((s) => {
                const m = lead.messages.find((x) => x.step === s);
                return (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setStep(s)}
                    className={[
                      "min-h-[44px] rounded-[9px] border px-3 py-2 text-[12.5px] font-semibold",
                      step === s
                        ? "border-accent bg-accent-soft text-ink"
                        : "border-line text-muted hover:text-ink",
                    ].join(" ")}
                  >
                    {STEP_LABEL[s]}
                    {m?.status === "SENT" && <span className="ml-1.5 text-pos">✓</span>}
                  </button>
                );
              })}
            </div>

            {/* hooks */}
            {lead.hooks.length > 0 && !sent && (
              <div className="mb-3">
                <p className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted">
                  Insert an audit finding
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {lead.hooks.map((h) => (
                    <button
                      key={h.label}
                      type="button"
                      onClick={() => insertHook(h.line)}
                      title={h.line}
                      className="min-h-[44px] rounded-full border border-line px-3 py-1.5 text-[11.5px] text-muted hover:border-accent hover:text-ink"
                    >
                      + {h.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* editor */}
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              disabled={sent}
              rows={8}
              data-testid="outreach-body"
              placeholder={
                step === "connection"
                  ? "A short note that earns the accept…"
                  : "Your follow-up…"
              }
              className="w-full resize-y rounded-[10px] border border-line bg-[rgba(0,5,29,0.5)] p-3 text-[13.5px] leading-relaxed text-ink outline-none focus:border-accent disabled:opacity-70"
            />

            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px]">
              {maxChars !== null && (
                <span
                  className={over ? "font-semibold text-neg tabular-nums" : "text-muted tabular-nums"}
                  data-testid="char-counter"
                >
                  {body.length} / {maxChars}
                </span>
              )}
              {current?.aiDrafted && (
                <span className={uneditedAiDraft ? "text-warn" : "text-pos"}>
                  {uneditedAiDraft ? "Claude draft — not yet edited" : "Edited by you"}
                </span>
              )}
              {sent && current?.sentAt && (
                <span className="text-muted">
                  Sent {current.sentAt.slice(0, 16).replace("T", " ")}
                </span>
              )}
            </div>

            {rationale && (
              <p className="mt-2 rounded-[8px] border border-line px-3 py-2 text-[12px] text-muted">
                <b className="text-ink">Angle:</b> {rationale}
              </p>
            )}

            {msg && (
              <p
                role="status"
                data-testid="outreach-message"
                className={[
                  "mt-2.5 rounded-[8px] border px-3 py-2 text-[12.5px]",
                  msg.kind === "ok"
                    ? "border-[rgba(61,220,151,0.35)] bg-[rgba(61,220,151,0.08)] text-[#8CEFC0]"
                    : msg.kind === "warn"
                      ? "border-[rgba(245,184,65,0.4)] bg-[rgba(245,184,65,0.08)] text-[#FFD79A]"
                      : "border-[rgba(255,92,122,0.35)] bg-[rgba(255,92,122,0.08)] text-[#FFB3C2]",
                ].join(" ")}
              >
                {msg.text}
              </p>
            )}

            {/* actions */}
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" className={BTN} disabled={pending || sent} onClick={onDraft}>
                ✦ Draft with Claude
              </button>
              <button type="button" className={BTN} disabled={pending || sent} onClick={onBlank}>
                Blank draft
              </button>
              <button
                type="button"
                className={BTN}
                disabled={pending || sent || !current || !body.trim()}
                onClick={onCritique}
              >
                ✦ Critique
              </button>
              <button
                type="button"
                className={BTN}
                disabled={pending || sent || !current}
                onClick={onSave}
              >
                Save
              </button>
              <button
                type="button"
                className={BTN}
                disabled={!body.trim()}
                onClick={onCopyAndOpen}
              >
                {copied ? "Copied ✓" : "Copy & open LinkedIn"}
              </button>
              <button
                type="button"
                className={BTN_PRIMARY}
                disabled={pending || !canSend || !current}
                onClick={onMarkSent}
                data-testid="mark-sent"
              >
                Mark sent
              </button>
            </div>

            {uneditedAiDraft && !sent && (
              <p className="mt-2 text-[11.5px] text-muted" data-testid="guardrail-hint">
                The system never sends for you. Edit the draft so it is yours, then
                mark it sent once you have.
              </p>
            )}
          </div>

          {/* critique panel */}
          {current?.critique && (
            <div className={CARD}>
              <div className="mb-2 flex items-center gap-2">
                <h3 className="font-display text-[17px] font-bold lowercase tracking-display">
                  critique
                </h3>
                <span
                  className={[
                    "rounded-full px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-[0.1em]",
                    current.critique.verdict === "send"
                      ? "bg-[rgba(61,220,151,0.15)] text-[#8CEFC0]"
                      : "bg-[rgba(245,184,65,0.15)] text-[#FFD79A]",
                  ].join(" ")}
                >
                  {current.critique.verdict}
                </span>
              </div>
              {current.critique.issues.length > 0 ? (
                <ul className="grid gap-1.5">
                  {current.critique.issues.map((issue, i) => (
                    <li key={i} className="text-[12.5px] text-muted">
                      · {issue}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[12.5px] text-muted">No issues raised.</p>
              )}
              {current.critique.strongest && (
                <p className="mt-2 text-[12px] text-muted">
                  <b className="text-ink">Strongest line:</b> {current.critique.strongest}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
