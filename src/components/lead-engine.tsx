"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { extensionPresence, captureProfileViaExtension } from "@/lib/extension-bridge";
import type { LeadCard } from "@/lib/ai/prompts/lead-research";
import {
  captureLinkedin,
  runResearch,
  createLeadManual,
  previewCsvImport,
  commitCsvImport,
  overrideScore,
  moveLeadStage,
} from "@/modules/leads/actions";
import {
  enrichCompanyLookup,
  confirmEnrichment,
} from "@/modules/registry/actions";
import { listReferrers, type ReferrerOption } from "@/modules/referrals/actions";
import type { RegistryCandidate } from "@/modules/registry/provider";
import { companyUnderProceedings } from "@/modules/registry/risk";
import { RiskChip } from "./risk-chip";
import { Modal } from "./modal";
import { CsvImport } from "./csv-import";
import { preParse, hasAnalyzableText } from "@/modules/leads/preparse";
import { ManualLeadForm } from "./manual-lead-form";
import { LeadDetailModal } from "./lead-detail-modal";

export interface LeadRow {
  id: string;
  companyId: string | null;
  contactName: string | null;
  title: string | null;
  company: string;
  industry: string | null;
  sizeBand: string | null;
  icpScore: number | null;
  stage: string;
  signals: string[];
  riskLabel: string | null;
}

// ---- small bits -----------------------------------------------------------

function Notches({ score }: { score: number | null }) {
  const n = score ?? 0;
  return (
    <span className="inline-flex gap-[3px] align-middle">
      {Array.from({ length: 5 }).map((_, i) => (
        <i
          key={i}
          className={`h-[5px] w-[9px] rounded-[2px] ${i < n ? "bg-grad" : "bg-line"}`}
        />
      ))}
    </span>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="mr-1 mb-1 inline-flex items-center rounded-full border border-accent-soft px-2 py-0.5 text-[11px] font-semibold text-accent-ink">
      {children}
    </span>
  );
}

// ---- Claude rail (reveal animation like the prototype) --------------------

type RailState =
  | { status: "idle" }
  | { status: "streaming" }
  | { status: "done"; card: LeadCard; icpScore: number; leadId: string };

