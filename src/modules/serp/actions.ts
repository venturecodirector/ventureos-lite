"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import { getActiveContext } from "@/lib/session";
import { resolveIntegration } from "@/modules/integrations/resolve";
import {
  serpProviderFor,
  monthlyCostUsd,
  shareOfTopTen,
  DEFAULT_KEYWORD_CAP,
} from "./provider";

/**
 * Keyword tracking, from the operator's side (P2/7).
 *
 * Two rules are enforced here rather than in the UI: a workspace cannot enable
 * tracking without a configured provider, and it cannot exceed its own keyword
 * cap. Both cost real money every week, and a monthly bill is a bad place to
 * discover a mis-click.
 */
export interface KeywordRow {
  id: string;
  keyword: string;
  locale: string;
  location: string | null;
  /** Most recent measurement; null means "not in the first hundred". */
  position: number | null;
  /** The one before it, for the trend arrow. */
  previousPosition: number | null;
  checkedAt: string | null;
  /** Oldest → newest, for the sparkline. Nulls are gaps, not zeroes. */
  history: Array<{ position: number | null; checkedAt: string }>;
}

export interface VisibilityView {
  keywords: KeywordRow[];
  /** Percentage of tracked terms in the top ten. */
  shareOfTopTen: number;
  cap: number;
  /** False when no SERP provider is configured — the feature is dormant. */
  providerConfigured: boolean;
  providerId: string;
  /** What the current list will cost per month at weekly checks. */
  projectedMonthlyUsd: number;
}

const HISTORY_POINTS = 12;

async function providerFor(workspaceId: string) {
  const credential = await resolveIntegration(workspaceId, "serp.credential");
  return serpProviderFor(credential);
}

function keywordCapFrom(config: unknown): number {
  if (config && typeof config === "object" && "keywordCap" in config) {
    const v = (config as { keywordCap?: unknown }).keywordCap;
    if (typeof v === "number" && Number.isInteger(v) && v >= 0) return v;
  }
  return DEFAULT_KEYWORD_CAP;
}

export async function getVisibility(companyId: string): Promise<VisibilityView> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  const [ws, provider, rows] = await Promise.all([
    prismaUnsafe.workspace.findUnique({
      where: { id: workspaceId },
      select: { auditConfig: true },
    }),
    providerFor(workspaceId),
    db.trackedKeyword.findMany({
      where: { companyId },
      orderBy: { createdAt: "asc" },
      include: {
        positions: { orderBy: { checkedAt: "desc" }, take: HISTORY_POINTS },
      },
    }),
  ]);

  const keywords: KeywordRow[] = rows.map((k) => {
    const [latest, previous] = k.positions;
    return {
      id: k.id,
      keyword: k.keyword,
      locale: k.locale,
      location: k.location,
      position: latest?.position ?? null,
      previousPosition: previous?.position ?? null,
      checkedAt: latest?.checkedAt.toISOString() ?? null,
      history: [...k.positions]
        .reverse()
        .map((p) => ({ position: p.position, checkedAt: p.checkedAt.toISOString() })),
    };
  });

  return {
    keywords,
    shareOfTopTen: shareOfTopTen(keywords.map((k) => k.position)),
    cap: keywordCapFrom(ws?.auditConfig),
    providerConfigured: provider.configured,
    providerId: provider.id,
    projectedMonthlyUsd: monthlyCostUsd(
      rows.filter((r) => r.enabled).length,
      provider.costPerQueryUsd,
    ),
  };
}

/**
 * The bill BEFORE the decision.
 *
 * Called by the UI as the operator types, so "10 keywords" has a number
 * attached to it while there is still time to type 5.
 */
export async function previewTrackingCost(
  keywordCount: number,
): Promise<{ monthlyUsd: number; perQueryUsd: number; configured: boolean }> {
  const { workspaceId } = await getActiveContext();
  const provider = await providerFor(workspaceId);
  return {
    monthlyUsd: monthlyCostUsd(keywordCount, provider.costPerQueryUsd),
    perQueryUsd: provider.costPerQueryUsd,
    configured: provider.configured,
  };
}

const addSchema = z.object({
  companyId: z.string().min(1),
  keyword: z.string().trim().min(2).max(120),
  locale: z.string().trim().min(2).max(10).default("hu-HU"),
  location: z.string().trim().max(120).optional(),
});

export async function addKeyword(raw: unknown): Promise<{ id: string }> {
  const input = addSchema.parse(raw);
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);

  const provider = await providerFor(workspaceId);
  if (!provider.configured) {
    throw new Error(
      "No SERP provider configured — add the credential in Settings → Integrations first.",
    );
  }

  const ws = await prismaUnsafe.workspace.findUnique({
    where: { id: workspaceId },
    select: { auditConfig: true },
  });
  const cap = keywordCapFrom(ws?.auditConfig);
  const live = await db.trackedKeyword.count({ where: { companyId: input.companyId } });
  if (live >= cap) {
    throw new Error(`This company already tracks ${cap} keywords — the configured cap.`);
  }

  const row = await db.trackedKeyword.create({
    data: {
      workspaceId,
      companyId: input.companyId,
      keyword: input.keyword,
      locale: input.locale,
      location: input.location || null,
    },
  });
  revalidatePath("/leads");
  return { id: row.id };
}

export async function removeKeyword(keywordId: string): Promise<{ ok: true }> {
  const { workspaceId } = await getActiveContext();
  const db = getWorkspaceClient(workspaceId);
  await db.trackedKeyword.deleteMany({ where: { id: keywordId } });
  revalidatePath("/leads");
  return { ok: true };
}
