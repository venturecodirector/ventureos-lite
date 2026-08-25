import { prismaUnsafe, getWorkspaceClient } from "@/lib/db";
import { identifyVisitor } from "./identify";
import { notifyVisitorSignal } from "./notify";
import { createTaskFromSignal } from "@/modules/tasks/from-signal";
import { safeDeliver } from "@/modules/notifications/notify";
import { leadRecipients } from "@/modules/notifications/recipients";
import { PAGE_TYPE_LABEL, SIGNAL_CONFIDENCES, type Confidence, type PageType } from "./types";

/**
 * Visitor identification, one visit at a time (playbook-v3 P8/b).
 *
 * Runs a minute after a session opens, so the duration it reports is a real
 * reading time rather than zero. Never throws: a failed lookup means an
 * unidentified visitor, which is the normal outcome and not an error.
 */

/** A warm-lead flag on the card lasts a week — the playbook's number. */
const WARM_DAYS = 7;
/** One notification per company per page per day (P8/b). */
const NOTIFY_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function processVisitEnrichment(visitId: string): Promise<boolean> {
  const visit = await prismaUnsafe.pageVisit.findUnique({
    where: { id: visitId },
    select: {
      id: true,
      workspaceId: true,
      pageType: true,
      pageSlug: true,
      leadId: true,
      companyId: true,
      ipRaw: true,
      durationMs: true,
      enrichedAt: true,
      doNotTrack: true,
    },
  });
  if (!visit || visit.enrichedAt) return false;

  const db = getWorkspaceClient(visit.workspaceId);

  /**
   * A quote read three times and still not signed (P8/c).
   *
   * Checked for EVERY new session, identified or not — "somebody has opened
   * this quote three times" is actionable on its own, and most visitors are
   * never identified. This is the signal the playbook singles out as the one
   * worth acting on.
   */
  if (visit.pageType === "quote") {
    await raiseRepeatOpenSignal(visit.workspaceId, visit.pageSlug).catch(() => {
      /* the visit is recorded either way */
    });
  }

  // Opted out, or the raw address has already been purged: nothing to identify,
  // but the visit itself has been counted and the quote check above has run.
  if (visit.doNotTrack || !visit.ipRaw) {
    await db.pageVisit.update({
      where: { id: visit.id },
      data: { enrichedAt: new Date(), confidence: "none" },
    });
    return false;
  }
  const companies = await db.company.findMany({
    select: { id: true, name: true, domain: true },
  });

  const id = await identifyVisitor({ ip: visit.ipRaw, companies });

  await db.pageVisit.update({
    where: { id: visit.id },
    data: {
      enrichedAt: new Date(),
      orgName: id.orgName,
      guessCompanyId: id.companyId,
      confidence: id.confidence,
    },
  });

  if (!id.companyId || !SIGNAL_CONFIDENCES.includes(id.confidence)) return false;

  // Rate limit: the same company reading the same page all afternoon is one
  // piece of news, not twelve.
  const recent = await db.visitorSignal.findFirst({
    where: {
      companyId: id.companyId,
      pageSlug: visit.pageSlug,
      at: { gte: new Date(Date.now() - NOTIFY_WINDOW_MS) },
    },
    select: { id: true },
  });
  if (recent) return false;

  // The lead to hang this on: the page's own target first, else any lead at
  // the identified company.
  let leadId = visit.leadId;
  if (!leadId) {
    const lead = await db.lead.findFirst({
      where: { companyId: id.companyId },
      orderBy: { updatedAt: "desc" },
      select: { id: true },
    });
    leadId = lead?.id ?? null;
  }

  const signal = await db.visitorSignal.create({
    data: {
      workspaceId: visit.workspaceId,
      companyId: id.companyId,
      leadId,
      visitId: visit.id,
      pageType: visit.pageType,
      pageSlug: visit.pageSlug,
      confidence: id.confidence,
      durationMs: visit.durationMs,
      warmUntil: new Date(Date.now() + WARM_DAYS * 24 * 60 * 60 * 1000),
    },
    select: { id: true },
  });

  const company = await db.company.findUnique({
    where: { id: id.companyId },
    select: { name: true },
  });

  // The lead timeline, so the visit sits among the calls and emails.
  if (leadId) {
    await db.activity
      .create({
        data: {
          workspaceId: visit.workspaceId,
          leadId,
          type: "visitor_signal",
          payload: {
            pageType: visit.pageType,
            pageSlug: visit.pageSlug,
            confidence: id.confidence,
            durationMs: visit.durationMs,
            company: company?.name ?? null,
          },
        },
      })
      .catch(() => {
        /* the signal matters more than its timeline entry */
      });
  }

  await notifyVisitorSignal({
    workspaceId: visit.workspaceId,
    leadId,
    companyName: company?.name ?? "Egy cég",
    pageType: visit.pageType as PageType,
    pageLabel: PAGE_TYPE_LABEL[visit.pageType as PageType] ?? visit.pageType,
    confidence: id.confidence as Confidence,
    durationMs: visit.durationMs,
    signalId: signal.id,
  });

  return true;
}

