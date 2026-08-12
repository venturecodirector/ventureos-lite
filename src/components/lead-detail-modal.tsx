"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Stage } from "@prisma/client";
import {
  getLeadDetail,
  overrideScoreFromDetail,
  updateLeadDetail,
  type LeadDetail,
} from "@/modules/leads/detail";
import { moveLeadStage } from "@/modules/leads/actions";
import { PIPELINE_STAGES, SIDE_STAGES, STAGE_LABELS } from "@/modules/pipeline/transitions";
import { Modal } from "./modal";

const INPUT =
  "w-full rounded-[9px] border border-line bg-[rgba(0,5,29,0.5)] px-2.5 py-2 text-[13px] text-ink outline-none focus:border-accent";
const LABEL = "text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted";
const BTN =
  "min-h-[36px] rounded-[8px] border border-line px-2.5 py-1.5 text-[11.5px] font-semibold text-ink transition-colors hover:border-accent disabled:opacity-45";
const BTN_PRIMARY =
  "min-h-[40px] rounded-[9px] bg-grad px-3.5 py-2 text-[12.5px] font-semibold text-ink disabled:opacity-45";

/**
 * Pipeline card detail. Opens from a card click; every field saves through a
 * server action that revalidates its own inputs, so the modal is a convenience
 * rather than the trust boundary.
 */
