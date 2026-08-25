import { prismaUnsafe, getWorkspaceClient, type WorkspaceClient } from "@/lib/db";
import { createTaskFromSignal } from "@/modules/tasks/from-signal";
import { safeDeliver } from "@/modules/notifications/notify";
import { leadRecipients } from "@/modules/notifications/recipients";
import {
  evaluateQuote,
  quoteRulesFrom,
  type QuoteFacts,
  type QuoteRulesSettings,
  type RuleHit,
} from "./rules";

/**
 * Running the quote-behaviour rules (playbook-v4 P14/3).
 *
 * Nothing here sends anything. A rule produces a task and, when configured, a
 * DRAFT message a human has to open, read and send — CLAUDE.md hard rule #2 is
 * not softened by the fact that a rule rather than a person decided to write it.
 */

export async function loadQuoteRules(workspaceId: string): Promise<QuoteRulesSettings> {
  const ws = await prismaUnsafe.workspace.findUnique({
    where: { id: workspaceId },
    select: { featureFlags: true },
  });
  const flags = (ws?.featureFlags ?? {}) as Record<string, unknown>;
  return quoteRulesFrom(flags.quoteRules);
}

/**
 * Assemble what the rules are allowed to look at, from the P8 visit rows.
 *
 * One quote, one pass. The section totals are summed across sessions because
 * "how long did they spend on the price" is a question about the reader, not
 * about any single visit.
 */
export async function factsForQuote(
  db: WorkspaceClient,
  documentId: string,
  acceptSlug: string,
): Promise<QuoteFacts> {
  const [visits, acceptance, runs] = await Promise.all([
    db.pageVisit.findMany({
      where: { pageType: "quote", pageSlug: acceptSlug },
      select: { sessionToken: true, sections: true, scrollPct: true, startedAt: true },
      orderBy: { startedAt: "desc" },
      take: 500,
    }),
    db.quoteAcceptance.findFirst({ where: { documentId }, select: { id: true } }),
    db.quoteRuleRun.findMany({ where: { documentId }, select: { ruleId: true } }),
  ]);

  let pricingMs = 0;
  let scopeMs = 0;
  let reachedScope = false;
  const sessions = new Set<string>();
  for (const v of visits) {
    sessions.add(v.sessionToken);
    const sec = (v.sections ?? {}) as Record<string, number>;
    pricingMs += Number(sec.pricing ?? 0);
    scopeMs += Number(sec.scope ?? 0);
    // Either they spent time in the scope section or they scrolled past it.
    if (Number(sec.scope ?? 0) > 0 || v.scrollPct >= 90) reachedScope = true;
  }

  return {
    documentId,
    sessions: sessions.size,
    pricingMs,
    scopeMs,
    reachedScope,
    lastOpenedAt: visits[0]?.startedAt ?? null,
    accepted: !!acceptance,
    alreadyFired: runs.map((r) => r.ruleId),
  };
}

/** Turn one hit into a task, a draft and a log row. Idempotent by construction. */
async function applyHit(
  db: WorkspaceClient,
  workspaceId: string,
  hit: RuleHit,
  doc: { id: string; leadId: string; number: string | null },
): Promise<void> {
  const label = doc.number ?? "az ajánlat";

  const taskId = await createTaskFromSignal(db, {
    workspaceId,
    title: `${label} — ${hit.taskTitle}`,
    note: `${hit.reason}. ${hit.taskNote}`,
    type: "call",
    entityType: "lead",
    entityId: doc.leadId,
    source: `quote_rule:${hit.ruleId}`,
    dueInDays: 0,
  });

  let draftId: string | null = null;
  if (hit.draftSubject && hit.draftBody) {
    const draft = await db.message.create({
      data: {
        workspaceId,
        leadId: doc.leadId,
        direction: "OUTBOUND",
        channel: "EMAIL",
        kind: `quote_rule:${hit.ruleId}`,
        body: `${hit.draftSubject}\n\n${hit.draftBody}`,
        status: "DRAFT",
        // Not AI-drafted: this is template text with the quote's own facts in
        // it, so the human-edit guardrail that governs Claude drafts does not
        // apply — but it still cannot be sent from here.
        aiDrafted: false,
      },
      select: { id: true },
    });
    draftId = draft.id;
  }

  // The unique key is what makes a daily sweep safe to run.
  await db.quoteRuleRun.create({
    data: {
      workspaceId,
      documentId: doc.id,
      ruleId: hit.ruleId,
      reason: hit.reason,
      taskId,
      draftId,
    },
  });

  await safeDeliver({
    workspaceId,
    userIds: await leadRecipients(workspaceId, doc.leadId),
    type: "visitor_signal",
    title: `${label}: ${hit.reason}`,
    body: hit.taskTitle,
    href: `/leads?lead=${doc.leadId}`,
    entityType: "lead",
    entityId: doc.leadId,
    discriminator: `quote-rule:${doc.id}:${hit.ruleId}`,
  });
}