/**
 * The 24-hour raw-IP purge (P8/e).
 *
 * The address is kept for exactly one purpose — the reverse lookup above — and
 * the retention promise on the privacy page is 24 hours. This is what makes
 * that sentence true, and a test asserts the boundary.
 */
export async function processRawIpPurge(): Promise<number> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const res = await prismaUnsafe.pageVisit.updateMany({
    where: { ipRaw: { not: null }, startedAt: { lt: cutoff } },
    data: { ipRaw: null },
  });
  return res.count;
}

/**
 * 90-day retention (P8/e): the session is deleted, the count survives.
 *
 * Deliberately a delete of the detail rather than of the row's existence in the
 * aggregate: what the Public Pages view needs after 90 days is "this page was
 * read 14 times", which the VisitorSignal rows and the visit COUNT already
 * carry. Sessions older than that lose everything that could describe a person.
 */
export async function processVisitRetention(): Promise<number> {
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const res = await prismaUnsafe.pageVisit.updateMany({
    where: {
      startedAt: { lt: cutoff },
      OR: [{ ipHash: { not: null } }, { referrer: { not: null } }],
    },
    data: { ipHash: null, ipRaw: null, referrer: null, sections: {}, sessionToken: "expired" },
  });
  return res.count;
}

/** Distinct sessions before a quote's repeat-open signal fires. */
const REPEAT_OPEN_THRESHOLD = 3;

/**
 * "Harmadszor nézte meg — hívd fel" (playbook-v3 P8/c).
 *
 * Fires ONCE per quote: the task is idempotent by source, and the notification
 * carries the document id as its discriminator, so the fourth and fifth reads
 * do not each ring the bell. An accepted quote raises nothing — the reading was
 * the client checking what they signed.
 */
export async function raiseRepeatOpenSignal(
  workspaceId: string,
  slug: string,
): Promise<boolean> {
  const db = getWorkspaceClient(workspaceId);
  const doc = await db.document.findFirst({
    where: { acceptSlug: slug },
    select: { id: true, leadId: true, number: true },
  });
  if (!doc?.leadId) return false;

  const accepted = await db.quoteAcceptance.findFirst({
    where: { documentId: doc.id },
    select: { id: true },
  });
  if (accepted) return false;

  const sessions = await db.pageVisit.count({
    where: { pageType: "quote", pageSlug: slug },
  });
  if (sessions < REPEAT_OPEN_THRESHOLD) return false;

  const label = doc.number ?? "az ajánlat";
  await createTaskFromSignal(db, {
    workspaceId,
    title: `Hívd fel — ${label} ${sessions}× megnyitva, még nincs elfogadva`,
    note: "Az ajánlatot többször is megnyitották, de nem fogadták el. Ez a legjobb pillanat egy hívásra.",
    type: "call",
    entityType: "lead",
    entityId: doc.leadId,
    source: "quote_repeat_open",
    dueInDays: 0,
  });

  await safeDeliver({
    workspaceId,
    userIds: await leadRecipients(workspaceId, doc.leadId),
    type: "visitor_signal",
    title: `${label}: ${sessions}. megnyitás, elfogadás nélkül`,
    body: "Hívd fel — most van nyitva előttük.",
    href: `/leads?lead=${doc.leadId}`,
    entityType: "lead",
    entityId: doc.leadId,
    // Once per document, however many further opens arrive.
    discriminator: `repeat-open:${doc.id}`,
  });
  return true;
}
