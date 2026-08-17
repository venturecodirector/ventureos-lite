"use server";

import { getWorkspaceClient } from "@/lib/db";
import { getActiveContext } from "@/lib/session";

/**
 * The capture's own account of itself, for the lead card.
 *
 * Two rounds of the extraction bug were expensive for the same reason: the
 * evidence existed only in a popup message that had already closed. The operator
 * saw "read name" and had nothing to hand over, so each round began by asking
 * them to reproduce it. This makes the evidence a property of the LEAD — open the
 * card, expand the panel, copy it.
 *
 * Read from the capture activity rather than a column on the lead: it is
 * per-capture, it is diagnostic rather than business data, and putting it on the
 * activity means the history of what a re-capture read differently is there too,
 * for free and without a migration.
 */
export interface CaptureDiagnostics {
  at: string;
  kind: "created" | "updated";
  url: string | null;
  city: string | null;
  locationReason: string | null;
  contactReasons: Record<string, string>;
  /** Whatever the extension version that made this capture chose to report. */
  probe: unknown;
}

export async function getCaptureDiagnostics(leadId: string): Promise<CaptureDiagnostics | null> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  // Guarded client, so a lead in another workspace does not exist rather than
  // being forbidden (hard rule #1).
  const activity = await db.activity.findFirst({
    where: { leadId, type: { in: ["capture_created", "capture_updated"] } },
    orderBy: { at: "desc" },
    select: { at: true, type: true, payload: true },
  });
  if (!activity) return null;

  const payload = (activity.payload ?? {}) as Record<string, unknown>;
  const reasons = payload.contactReasons;

  return {
    at: activity.at.toISOString(),
    kind: activity.type === "capture_created" ? "created" : "updated",
    url: typeof payload.url === "string" ? payload.url : null,
    city: typeof payload.city === "string" ? payload.city : null,
    locationReason: typeof payload.locationReason === "string" ? payload.locationReason : null,
    contactReasons:
      reasons && typeof reasons === "object" && !Array.isArray(reasons)
        ? (reasons as Record<string, string>)
        : {},
    probe: payload.diagnostics ?? null,
  };
}