/** Evaluate one quote. Returns the rules that fired. */
export async function runRulesForQuote(
  workspaceId: string,
  documentId: string,
  now: Date = new Date(),
): Promise<string[]> {
  const db = getWorkspaceClient(workspaceId);
  const doc = await db.document.findUnique({
    where: { id: documentId },
    select: { id: true, leadId: true, number: true, acceptSlug: true, type: true },
  });
  if (!doc || doc.type !== "QUOTE" || !doc.leadId || !doc.acceptSlug) return [];

  const [settings, facts] = await Promise.all([
    loadQuoteRules(workspaceId),
    factsForQuote(db, doc.id, doc.acceptSlug),
  ]);
  const hits = evaluateQuote(facts, settings, now);

  for (const hit of hits) {
    await applyHit(db, workspaceId, hit, {
      id: doc.id,
      leadId: doc.leadId,
      number: doc.number,
    }).catch((e) => {
      // A unique-key clash means a concurrent sweep got there first, which is
      // the guarantee working rather than a failure.
      // eslint-disable-next-line no-console
      console.error(`[quote-rules] ${hit.ruleId} on ${doc.id}:`, (e as Error).message);
    });
  }
  return hits.map((h) => h.ruleId);
}

/**
 * Close the loop: mark every rule that fired on a quote that has since been
 * accepted (P14/3 — "track which rules save quotes").
 */
export async function markAcceptedQuotes(workspaceId: string): Promise<number> {
  const db = getWorkspaceClient(workspaceId);
  const open = await db.quoteRuleRun.findMany({
    where: { acceptedAt: null },
    select: { id: true, documentId: true },
  });
  if (open.length === 0) return 0;

  const accepted = await db.quoteAcceptance.findMany({
    where: { documentId: { in: [...new Set(open.map((r) => r.documentId))] } },
    select: { documentId: true, at: true },
    orderBy: { at: "asc" },
  });
  const acceptedAt = new Map(accepted.map((a) => [a.documentId, a.at]));

  let marked = 0;
  for (const run of open) {
    const at = acceptedAt.get(run.documentId);
    if (!at) continue;
    await db.quoteRuleRun.update({ where: { id: run.id }, data: { acceptedAt: at } });
    marked += 1;
  }
  return marked;
}

export interface RuleEffectiveness {
  ruleId: string;
  fired: number;
  accepted: number;
  /** Null below a handful of firings — a rate from three samples is noise. */
  rate: number | null;
}

const MIN_SAMPLE = 5;

export async function ruleEffectiveness(workspaceId: string): Promise<RuleEffectiveness[]> {
  const db = getWorkspaceClient(workspaceId);
  const runs = await db.quoteRuleRun.findMany({ select: { ruleId: true, acceptedAt: true } });
  const byRule = new Map<string, { fired: number; accepted: number }>();
  for (const r of runs) {
    const row = byRule.get(r.ruleId) ?? { fired: 0, accepted: 0 };
    row.fired += 1;
    if (r.acceptedAt) row.accepted += 1;
    byRule.set(r.ruleId, row);
  }
  return [...byRule.entries()].map(([ruleId, v]) => ({
    ruleId,
    fired: v.fired,
    accepted: v.accepted,
    rate: v.fired >= MIN_SAMPLE ? v.accepted / v.fired : null,
  }));
}
