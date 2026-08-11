"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getWorkspaceClient } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { getRegistryProvider, type RegistryCandidate } from "./provider";
import { findByTaxId } from "./dedupe";

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
