import { prismaUnsafe } from "@/lib/db";
import { PAGE_TYPES, type PageType, type PageTarget } from "./types";

/**
 * Which workspace — and whose page — a public slug belongs to.
 *
 * Deliberately a cross-tenant read by unlisted slug, exactly like the pages
 * themselves do: the visitor has no session, so there is no workspace to scope
 * to until the slug names one. Everything written afterwards goes through the
 * guarded client for that workspace.
 */
export function isPageType(value: string): value is PageType {
  return (PAGE_TYPES as readonly string[]).includes(value);
}

export async function resolvePageTarget(
  pageType: PageType,
  slug: string,
): Promise<PageTarget | null> {
  switch (pageType) {
    case "audit_share": {
      const share = await prismaUnsafe.auditShare.findUnique({
        where: { slug },
        select: { workspaceId: true, leadId: true, auditId: true },
      });
      if (!share) return null;
      // The company the audit is about is the one worth knowing viewed it.
      const lead = share.leadId
        ? await prismaUnsafe.lead.findUnique({
            where: { id: share.leadId },
            select: { companyId: true },
          })
        : null;
      return {
        workspaceId: share.workspaceId,
        leadId: share.leadId,
        companyId: lead?.companyId ?? null,
        documentId: null,
        auditId: share.auditId,
      };
    }
    case "quote": {
      const doc = await prismaUnsafe.document.findUnique({
        where: { acceptSlug: slug },
        select: { id: true, workspaceId: true, leadId: true },
      });
      if (!doc) return null;
      const lead = doc.leadId
        ? await prismaUnsafe.lead.findUnique({
            where: { id: doc.leadId },
            select: { companyId: true },
          })
        : null;
      return {
        workspaceId: doc.workspaceId,
        leadId: doc.leadId,
        companyId: lead?.companyId ?? null,
        documentId: doc.id,
        auditId: null,
      };
    }
    case "booking": {
      const page = await prismaUnsafe.bookingPage.findUnique({
        where: { slug },
        select: { workspaceId: true },
      });
      if (!page) return null;
      // A booking page is not addressed to anyone in particular.
      return {
        workspaceId: page.workspaceId,
        leadId: null,
        companyId: null,
        documentId: null,
        auditId: null,
      };
    }
    case "audit_landing": {
      // No slug to look anything up by: the landing belongs to the workspace
      // configured to receive the intake, which is the one the lead will land
      // in if the visitor goes on to submit.
      const { getPublicIntakeWorkspaceId } = await import("@/modules/public-audit/intake");
      try {
        const workspaceId = await getPublicIntakeWorkspaceId();
        return {
          workspaceId,
          leadId: null,
          companyId: null,
          documentId: null,
          auditId: null,
        };
      } catch {
        // Intake misconfigured — measuring is not worth an error on a public
        // page, and the form reports the problem in its own words.
        return null;
      }
    }
    case "public_audit": {
      const pa = await prismaUnsafe.publicAudit.findUnique({
        where: { id: slug },
        select: { workspaceId: true, auditId: true },
      });
      if (!pa) return null;
      // The lead is created later, at unlock — the visit itself is anonymous.
      return {
        workspaceId: pa.workspaceId,
        leadId: null,
        companyId: null,
        documentId: null,
        auditId: pa.auditId,
      };
    }
  }
}
