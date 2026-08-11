import type { WorkspaceClient } from "../../lib/db";
import type { WeekFact } from "./logic";

/**
 * Build weekly activity facts for the Signal Engine (spec §4.13). Cohort = leads
 * contacted (outbound message) in the window. Each lead contributes dimension
 * keys (frame, hook, signal, segment, send-time, source) joined with its
 * acceptance/reply state and latest win/loss outcome. Aggregated downstream.
 */
const ACCEPTED_STAGES = new Set(["ACCEPTED", "REPLIED", "QUALIFIED", "MEETING_BOOKED", "HANDED_OFF"]);
const REPLIED_STAGES = new Set(["REPLIED", "QUALIFIED", "MEETING_BOOKED", "HANDED_OFF"]);

function sendTimeBucket(d: Date): string {
  const h = d.getUTCHours();
  if (h < 12) return "morning";
  if (h < 17) return "afternoon";
  return "evening";
}

export async function getWeekFacts(
  db: WorkspaceClient,
  sinceMs: number,
  untilMs: number,
): Promise<WeekFact[]> {
  const since = new Date(sinceMs);
  const until = new Date(untilMs);

  // Cohort: outbound messages sent this week.
  const outbound = await db.message.findMany({
    where: {
      direction: "OUTBOUND",
      OR: [
        { sentAt: { gte: since, lt: until } },
        { sentAt: null, createdAt: { gte: since, lt: until } },
      ],
    },
    select: { leadId: true, kind: true, sentAt: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  if (outbound.length === 0) return [];

  const firstTouch = new Map<string, { kind: string | null; at: Date }>();
  for (const m of outbound) {
    if (!firstTouch.has(m.leadId)) firstTouch.set(m.leadId, { kind: m.kind, at: m.sentAt ?? m.createdAt });
  }
  const leadIds = [...firstTouch.keys()];

  const [leads, inbound, outcomes, recipients] = await Promise.all([
    db.lead.findMany({
      where: { id: { in: leadIds } },
      select: { id: true, source: true, signals: true, stage: true, company: { select: { industry: true } } },
    }),
    db.message.findMany({
      where: { leadId: { in: leadIds }, direction: "INBOUND" },
      select: { leadId: true },
    }),
    db.dealOutcome.findMany({
      where: { leadId: { in: leadIds } },
      orderBy: { at: "desc" },
      select: { leadId: true, result: true, value: true },
    }),
    db.campaignRecipient.findMany({
      where: { leadId: { in: leadIds } },
      select: { leadId: true, campaign: { select: { frame: { select: { name: true } } } } },
    }),
  ]);

  const repliedLeads = new Set(inbound.map((m) => m.leadId));
  const latestOutcome = new Map<string, { result: string; value: number | null }>();
  for (const o of outcomes) if (!latestOutcome.has(o.leadId)) latestOutcome.set(o.leadId, { result: o.result, value: o.value });
  const frameByLead = new Map<string, string>();
  for (const r of recipients) {
    if (r.leadId && r.campaign?.frame?.name && !frameByLead.has(r.leadId)) {
      frameByLead.set(r.leadId, r.campaign.frame.name);
    }
  }

  const facts: WeekFact[] = [];
  for (const lead of leads) {
    const touch = firstTouch.get(lead.id);
    const dims: string[] = [`source:${lead.source}`];
    if (lead.company?.industry) dims.push(`segment:${lead.company.industry}`);
    const signals = Array.isArray(lead.signals) ? (lead.signals as string[]) : [];
    for (const s of signals) if (typeof s === "string") dims.push(`signal:${s}`);
    if (touch?.kind) dims.push(`hook:${touch.kind}`);
    if (touch?.at) dims.push(`sendtime:${sendTimeBucket(touch.at)}`);
    const frame = frameByLead.get(lead.id);
    if (frame) dims.push(`frame:${frame}`);

    const o = latestOutcome.get(lead.id);
    const won = o?.result === "WON" ? 1 : 0;
    const lost = o?.result === "LOST" ? 1 : 0;
    facts.push({
      dims,
      sent: 1,
      accepted: ACCEPTED_STAGES.has(lead.stage) ? 1 : 0,
      replied: repliedLeads.has(lead.id) || REPLIED_STAGES.has(lead.stage) ? 1 : 0,
      won,
      lost,
      revenue: won ? o?.value ?? 0 : 0,
    });
  }
  return facts;
}

/** The trailing 7-day window ending at `nowMs`. */
export function weekWindow(nowMs: number): { sinceMs: number; untilMs: number } {
  return { sinceMs: nowMs - 7 * 24 * 60 * 60_000, untilMs: nowMs };
}
