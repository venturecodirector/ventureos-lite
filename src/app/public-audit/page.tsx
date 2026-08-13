import type { Metadata } from "next";
import { prismaUnsafe } from "@/lib/db";
import { PublicAuditLanding } from "@/components/public-audit-landing";
import { getPublicIntakeWorkspaceId } from "@/modules/public-audit/intake";
import { brandFrom, VENTURE_BRAND } from "@/modules/workspaces/brand";

/**
 * Self-serve audit landing (P12/1a), served at the root of the audit domain by
 * the middleware. Public and unauthenticated by design.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Ingyenes weboldal-átvilágítás",
  description:
    "Mennyit ér a weboldala? Gépi átvilágítás 60 másodperc alatt: sebesség, mobilnézet, megtalálhatóság, jogi megfelelés.",
};

export default async function PublicAuditPage() {
  // The landing has no slug to resolve a tenant from, so its branding follows
  // the configured intake workspace — the same one that will receive the lead
  // (P2/6). A misconfigured intake must not break the page, only its brand.
  let brand = VENTURE_BRAND;
  try {
    const workspaceId = await getPublicIntakeWorkspaceId();
    const ws = await prismaUnsafe.workspace.findUnique({
      where: { id: workspaceId },
      select: { brand: true },
    });
    brand = brandFrom(ws?.brand);
  } catch {
    /* intake unavailable — the form itself reports that, in its own words */
  }

  return <PublicAuditLanding brand={brand} />;
}
