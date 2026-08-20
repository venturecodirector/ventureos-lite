"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { getRegistryProvider, type RegistryCandidate } from "./provider";
import { findByTaxId } from "./dedupe";
import { validateTaxNumber, TAX_NUMBER_REJECTION_TEXT } from "./tax-number";
import { navQueryTaxpayer } from "./nav-taxpayer";
import { resolveNavCredentials } from "@/modules/integrations/resolve";
import { brandFrom } from "@/modules/workspaces/brand";

/** Candidate match (spec §4.19): lookup by the company's adószám, else its name. */
export async function enrichCompanyLookup(
  companyId: string,
): Promise<{ candidates: RegistryCandidate[] }> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const company = await db.company.findUnique({
    where: { id: companyId },
    select: { name: true, taxId: true },
  });
  if (!company) throw new Error("Company not found");

  const candidates = await getRegistryProvider().lookup({
    taxId: company.taxId ?? undefined,
    name: company.name,
  });
  return { candidates };
}

const candidateSchema = z.object({
  legalName: z.string(),
  taxId: z.string(),
  regNumber: z.string().nullable(),
  headcountBand: z.string().nullable(),
  revenueBand: z.string().nullable(),
  statusFlags: z.array(z.string()),
});

/** Confirm → enrich. adószám dedupe blocks if another company already holds it. */
export async function confirmEnrichment(
  companyId: string,
  rawCandidate: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const candidate = candidateSchema.parse(rawCandidate);
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  const others = await db.company.findMany({
    where: { NOT: { id: companyId } },
    select: { id: true, taxId: true },
  });
  const clash = findByTaxId(candidate.taxId, others);
  if (clash) {
    return {
      ok: false,
      error: `Another company already has adószám ${candidate.taxId}.`,
    };
  }

  await db.company.update({ where: { id: companyId }, data: { taxId: candidate.taxId } });
  await db.registryData.upsert({
    where: { companyId },
    create: {
      workspaceId,
      companyId,
      taxId: candidate.taxId,
      regNumber: candidate.regNumber,
      legalName: candidate.legalName,
      headcountBand: candidate.headcountBand,
      revenueBand: candidate.revenueBand,
      statusFlags: candidate.statusFlags,
    },
    update: {
      taxId: candidate.taxId,
      regNumber: candidate.regNumber,
      legalName: candidate.legalName,
      headcountBand: candidate.headcountBand,
      revenueBand: candidate.revenueBand,
      statusFlags: candidate.statusFlags,
      fetchedAt: new Date(),
    },
  });

  revalidatePath("/leads");
  return { ok: true };
}

// ---- Lookup by adószám (NAV queryTaxpayer) ---------------------------------

/**
 * What a tax-number lookup can tell the operator.
 *
 * Deliberately a discriminated union rather than a thrown error: this is called
 * from a client handler, and anything thrown out of a Server Action reaches the
 * browser as a message-less digest.
 */
export type TaxpayerLookup =
  | {
      ok: true;
      /** NAV's own spelling of the legal name — the one a contract must carry. */
      legalName: string;
      shortName: string | null;
      taxNumber: string;
      city: string | null;
      address: string | null;
      /** True when NAV knows the number but the taxpayer is no longer active. */
      deregistered: boolean;
      vatGroupMembership: string | null;
    }
  | { ok: false; error: string };

/**
 * Look a Hungarian adószám up at NAV and hand back what it says.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * Everything needed for it was already here — the checksum validator, the
 * signed request builder, the response parser, the credential resolver, all
 * tested — and none of it had a button. The only caller was the integration's
 * "test connection", which looks up the workspace's OWN number.
 *
 * ── THE BOUNDARY ───────────────────────────────────────────────────────────
 *
 * `queryTaxpayer` is READ-ONLY and is the only NAV operation this path may ever
 * use. It creates nothing, submits nothing, and costs nothing. Invoice
 * submission (`manageInvoice`) lives elsewhere, behind its own audited action,
 * and must never be reached from here.
 */
export async function lookupTaxpayer(rawTaxId: unknown): Promise<TaxpayerLookup> {
  const parsed = z.string().trim().min(1).max(40).safeParse(rawTaxId);
  if (!parsed.success) return { ok: false, error: "Adj meg egy adószámot." };

  // The cheap gate first: a malformed number must not cost a request. (The
  // provider checks this too — this one is here to give a SPECIFIC reason.)
  const verdict = validateTaxNumber(parsed.data);
  if (!verdict.ok) {
    return { ok: false, error: TAX_NUMBER_REJECTION_TEXT[verdict.reason] };
  }

  const { workspaceId } = await getActiveContext();
  const brand = brandFrom(
    (
      await prismaUnsafe.workspace.findUnique({
        where: { id: workspaceId },
        select: { brand: true },
      })
    )?.brand,
  );
  const creds = await resolveNavCredentials(workspaceId, brand);
  const lookup = await navQueryTaxpayer(verdict.parts.base, creds, {
    logUsage: async ({ operation, outcome }) => {
      await getWorkspaceClient(workspaceId)
        .apiUsage.create({
          data: { workspaceId, provider: "nav", operation: `${operation}:${outcome}`, cost: 0 },
        })
        .catch(() => {
          /* the lookup's answer matters more than its bookkeeping */
        });
    },
  });

  switch (lookup.status) {
    case "valid":
    case "deregistered":
      return {
        ok: true,
        legalName: lookup.taxpayer.legalName,
        shortName: lookup.taxpayer.shortName,
        taxNumber: lookup.taxpayer.taxNumber,
        city: lookup.taxpayer.seat?.city ?? null,
        address: lookup.taxpayer.seat?.oneLine ?? null,
        deregistered: lookup.status === "deregistered",
        vatGroupMembership: lookup.taxpayer.vatGroupMembership,
      };
    case "unknown":
      return { ok: false, error: "A NAV nem ismeri ezt az adószámot." };
    case "error":
      return { ok: false, error: lookup.message };
  }
}