export function LeadDetailModal({ leadId, onClose }: { leadId: string; onClose: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [detail, setDetail] = useState<LeadDetail | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  // editable copy
  const [form, setForm] = useState<LeadDetail | null>(null);
  const [signalInput, setSignalInput] = useState("");
  const [scoreReason, setScoreReason] = useState("");
  const [scoreDraft, setScoreDraft] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    getLeadDetail(leadId)
      .then((d) => {
        if (!live) return;
        if (!d) {
          setLoadError(true);
          return;
        }
        setDetail(d);
        setForm(d);
        setScoreDraft(d.icpScore);
      })
      .catch(() => live && setLoadError(true));
    return () => {
      live = false;
    };
  }, [leadId]);

  function patch(next: Partial<LeadDetail>) {
    setForm((f) => (f ? { ...f, ...next } : f));
  }

  function save() {
    if (!form) return;
    setMsg(null);
    startTransition(async () => {
      const res = await updateLeadDetail({
        leadId: form.id,
        contactName: form.contactName,
        title: form.title,
        email: form.email,
        phone: form.phone,
        linkedinUrl: form.linkedinUrl,
        language: form.language,
        notes: form.notes,
        signals: form.signals,
        company: {
          name: form.companyName,
          domain: form.companyDomain,
          city: form.companyCity,
          taxId: form.companyTaxId,
        },
      });
      if (!res.ok) {
        setMsg({ kind: "err", text: res.error });
        return;
      }
      setMsg({ kind: "ok", text: "Saved." });
      router.refresh();
    });
  }

  if (loadError) {
    return (
      <Modal onClose={onClose}>
        <p className="text-[13px] text-[#FFB3C2]" data-testid="lead-modal-error">
          That lead is not available in this workspace.
        </p>
        <div className="mt-3 flex justify-end">
          <button type="button" className={BTN} onClick={onClose}>
            Close
          </button>
        </div>
      </Modal>
    );
  }

  if (!form || !detail) {
    return (
      <Modal onClose={onClose}>
        <p className="text-[13px] text-muted">Loading…</p>
      </Modal>
    );
  }

  return (
    <Modal onClose={onClose} labelledBy="lead-modal-title" wide>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h3 id="lead-modal-title" className="font-display text-lg font-bold lowercase">
          {form.contactName || form.companyName || "lead"}
        </h3>
        <span className="rounded-full border border-line px-2 py-0.5 text-[11px] text-muted">
          {STAGE_LABELS[detail.stage as Stage] ?? detail.stage} · {detail.daysInStage}d
        </span>
        <span className="text-[11px] text-muted">{detail.source.toLowerCase()}</span>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="ml-auto text-muted hover:text-ink"
        >
          ✕
        </button>
      </div>

      {msg && (
        <p
          role="status"
          data-testid="lead-modal-message"
          className={`mb-3 rounded-[8px] border px-3 py-2 text-[12.5px] ${
            msg.kind === "ok"
              ? "border-[rgba(61,220,151,0.35)] bg-[rgba(61,220,151,0.08)] text-[#8CEFC0]"
              : "border-[rgba(255,92,122,0.35)] bg-[rgba(255,92,122,0.08)] text-[#FFB3C2]"
          }`}
        >
          {msg.text}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
        {/* ---------- editable fields ---------- */}
        <div className="grid gap-3">
          <section className="grid gap-2 rounded-[11px] border border-line p-3">
            <p className={LABEL}>Contact</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <input
                className={INPUT}
                placeholder="Name"
                data-testid="lead-name"
                value={form.contactName}
                onChange={(e) => patch({ contactName: e.target.value })}
              />
              <input
                className={INPUT}
                placeholder="Title"
                value={form.title}
                onChange={(e) => patch({ title: e.target.value })}
              />
              <input
                className={INPUT}
                placeholder="Email"
                data-testid="lead-email"
                value={form.email}
                onChange={(e) => patch({ email: e.target.value })}
              />
              <input
                className={INPUT}
                placeholder="Phone"
                value={form.phone}
                onChange={(e) => patch({ phone: e.target.value })}
              />
              <input
                className={`${INPUT} sm:col-span-2`}
                placeholder="LinkedIn URL"
                value={form.linkedinUrl}
                onChange={(e) => patch({ linkedinUrl: e.target.value })}
              />
              <label className="flex items-center gap-2 text-[12px] text-muted">
                Language
                <select
                  className={INPUT}
                  data-testid="lead-language"
                  value={form.language}
                  onChange={(e) => patch({ language: e.target.value as "HU" | "EN" })}
                >
                  <option value="HU">Hungarian</option>
                  <option value="EN">English</option>
                </select>
              </label>
            </div>
          </section>

          <section className="grid gap-2 rounded-[11px] border border-line p-3">
            <p className={LABEL}>Company</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <input
                className={INPUT}
                placeholder="Company name"
                data-testid="lead-company"
                value={form.companyName}
                onChange={(e) => patch({ companyName: e.target.value })}
              />
              <input
                className={INPUT}
                placeholder="Domain"
                value={form.companyDomain}
                onChange={(e) => patch({ companyDomain: e.target.value })}
              />
              <input
                className={INPUT}
                placeholder="City"
                value={form.companyCity}
                onChange={(e) => patch({ companyCity: e.target.value })}
              />
              <input
                className={INPUT}
                placeholder="Adószám"
                value={form.companyTaxId}
                onChange={(e) => patch({ companyTaxId: e.target.value })}
              />
            </div>
            <p className="text-[11px] text-muted">
              These apply to the company record, shared by every lead there.
            </p>
          </section>

          <section className="grid gap-2 rounded-[11px] border border-line p-3">
            <p className={LABEL}>Signals &amp; tags</p>
            <div className="flex flex-wrap gap-1.5">
              {form.signals.map((s) => (
                <span
                  key={s}
                  className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-[11px] text-muted"
                >
                  {s}
                  <button
                    type="button"
                    aria-label={`Remove ${s}`}
                    className="text-muted hover:text-ink"
                    onClick={() => patch({ signals: form.signals.filter((x) => x !== s) })}
                  >
                    ✕
                  </button>
                </span>
              ))}
              {form.signals.length === 0 && (
                <span className="text-[11.5px] text-muted">None yet.</span>
              )}
            </div>
            <input
              className={INPUT}
              placeholder="Add a signal and press Enter"
              data-testid="lead-signal-input"
              value={signalInput}
              onChange={(e) => setSignalInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                const v = signalInput.trim();
                if (!v || form.signals.includes(v)) return;
                patch({ signals: [...form.signals, v] });
                setSignalInput("");
              }}
            />
          </section>

          <section className="grid gap-2 rounded-[11px] border border-line p-3">
            <p className={LABEL}>Notes</p>
            <textarea
              className={`${INPUT} min-h-[90px] resize-y`}
              placeholder="Anything worth remembering"
              data-testid="lead-notes"
              value={form.notes}
              onChange={(e) => patch({ notes: e.target.value })}
            />
          </section>

          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" className={BTN} onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className={BTN_PRIMARY}
              data-testid="lead-save"
              disabled={pending}
              onClick={save}
            >
              {pending ? "Saving…" : "Save changes"}
            </button>
          </div>
        </div>

        {/* ---------- score, stage, timeline ---------- */}
        <div className="grid content-start gap-3">
          <section className="grid gap-2 rounded-[11px] border border-line p-3">
            <p className={LABEL}>ICP score</p>
            <div className="flex flex-wrap gap-1.5">
              {Array.from({ length: form.maxScore + 1 }, (_, i) => i).map((n) => (
                <button
                  key={n}
                  type="button"
                  data-testid={`lead-score-${n}`}
                  onClick={() => setScoreDraft(n)}
                  className={`h-8 w-8 rounded-[8px] border text-[12.5px] font-semibold ${
                    scoreDraft === n
                      ? "border-accent bg-accent-soft text-[#E4D3FF]"
                      : "border-line bg-panel text-ink"
                  }`}
                >
                  {n}
                </button>
              ))}
            </div>
            {scoreDraft !== detail.icpScore && (
              <>
                <input
                  className={INPUT}
                  placeholder="Why? (recorded in the audit log)"
                  data-testid="lead-score-reason"
                  value={scoreReason}
                  onChange={(e) => setScoreReason(e.target.value)}
                />
                <button
                  type="button"
                  className={BTN}
                  data-testid="lead-score-save"
                  disabled={pending || scoreReason.trim().length < 3}
                  onClick={() =>
                    startTransition(async () => {
                      const res = await overrideScoreFromDetail({
                        leadId: form.id,
                        score: scoreDraft ?? 0,
                        reason: scoreReason,
                      });
                      if (!res.ok) {
                        setMsg({ kind: "err", text: res.error });
                        return;
                      }
                      setDetail({ ...detail, icpScore: res.icpScore });
                      setScoreReason("");
                      setMsg({ kind: "ok", text: `Score set to ${res.icpScore}.` });
                      router.refresh();
                    })
                  }
                >
                  Save score override
                </button>
              </>
            )}
          </section>

          <section className="grid gap-2 rounded-[11px] border border-line p-3">
            <p className={LABEL}>Stage</p>
            <div className="flex flex-wrap gap-1.5">
              {[...PIPELINE_STAGES, ...SIDE_STAGES]
                .filter((s) => s !== detail.stage)
                .map((s) => (
                  <button
                    key={s}
                    type="button"
                    className={BTN}
                    data-testid={`lead-stage-${s}`}
                    disabled={pending}
                    onClick={() =>
                      startTransition(async () => {
                        const res = await moveLeadStage(form.id, s as Stage);
                        if (!res.ok) {
                          setMsg({ kind: "err", text: res.error });
                          return;
                        }
                        setDetail({ ...detail, stage: s });
                        setMsg({ kind: "ok", text: `Moved to ${STAGE_LABELS[s as Stage]}.` });
                        router.refresh();
                      })
                    }
                  >
                    {STAGE_LABELS[s as Stage] ?? s}
                  </button>
                ))}
            </div>
            {detail.stageReason && (
              <p className="text-[11.5px] text-muted">Reason: {detail.stageReason}</p>
            )}
          </section>

          <section className="grid gap-2 rounded-[11px] border border-line p-3">
            <p className={LABEL}>Timeline</p>
            {detail.timeline.length === 0 ? (
              <p className="text-[12px] text-muted">Nothing recorded yet.</p>
            ) : (
              <ul
                className="grid max-h-[280px] gap-2 overflow-y-auto pr-1"
                data-testid="lead-timeline"
              >
                {detail.timeline.map((e) => (
                  <li key={e.id} className="border-l border-line pl-2.5">
                    <span className="block text-[11.5px] text-ink">{e.label}</span>
                    {e.detail && (
                      <span className="block truncate text-[11px] text-muted" title={e.detail}>
                        {e.detail}
                      </span>
                    )}
                    <span className="block text-[10.5px] text-muted tabular-nums">
                      {e.at.slice(0, 16).replace("T", " ")}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </Modal>
  );
}
