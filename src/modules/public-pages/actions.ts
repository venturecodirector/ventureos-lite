"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { requireOwner } from "@/lib/authz";
import { auditShareLink, bookingLink, quoteAcceptLink } from "@/lib/public-links";
import { isShareExpired } from "@/modules/audit/share";

/**
 * The Public Pages screen (spec §4.4 / §4.9 / §4.21) — one place to see every
 * prospect-facing URL this workspace has handed out, whether it still resolves,
 * and whether anyone opened it.
 *
 * The nav entry existed with no href and no screen behind it. The three public
 * ROUTES worked; what was missing was any way for an operator to find the links
 * or tell a live one from an expired one.
 *
 * Everything here is workspace-scoped through getWorkspaceClient (hard rule #1).
 */

export interface AuditShareRow {
  id: string;
  slug: string;
  url: string;
  companyName: string;
  auditUrl: string;
  score: number | null;
  expiresAt: string;
  expired: boolean;
  firstOpenedAt: string | null;
  openCount: number;
}

export interface QuoteLinkRow {
  id: string;
  number: string;
  url: string;
  clientName: string;
  status: string;
  acceptedByName: string | null;
  acceptedAt: string | null;
}

export interface BookingPageRow {
  id: string;
  slug: string;
  url: string;
  title: string;
  hostName: string;
  active: boolean;
  upcomingMeetings: number;
}

export interface PublicPagesView {
  shares: AuditShareRow[];
  quotes: QuoteLinkRow[];
  bookings: BookingPageRow[];
}

/** Hostname of an audited URL, without the www. prefix. Null if unparseable. */
function hostOf(url: string): string | null {
  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

export async function getPublicPages(): Promise<PublicPagesView> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const now = new Date();

  const [shares, quotes, bookings] = await Promise.all([
    db.auditShare.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { audit: { select: { url: true, score: true, company: { select: { name: true } } } } },
    }),
    db.document.findMany({
      where: { type: "QUOTE", acceptSlug: { not: null } },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: {
        lead: { select: { contactName: true, company: { select: { name: true } } } },
        acceptances: { orderBy: { at: "desc" }, take: 1 },
      },
    }),
    db.bookingPage.findMany({ orderBy: { createdAt: "asc" } }),
  ]);

  // Host names and meeting counts are per booking page; fetch once, not per row.
  const hostIds = [...new Set(bookings.map((b) => b.hostUserId))];
  // `users` is a global table, not workspace-scoped — the guarded client does
  // not cover it. Safe here: the ids come from this workspace's booking pages.
  const hosts = hostIds.length
    ? await prismaUnsafe.user.findMany({
        where: { id: { in: hostIds } },
        select: { id: true, name: true },
      })
    : [];
  const hostName = new Map(hosts.map((h) => [h.id, h.name]));

  const counts = await Promise.all(
    bookings.map((b) =>
      db.meeting.count({ where: { hostUserId: b.hostUserId, scheduledAt: { gte: now } } }),
    ),
  );

  return {
    shares: shares.map((s) => ({
      id: s.id,
      slug: s.slug,
      url: auditShareLink(s.slug),
      // Audits started before companyId was populated (and any run against a
      // URL we hold no company for) still have something meaningful to show:
      // the audited host beats a bare dash.
      companyName: s.audit.company?.name ?? hostOf(s.audit.url) ?? "—",
      auditUrl: s.audit.url,
      score: s.audit.score,
      expiresAt: s.expiresAt.toISOString(),
      expired: isShareExpired(s.expiresAt, now),
      firstOpenedAt: s.firstOpenedAt?.toISOString() ?? null,
      openCount: s.openCount,
    })),
    quotes: quotes.map((d) => ({
      id: d.id,
      number: d.number ?? "—",
      url: quoteAcceptLink(d.acceptSlug!),
      clientName: d.lead?.company?.name ?? d.lead?.contactName ?? "—",
      status: d.status,
      acceptedByName: d.acceptances[0]?.acceptedByName ?? null,
      acceptedAt: d.acceptances[0]?.at.toISOString() ?? null,
    })),
    bookings: bookings.map((b, i) => ({
      id: b.id,
      slug: b.slug,
      url: bookingLink(b.slug),
      title: b.title ?? "Book a call",
      hostName: hostName.get(b.hostUserId) ?? "—",
      active: b.active,
      upcomingMeetings: counts[i] ?? 0,
    })),
  };
}

/** Revoke a share immediately by expiring it (the link 410s from then on). */
export async function revokeAuditShare(
  raw: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = z.object({ shareId: z.string().min(1) }).safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Unknown share." };

  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const share = await db.auditShare.findUnique({
    where: { id: parsed.data.shareId },
    select: { id: true, slug: true },
  });
  if (!share) return { ok: false, error: "Share not found." };

  await db.auditShare.update({
    where: { id: share.id },
    // Backdate rather than delete: the audit trail of who opened it survives.
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  await db.auditLog.create({
    data: {
      workspaceId,
      actorUserId: userId,
      action: "public.share_revoked",
      entityType: "AuditShare",
      entityId: share.id,
      meta: { slug: share.slug },
    },
  });
  revalidatePath("/public-pages");
  return { ok: true };
}

/** Take a booking page offline (or back online) — Owner only. */
export async function setBookingPageActive(
  raw: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await requireOwner();
  } catch {
    return { ok: false, error: "Only an Owner can change the booking page." };
  }
  const parsed = z
    .object({ bookingPageId: z.string().min(1), active: z.boolean() })
    .safeParse(raw);
  if (!parsed.success) return { ok: false, error: "Check the request." };

  const { workspaceId, userId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const page = await db.bookingPage.findUnique({
    where: { id: parsed.data.bookingPageId },
    select: { id: true, slug: true },
  });
  if (!page) return { ok: false, error: "Booking page not found." };

  await db.bookingPage.update({
    where: { id: page.id },
    data: { active: parsed.data.active },
  });
  await db.auditLog.create({
    data: {
      workspaceId,
      actorUserId: userId,
      action: parsed.data.active ? "public.booking_enabled" : "public.booking_disabled",
      entityType: "BookingPage",
      entityId: page.id,
      meta: { slug: page.slug },
    },
  });
  revalidatePath("/public-pages");
  return { ok: true };
}
