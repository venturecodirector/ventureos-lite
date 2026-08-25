import { safeDeliver } from "@/modules/notifications/notify";
import { leadRecipients, allMembers } from "@/modules/notifications/recipients";
import type { Confidence, PageType } from "./types";

/**
 * "Danubia Kft. megnézte az ajánlatot — 2 perc 40 mp" (playbook-v3 P8/b).
 *
 * NEVER PRESENTED AS A FACT. A medium-confidence identification is a company
 * NAME that looks like the domain a reverse lookup returned, which is a good
 * guess and not evidence. The copy says "valószínűleg" and the wording is here
 * rather than at the call site so it cannot drift.
 */
export function visitorSignalTitle(params: {
  companyName: string;
  pageLabel: string;
  confidence: Confidence;
}): string {
  const who =
    params.confidence === "high" ? params.companyName : `Valószínűleg ${params.companyName}`;
  return `${who} megnézte: ${params.pageLabel}`;
}

/** "2 perc 40 mp", "35 mp" — a reading time a person can judge at a glance. */
export function readingTime(durationMs: number): string {
  const total = Math.max(0, Math.round(durationMs / 1000));
  if (total < 60) return `${total} mp`;
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return sec === 0 ? `${min} perc` : `${min} perc ${sec} mp`;
}

export async function notifyVisitorSignal(params: {
  workspaceId: string;
  leadId: string | null;
  companyName: string;
  pageType: PageType;
  pageLabel: string;
  confidence: Confidence;
  durationMs: number;
  signalId: string;
}): Promise<void> {
  // Whoever works the lead; if the page was not addressed to anyone, everyone.
  const userIds = params.leadId
    ? await leadRecipients(params.workspaceId, params.leadId)
    : await allMembers(params.workspaceId);

  await safeDeliver({
    workspaceId: params.workspaceId,
    userIds,
    type: "visitor_signal",
    title: visitorSignalTitle(params),
    body: `Olvasási idő: ${readingTime(params.durationMs)}`,
    href: params.leadId ? `/leads?lead=${params.leadId}` : "/public-pages",
    entityType: params.leadId ? "lead" : "public_page",
    entityId: params.leadId ?? params.signalId,
    // One per signal — the daily cap is enforced before the signal is created.
    discriminator: params.signalId,
  });
}
