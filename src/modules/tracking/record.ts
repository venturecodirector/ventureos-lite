import { createHash } from "node:crypto";
import { getWorkspaceClient } from "@/lib/db";
import type { PageTarget, PageType, TrackBeacon } from "./types";

/**
 * Turning a beacon into a row (playbook-v3 P8/a).
 *
 * One row per reading SESSION per page, updated by the heartbeats rather than
 * appended to — so "distinct sessions" is a count of rows and the duration is
 * the real attention span rather than a sum of pings.
 */

/** How long a beacon may claim to have been read for, per heartbeat window. */
const MAX_DURATION_MS = 4 * 60 * 60 * 1000;
const MAX_SECTIONS = 24;

/**
 * The IP, one way only.
 *
 * The salt is the app secret, so the hash is useless to anyone who obtains the
 * table alone, and identical addresses still collapse to one value inside a
 * deployment — which is all the abuse-spotting needs.
 */
export function hashIp(ip: string, salt: string): string {
  return createHash("sha256").update(`${salt}|${ip}`).digest("hex").slice(0, 40);
}

/** Trust nothing a browser sent: it is a public endpoint and anyone can post. */
export function sanitizeBeacon(raw: TrackBeacon): {
  durationMs: number;
  scrollPct: number;
  sections: Record<string, number>;
  referrer: string | null;
  viewport: string | null;
} {
  const durationMs = Math.max(0, Math.min(MAX_DURATION_MS, Math.round(Number(raw.d) || 0)));
  const scrollPct = Math.max(0, Math.min(100, Math.round(Number(raw.sd) || 0)));

  const sections: Record<string, number> = {};
  const entries = Object.entries(raw.sec ?? {}).slice(0, MAX_SECTIONS);
  for (const [key, value] of entries) {
    const name = String(key).slice(0, 40);
    const ms = Math.max(0, Math.min(MAX_DURATION_MS, Math.round(Number(value) || 0)));
    if (name && ms > 0) sections[name] = ms;
  }

  const referrer = typeof raw.r === "string" && raw.r ? raw.r.slice(0, 300) : null;
  const viewport = raw.v === "mobile" || raw.v === "desktop" ? raw.v : null;
  return { durationMs, scrollPct, sections, referrer, viewport };
}

export interface RecordInput {
  pageType: PageType;
  slug: string;
  target: PageTarget;
  beacon: TrackBeacon;
  ip: string | null;
  ipSalt: string;
}

/**
 * Record or update a visit. Returns an id ONLY when a new session started —
 * that is the one moment enrichment is worth queueing. A heartbeat arriving
 * every fifteen seconds must not queue a reverse-DNS lookup every time.
 *
 * A Do-Not-Track visitor gets a row with the view and NOTHING else: no
 * duration, no sections, no referrer, no address and no hash. The row exists
 * because a bare view count is what the playbook allows, and because a page
 * with no rows at all is indistinguishable from a page nobody opened.
 */
export async function recordVisit(input: RecordInput): Promise<string | null> {
  const db = getWorkspaceClient(input.target.workspaceId);
  const dnt = input.beacon.dnt === 1;
  const now = new Date();

  const existing = await db.pageVisit.findFirst({
    where: {
      sessionToken: input.beacon.t,
      pageSlug: input.slug,
      pageType: input.pageType,
    },
    select: { id: true, durationMs: true, scrollPct: true, doNotTrack: true },
  });

  if (dnt) {
    if (existing) return null;
    await db.pageVisit.create({
      data: {
        workspaceId: input.target.workspaceId,
        pageType: input.pageType,
        pageSlug: input.slug,
        leadId: input.target.leadId,
        companyId: input.target.companyId,
        documentId: input.target.documentId,
        auditId: input.target.auditId,
        sessionToken: input.beacon.t,
        lastSeenAt: now,
        doNotTrack: true,
      },
    });
    return null;
  }

  const clean = sanitizeBeacon(input.beacon);

  if (existing) {
    // A visitor who opted out mid-session does not get their earlier row
    // enriched afterwards, and a heartbeat can only ever move these forward.
    if (existing.doNotTrack) return null;
    await db.pageVisit.update({
      where: { id: existing.id },
      data: {
        lastSeenAt: now,
        durationMs: Math.max(existing.durationMs, clean.durationMs),
        scrollPct: Math.max(existing.scrollPct, clean.scrollPct),
        ...(Object.keys(clean.sections).length > 0 ? { sections: clean.sections } : {}),
      },
    });
    return null;
  }

  const created = await db.pageVisit.create({
    data: {
      workspaceId: input.target.workspaceId,
      pageType: input.pageType,
      pageSlug: input.slug,
      leadId: input.target.leadId,
      companyId: input.target.companyId,
      documentId: input.target.documentId,
      auditId: input.target.auditId,
      sessionToken: input.beacon.t,
      referrer: clean.referrer,
      viewport: clean.viewport,
      lastSeenAt: now,
      durationMs: clean.durationMs,
      scrollPct: clean.scrollPct,
      sections: clean.sections,
      // Raw for the enrichment worker, hashed for what survives it.
      ipRaw: input.ip,
      ipHash: input.ip ? hashIp(input.ip, input.ipSalt) : null,
    },
    select: { id: true },
  });
  return created.id;
}