function ClaudeRail({
  state,
  threshold,
  onOverride,
  onAddToPipeline,
}: {
  state: RailState;
  threshold: number;
  onOverride: (leadId: string) => void;
  onAddToPipeline: (leadId: string) => void;
}) {
  const total = 6;
  const [revealed, setRevealed] = useState(0);

  useEffect(() => {
    if (state.status !== "done") {
      setRevealed(0);
      return;
    }
    setRevealed(0);
    const iv = setInterval(() => {
      setRevealed((r) => {
        if (r >= total) {
          clearInterval(iv);
          return r;
        }
        return r + 1;
      });
    }, 500);
    return () => clearInterval(iv);
  }, [state]);

  return (
    <div className="sticky top-0">
      <div className="rounded-card border-[1.5px] border-transparent bg-[linear-gradient(rgba(3,7,32,0.95),rgba(3,7,32,0.95))_padding-box,linear-gradient(135deg,#310B59,#7427C6)_border-box] p-[18px] shadow-glow-lg">
        <div className="mb-3.5 flex items-center gap-2">
          <div className="grid h-[22px] w-[22px] place-items-center rounded-[7px] bg-grad text-[12px]">
            ✦
          </div>
          <b className="text-[13px]">Claude · Lead card</b>
          <span className="ml-auto text-[11px] text-muted">
            {state.status === "streaming" ? (
              <span className="inline-flex gap-[3px]">
                <i className="h-1 w-1 animate-pulse rounded-full bg-accent-ink" />
                <i className="h-1 w-1 animate-pulse rounded-full bg-accent-ink [animation-delay:0.2s]" />
                <i className="h-1 w-1 animate-pulse rounded-full bg-accent-ink [animation-delay:0.4s]" />
              </span>
            ) : state.status === "done" ? (
              "done"
            ) : (
              "idle"
            )}
          </span>
        </div>

        {state.status === "idle" && (
          <p className="text-[12.5px] text-muted">
            Paste a profile and run research — the structured lead card streams in
            here. Every score can be overridden; overrides are logged.
          </p>
        )}
        {state.status === "streaming" && (
          <p className="text-[12.5px] text-muted">Researching… nothing is sent anywhere.</p>
        )}

        {state.status === "done" && (
          <div className="space-y-0">
            <Section show={revealed >= 1} title="Company">
              <p className="text-[12.5px] leading-relaxed text-[#C9CEE3]">
                <b>{state.card.company.name}</b>
                {state.card.company.industry ? ` · ${state.card.company.industry}` : ""}
                {state.card.company.sizeEmployees
                  ? ` · ~${state.card.company.sizeEmployees} employees`
                  : ""}
                . {state.card.company.summary}
              </p>
            </Section>
            <Section show={revealed >= 2} title="Person">
              <p className="text-[12.5px] leading-relaxed text-[#C9CEE3]">
                <b>{state.card.person.name}</b>
                {state.card.person.title ? `, ${state.card.person.title}` : ""}.{" "}
                {state.card.person.summary}
              </p>
            </Section>
            <Section show={revealed >= 3} title="Trigger signals">
              <div>
                {state.card.signals.map((s, i) => (
                  <Tag key={i}>{s}</Tag>
                ))}
              </div>
            </Section>
            <Section show={revealed >= 4} title="Likely pain points">
              <ol className="list-decimal pl-4 text-[12.5px] leading-relaxed text-[#C9CEE3]">
                {state.card.pains.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ol>
            </Section>
            <Section show={revealed >= 5} title="Suggested hook">
              <div className="rounded-[10px] bg-accent-soft px-3 py-2.5 text-[12.5px] italic leading-relaxed text-[#E4D3FF]">
                {state.card.hook}
              </div>
            </Section>
            <Section show={revealed >= 6} title="ICP score">
              <div className="flex items-center justify-between border-t border-line pt-2 text-[12.5px]">
                <span>
                  <b>Total</b>
                </span>
                <span className="flex items-center gap-2">
                  <Notches score={state.icpScore} />
                  <b>{state.icpScore}</b>
                </span>
              </div>
              <p className="mt-1 text-[11px] text-muted">
                {state.icpScore >= threshold
                  ? "Above the score gate — can be contacted."
                  : `Below the gate (${threshold}) — cannot enter Contacted.`}
              </p>
              <div className="mt-3.5 flex gap-2">
                <button
                  onClick={() => onAddToPipeline(state.leadId)}
                  className="flex-1 rounded-[10px] border-[1.5px] border-transparent bg-canvas px-3 py-2 text-[12px] font-semibold text-ink shadow-glow [background-clip:padding-box,border-box] [background-image:linear-gradient(#00051D,#00051D),linear-gradient(135deg,#310B59,#7427C6)] [background-origin:border-box]"
                >
                  Add to pipeline
                </button>
                <button
                  onClick={() => onOverride(state.leadId)}
                  className="rounded-[10px] border border-line bg-panel px-3 py-2 text-[12px] font-semibold text-ink hover:bg-panel-2"
                >
                  Override score
                </button>
              </div>
            </Section>
          </div>
        )}
      </div>
    </div>
  );
}

function Section({
  show,
  title,
  children,
}: {
  show: boolean;
  title: string;
  children: React.ReactNode;
}) {
  if (!show) return null;
  return (
    <section className="animate-[fade_0.25s_ease] border-t border-line py-3 first:border-t-0">
      <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">
        {title}
      </h4>
      {children}
    </section>
  );
}

// ---- main -----------------------------------------------------------------

export function LeadEngine({
  leads,
  threshold,
}: {
  leads: LeadRow[];
  threshold: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [rail, setRail] = useState<RailState>({ status: "idle" });
  const [paste, setPaste] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [showManual, setShowManual] = useState(false);
  // The extension is optional, so its actions only appear when it answers.
  const [hasExtension, setHasExtension] = useState(false);
  const [extBusy, setExtBusy] = useState(false);
  const [extNote, setExtNote] = useState<string | null>(null);

  useEffect(() => {
    // Optional tool: ask once, show its actions only if it answers. A missing
    // extension simply never replies, so this resolves to false on its own.
    let active = true;
    extensionPresence().then((p) => {
      if (active) setHasExtension(p.present);
    });
    return () => {
      active = false;
    };
  }, []);
  // P1/1a — the same pure check the server uses, so the UI never offers a
  // research call that would be refused. P1/1b — what we already know from the
  // paste without spending anything.
  const parsed = useMemo(() => preParse(paste), [paste]);
  const canResearch = useMemo(() => hasAnalyzableText(paste), [paste]);
  // The first LinkedIn profile URL in the pasted text — what the extension
  // would be asked to read.
  const linkedInUrl = (() => {
    const match = /https?:\/\/(?:[a-z-]+\.)?linkedin\.com\/in\/[^\s]+/i.exec(paste);
    return match ? match[0].split("?")[0]!.replace(/\/$/, "") : null;
  })();

  const urlOnly = paste.trim().length > 0 && !canResearch;
  // Same modal the pipeline board uses — editing and deletion live in one
  // place rather than being reimplemented per screen.
  const [detailFor, setDetailFor] = useState<string | null>(null);
  const [showCsv, setShowCsv] = useState(false);
  const [overrideFor, setOverrideFor] = useState<string | null>(null);
  const [enrichFor, setEnrichFor] = useState<string | null>(null);

  function firstUrl(text: string): string {
    const m = text.match(/https?:\/\/\S+/);
    return m ? m[0] : "";
  }

  async function research(leadId: string) {
    setError(null);
    setRail({ status: "streaming" });
    try {
      const { card, icpScore } = await runResearch(leadId);
      setRail({ status: "done", card, icpScore, leadId });
      router.refresh();
    } catch (e) {
      setRail({ status: "idle" });
      setError((e as Error).message);
    }
  }

  async function captureWithExtension() {
    if (!linkedInUrl) return;
    setExtBusy(true);
    setExtNote(null);
    try {
      const res = await captureProfileViaExtension(linkedInUrl);
      if (!res.ok) {
        setExtNote(res.message);
        return;
      }
      // Say what was actually read: a capture that got only a URL used to look
      // exactly like a good one, which is how "unknown lead, no data" happened
      // without anybody noticing.
      setExtNote(
        res.read.length === 0
          ? "Read the URL only — LinkedIn's layout has changed."
          : `${res.created ? "Captured" : "Updated"} · read ${res.read.join(", ")}.`,
      );
      router.refresh();
    } finally {
      setExtBusy(false);
    }
  }

  async function researchFromPaste() {
    if (!paste.trim()) return;
    setError(null);
    setRail({ status: "streaming" });
    try {
      const { leadId } = await captureLinkedin({
        url: firstUrl(paste) || paste.slice(0, 120),
        pageText: paste,
      });
      const { card, icpScore } = await runResearch(leadId);
      setRail({ status: "done", card, icpScore, leadId });
      setPaste("");
      router.refresh();
    } catch (e) {
      setRail({ status: "idle" });
      setError((e as Error).message);
    }
  }

  async function toContacted(leadId: string) {
    setError(null);
    const res = await moveLeadStage(leadId, "CONTACTED");
    if (!res.ok) setError(res.error);
    else router.refresh();
  }

  return (
    <div className="max-w-[1400px]">
      {error && (
        <div className="mb-3 rounded-[10px] border border-[rgba(255,92,122,0.35)] bg-[rgba(255,92,122,0.1)] px-3.5 py-2.5 text-[12.5px] text-[#FFB3C2]">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 items-start gap-[18px] lg:grid-cols-[1fr_340px]">
        <div>
          {/* capture */}
          <div className="mb-4 rounded-card border border-line bg-panel p-[18px]">
            <div className="mb-2.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
              Capture a lead
            </div>
            <textarea
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
              placeholder="Paste a LinkedIn profile URL and the page text — or capture it with the browser extension while viewing the profile."
              className="min-h-[84px] w-full resize-y rounded-[10px] border border-line bg-[rgba(0,5,29,0.5)] p-3 text-[13px] text-ink outline-none placeholder:text-muted focus:border-accent"
            />
            {urlOnly && (
              <div
                data-testid="research-guidance"
                className="mt-2.5 rounded-[10px] border border-[rgba(245,184,65,0.35)] bg-[rgba(245,184,65,0.08)] px-3.5 py-2.5 text-[12.5px] text-warn"
              >
                Paste the profile <b>text</b> alongside the URL, or let the
                extension read the page — there is nothing to analyse yet.
                {hasExtension && linkedInUrl && (
                  <div className="mt-2">
                    <button
                      onClick={captureWithExtension}
                      disabled={extBusy}
                      data-testid="capture-with-extension"
                      className="rounded-[10px] border border-line bg-panel px-3 py-1.5 text-[12.5px] font-semibold text-ink hover:bg-panel-2 disabled:opacity-60"
                    >
                      {extBusy ? "Reading the profile…" : "Read it with the extension"}
                    </button>
                    {extNote && <span className="ml-2 text-[12px]">{extNote}</span>}
                  </div>
                )}
                {parsed.websites[0] && (
                  <>
                    {" "}
                    <a
                      href={
                        /^https?:\/\//i.test(paste.trim().split(/\s+/)[0] ?? "")
                          ? paste.trim().split(/\s+/)[0]
                          : `https://${parsed.websites[0]}`
                      }
                      target="_blank"
                      rel="noreferrer"
                      className="underline hover:text-ink"
                    >
                      Open profile ↗
                    </a>
                  </>
                )}
              </div>
            )}

            {(parsed.emails[0] || parsed.phones[0] || parsed.city || parsed.domain) && (
              <div
                data-testid="preparse-chips"
                className="mt-2.5 flex flex-wrap gap-1.5 text-[11.5px]"
              >
                <span className="text-muted">Found without AI:</span>
                {[parsed.emails[0], parsed.phones[0], parsed.domain, parsed.city]
                  .filter(Boolean)
                  .map((v) => (
                    <span
                      key={v as string}
                      className="rounded-full border border-line bg-panel-2 px-2 py-0.5 text-[#C9CEE3]"
                    >
                      {v}
                    </span>
                  ))}
              </div>
            )}

            <div className="mt-3 flex flex-wrap items-center gap-2.5">
              <button
                onClick={() => startTransition(researchFromPaste)}
                title={canResearch ? undefined : "Needs profile text, not just a URL"}
                data-testid="research-button"
                disabled={pending || rail.status === "streaming" || !canResearch}
                className="rounded-[10px] border-[1.5px] border-transparent bg-canvas px-4 py-2 text-[13px] font-semibold text-ink shadow-glow [background-clip:padding-box,border-box] [background-image:linear-gradient(#00051D,#00051D),linear-gradient(135deg,#310B59,#7427C6)] [background-origin:border-box] disabled:opacity-60"
              >
                ✦ Research with Claude
              </button>
              <button
                onClick={() => setShowManual(true)}
                className="rounded-[10px] border border-line bg-panel px-4 py-2 text-[13px] font-semibold text-ink hover:bg-panel-2"
              >
                Add manually
              </button>
              <button
                onClick={() => setShowCsv(true)}
                className="rounded-[10px] border border-line bg-panel px-4 py-2 text-[13px] font-semibold text-ink hover:bg-panel-2"
              >
                Import CSV
              </button>
              <span className="ml-auto text-[12px] text-muted">
                Research runs take ~10s · nothing is sent anywhere
              </span>
            </div>
          </div>

          {/* table */}
          <div className="rounded-card border border-line bg-panel px-0 pb-0 pt-1.5">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  {["Lead", "ICP score", "Signals", "Stage", ""].map((h) => (
                    <th
                      key={h}
                      className="border-b border-line px-3 py-2.5 text-left text-[10.5px] font-semibold uppercase tracking-[0.1em] text-muted"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {leads.length === 0 && (
                  <tr>
                    <td className="px-3 py-6 text-center text-[13px] text-muted" colSpan={5}>
                      No leads yet. Capture one above.
                    </td>
                  </tr>
                )}
                {leads.map((l) => {
                  const ready = (l.icpScore ?? 0) >= threshold;
                  return (
                    <tr key={l.id} className="hover:[&>td]:bg-panel">
                      <td className="border-b border-line px-3 py-3 text-[13px] align-middle">
                        <span className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => setDetailFor(l.id)}
                            data-testid="lead-open-detail"
                            title="Open to edit or delete"
                            className="text-left font-bold hover:text-accent-ink hover:underline"
                          >
                            {l.contactName ?? "Unnamed contact"}
                          </button>
                          {l.riskLabel && <RiskChip label={l.riskLabel} />}
                        </span>
                        <span className="block text-[12px] text-muted">
                          {l.company}
                          {l.industry ? ` · ${l.industry}` : ""}
                          {l.sizeBand ? ` · ${l.sizeBand}` : ""}
                        </span>
                      </td>
                      <td className="border-b border-line px-3 py-3 text-[13px] align-middle">
                        <Notches score={l.icpScore} />
                        <b className="ml-1.5">{l.icpScore ?? "—"}</b>
                      </td>
                      <td className="border-b border-line px-3 py-3 text-[13px] align-middle">
                        {l.signals.slice(0, 3).map((s, i) => (
                          <Tag key={i}>{s}</Tag>
                        ))}
                      </td>
                      <td className="border-b border-line px-3 py-3 text-[13px] align-middle">
                        {l.stage === "RESEARCHED" && l.icpScore != null && !ready ? (
                          <span className="rounded-[6px] border border-dashed border-line px-1.5 py-0.5 text-[10.5px] text-muted">
                            below gate — can&apos;t contact
                          </span>
                        ) : (
                          <span className="text-[12px] text-muted">
                            {l.stage.toLowerCase().replace("_", " ")}
                          </span>
                        )}
                      </td>
                      <td className="border-b border-line px-3 py-3 text-[13px] align-middle">
                        <div className="flex justify-end gap-2">
                          {l.icpScore == null ? (
                            <button
                              onClick={() => startTransition(() => research(l.id))}
                              disabled={pending}
                              className="rounded-[10px] border border-line bg-panel px-3 py-1.5 text-[12px] hover:bg-panel-2 disabled:opacity-60"
                            >
                              Run research
                            </button>
                          ) : l.stage === "RESEARCHED" ? (
                            <button
                              onClick={() => startTransition(() => toContacted(l.id))}
                              disabled={pending}
                              className="rounded-[10px] border border-line bg-panel px-3 py-1.5 text-[12px] hover:bg-panel-2 disabled:opacity-60"
                              title={ready ? "Move to Contacted" : "Blocked by the score gate"}
                            >
                              → Contacted
                            </button>
                          ) : (
                            <span className="text-[11px] text-muted">—</span>
                          )}
                          {l.companyId && (
                            <button
                              onClick={() => setEnrichFor(l.companyId)}
                              className="rounded-[10px] border border-line bg-panel px-3 py-1.5 text-[12px] hover:bg-panel-2"
                            >
                              Enrich
                            </button>
                          )}
                          <button
                            onClick={() => setOverrideFor(l.id)}
                            className="rounded-[10px] border border-line bg-panel px-3 py-1.5 text-[12px] hover:bg-panel-2"
                          >
                            Override
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <ClaudeRail
          state={rail}
          threshold={threshold}
          onOverride={(id) => setOverrideFor(id)}
          onAddToPipeline={(id) => startTransition(() => toContacted(id))}
        />
      </div>

      {detailFor && (
        <LeadDetailModal leadId={detailFor} onClose={() => setDetailFor(null)} />
      )}

      {showManual && (
        <ManualLeadForm
          onClose={() => setShowManual(false)}
          onDone={() => {
            setShowManual(false);
            router.refresh();
          }}
        />
      )}
      {showCsv && (
        <CsvImport
          onClose={() => setShowCsv(false)}
          onDone={() => {
            setShowCsv(false);
            router.refresh();
          }}
        />
      )}
      {overrideFor && (
        <OverrideDialog
          leadId={overrideFor}
          onClose={() => setOverrideFor(null)}
          onDone={() => {
            setOverrideFor(null);
            router.refresh();
          }}
        />
      )}
      {enrichFor && (
        <EnrichDialog
          companyId={enrichFor}
          onClose={() => setEnrichFor(null)}
          onDone={() => {
            setEnrichFor(null);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

function EnrichDialog({
  companyId,
  onClose,
  onDone,
}: {
  companyId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [candidates, setCandidates] = useState<RegistryCandidate[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    enrichCompanyLookup(companyId)
      .then((r) => active && setCandidates(r.candidates))
      .catch((e) => active && setMsg((e as Error).message));
    return () => {
      active = false;
    };
  }, [companyId]);

  async function pick(c: RegistryCandidate) {
    setBusy(true);
    setMsg(null);
    try {
      const res = await confirmEnrichment(companyId, c);
      if (res.ok) onDone();
      else setMsg(res.error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal>
      <div className="mb-3 flex items-center">
        <h3 className="font-display text-lg font-bold lowercase">registry enrichment</h3>
        <button onClick={onClose} className="ml-auto text-muted hover:text-ink">
          ✕
        </button>
      </div>
      <p className="mb-3 text-[12px] text-muted">
        Confirm the matching company. adószám becomes the dedupe key; a company
        under proceedings is flagged.
      </p>
      {msg && <p className="mb-2 text-[12px] text-[#FFB3C2]">{msg}</p>}
      {candidates === null && !msg ? (
        <p className="text-[13px] text-muted">Looking up…</p>
      ) : candidates && candidates.length === 0 ? (
        <p className="text-[13px] text-muted">No registry matches found.</p>
      ) : (
        <div className="grid gap-2">
          {candidates?.map((c) => (
            <div
              key={c.taxId}
              className="flex items-center gap-3 rounded-[10px] border border-line bg-panel p-3"
            >
              <div className="min-w-0 flex-1">
                <b className="text-[13px]">{c.legalName}</b>
                <span className="block text-[11.5px] text-muted">
                  adószám {c.taxId}
                  {c.headcountBand ? ` · ${c.headcountBand}` : ""}
                  {c.revenueBand ? ` · ${c.revenueBand}` : ""}
                </span>
                {companyUnderProceedings(c.statusFlags) && (
                  <span className="mt-1 inline-block">
                    <RiskChip label="Under proceedings" />
                  </span>
                )}
              </div>
              <button
                onClick={() => pick(c)}
                disabled={busy}
                className="rounded-[10px] border border-line bg-panel px-3 py-1.5 text-[12px] hover:bg-panel-2 disabled:opacity-60"
              >
                Use this
              </button>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

// ---- modals ---------------------------------------------------------------

function OverrideDialog({
  leadId,
  onClose,
  onDone,
}: {
  leadId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [score, setScore] = useState(3);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <Modal>
      <div className="mb-3 flex items-center">
        <h3 className="font-display text-lg font-bold lowercase">override icp score</h3>
        <button onClick={onClose} className="ml-auto text-muted hover:text-ink">
          ✕
        </button>
      </div>
      <p className="mb-2 text-[12px] text-muted">
        Overrides are recorded in the audit log with your reason.
      </p>
      <div className="mb-3 flex gap-2">
        {[0, 1, 2, 3, 4, 5].map((s) => (
          <button
            key={s}
            onClick={() => setScore(s)}
            className={`h-9 w-9 rounded-[8px] border text-[13px] font-semibold ${
              score === s ? "border-accent bg-accent-soft text-[#E4D3FF]" : "border-line bg-panel text-ink"
            }`}
          >
            {s}
          </button>
        ))}
      </div>
      <input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Reason (required)"
        className="mb-3 w-full rounded-[8px] border border-line bg-[rgba(0,5,29,0.5)] px-2.5 py-2 text-[13px] text-ink outline-none placeholder:text-muted focus:border-accent"
      />
      <div className="flex justify-end gap-2">
        <button
          onClick={onClose}
          className="rounded-[10px] border border-line bg-panel px-4 py-2 text-[13px] hover:bg-panel-2"
        >
          Cancel
        </button>
        <button
          disabled={busy || !reason.trim()}
          onClick={async () => {
            setBusy(true);
            await overrideScore(leadId, score, reason.trim());
            setBusy(false);
            onDone();
          }}
          className="rounded-[10px] border-[1.5px] border-transparent bg-canvas px-4 py-2 text-[13px] font-semibold text-ink shadow-glow [background-clip:padding-box,border-box] [background-image:linear-gradient(#00051D,#00051D),linear-gradient(135deg,#310B59,#7427C6)] [background-origin:border-box] disabled:opacity-60"
        >
          {busy ? "Saving…" : "Save override"}
        </button>
      </div>
    </Modal>
  );
}
