import type { Metadata } from "next";
import { PublicAuditLanding } from "@/components/public-audit-landing";

/**
 * Self-serve audit landing (P12/1a), served at the root of the audit domain by
 * the middleware. Public and unauthenticated by design.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Ingyenes weboldal-átvilágítás — Venture CO Group",
  description:
    "Mennyit ér a weboldala? Gépi átvilágítás 60 másodperc alatt: sebesség, mobilnézet, megtalálhatóság, jogi megfelelés.",
};

export default function PublicAuditPage() {
  return <PublicAuditLanding />;
}
