"use server";

import { z } from "zod";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { requireGrant } from "@/lib/authz";
import { generateSlug } from "@/modules/audit/share";
import { quoteAcceptLink } from "@/lib/public-links";
import { getMailProvider } from "@/modules/mail/provider";
import { resolveSendingIdentity } from "@/modules/mail/identity";
import { computeLineTotal, formatHuf, type QuoteItem } from "./quote-math";
import { getAcceptanceProvider } from "./acceptance-provider";

export interface PublicQuote {
  quoteNumber: string;
  workspaceLegalName: string;
  clientCompany: string;
  validUntil: string;
  items: Array<{ description: string; line: string }>;
  net: string;
  vat: string;
  gross: string;
  vatRatePct: number;
  accepted: boolean;
  acceptedByName: string | null;
}

/** Publish (or reuse) the unlisted public accept URL for a sent quote. */
export async function publishQuoteAcceptance(
  documentId: string,
): Promise<{ slug: string; url: string }> {
  await requireGrant("documents.send");
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const doc = await db.document.findUnique({
    where: { id: documentId },
    select: { id: true, type: true, acceptSlug: true },
  });
  if (!doc || doc.type !== "QUOTE") throw new Error("Quote not found");

  if (doc.acceptSlug) {
    return { slug: doc.acceptSlug, url: quoteAcceptLink(doc.acceptSlug) };
  }
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const slug = generateSlug();
    try {
      await db.document.update({ where: { id: documentId }, data: { acceptSlug: slug } });
      revalidatePath("/documents");
      return { slug, url: quoteAcceptLink(slug) };
    } catch (e) {
      if (attempt === 3) throw e;
    }
  }
  throw new Error("Could not allocate an accept slug");
}

/** Public render data for the acceptance page (cross-tenant by unlisted slug). */
export async function getPublicQuote(slug: string): Promise<PublicQuote | null> {
  const doc = await prismaUnsafe.document.findFirst({
    where: { acceptSlug: slug },
    include: { lead: { include: { company: true } } },
  });
  if (!doc || doc.type !== "QUOTE") return null;

  const ws = await prismaUnsafe.workspace.findUnique({
    where: { id: doc.workspaceId },
    select: { legalName: true },
  });
  const payload = (doc.payload ?? {}) as {
    items?: QuoteItem[];
    vatRatePct?: number;
    validUntil?: string;
    quoteNumber?: string;
  };
  const totals = (doc.totals ?? { net: 0, vat: 0, gross: 0 }) as {
    net: number;
    vat: number;
    gross: number;
  };
  const accepted = await prismaUnsafe.quoteAcceptance.findFirst({
    where: { documentId: doc.id },
    select: { acceptedByName: true },
  });

  return {
    quoteNumber: payload.quoteNumber ?? "",
    workspaceLegalName: ws?.legalName ?? "Venture CO Group",
    clientCompany: doc.lead?.company?.name ?? "",
    validUntil: payload.validUntil ?? "",
    items: (payload.items ?? []).map((i) => ({
      description: i.description,
      line: formatHuf(computeLineTotal(i.baseNet, i.preset)),
    })),
    net: formatHuf(totals.net),
    vat: formatHuf(totals.vat),
    gross: formatHuf(totals.gross),
    vatRatePct: payload.vatRatePct ?? 27,
    accepted: !!accepted,
    acceptedByName: accepted?.acceptedByName ?? null,
  };
}

const acceptSchema = z.object({
  name: z.string(),
  company: z.string(),
  agreed: z.boolean(),
});

async function notifyOwners(workspaceId: string, payload: unknown, name: string): Promise<void> {
  const ws = await prismaUnsafe.workspace.findUnique({
    where: { id: workspaceId },
    select: { mailgunConfig: true },
  });
  const identity = resolveSendingIdentity(ws?.mailgunConfig);
  const owners = await prismaUnsafe.membership.findMany({
    where: { workspaceId, role: "OWNER" },
    include: { user: { select: { email: true } } },
  });
  const number = String((payload as Record<string, unknown>)?.quoteNumber ?? "");
  for (const owner of owners) {
    await getMailProvider().send({
      domain: identity.domain,
      to: owner.user.email,
      from: identity.from,
      replyTo: identity.replyTo || undefined,
      subject: `Quote ${number} accepted`,
      html: `<p>${name} accepted quote ${number}. Contract generation is now unlocked.</p>`,
    });
  }
}

/** Public accept. Records immutable assent evidence, flips the quote to accepted,
 * notifies the Owner, and unlocks contract generation (spec §4.9). */
export async function acceptQuote(
  slug: string,
  raw: unknown,
): Promise<{ ok: true; already: boolean } | { ok: false; error: string }> {
  const input = acceptSchema.parse(raw);
  const outcome = getAcceptanceProvider().accept(input);
  if (!outcome.ok) return { ok: false, error: outcome.error ?? "Invalid acceptance." };

  const doc = await prismaUnsafe.document.findFirst({
    where: { acceptSlug: slug },
    select: { id: true, workspaceId: true, leadId: true, type: true, payload: true },
  });
  if (!doc || doc.type !== "QUOTE") return { ok: false, error: "Quote not found." };

  const existing = await prismaUnsafe.quoteAcceptance.findFirst({
    where: { documentId: doc.id },
    select: { id: true },
  });
  if (existing) return { ok: true, already: true };

  const h = await headers();
  const ip = (h.get("x-forwarded-for")?.split(",")[0] ?? h.get("x-real-ip") ?? "").trim();
  const userAgent = h.get("user-agent") ?? "";

  // Immutable acceptance record (create-only; contractual assent evidence).
  await prismaUnsafe.quoteAcceptance.create({
    data: {
      workspaceId: doc.workspaceId,
      documentId: doc.id,
      acceptedByName: input.name,
      company: input.company,
      ip: ip || null,
      userAgent: userAgent || null,
    },
  });
  await prismaUnsafe.document.update({ where: { id: doc.id }, data: { status: "ACCEPTED" } });
  if (doc.leadId) {
    await prismaUnsafe.activity.create({
      data: {
        workspaceId: doc.workspaceId,
        leadId: doc.leadId,
        type: "quote_accepted",
        payload: { name: input.name, company: input.company, method: outcome.method },
      },
    });
  }
  try {
    await notifyOwners(doc.workspaceId, doc.payload, input.name);
  } catch {
    /* notification best-effort */
  }

  revalidatePath("/documents");
  revalidatePath("/pipeline");
  return { ok: true, already: false };
}
