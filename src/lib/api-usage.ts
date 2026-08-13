/**
 * External API usage and cost, beside the Claude budget.
 *
 * Claude has its own table and its own ENFORCED daily cap (CLAUDE.md hard rule
 * #3). This is the rest of what a workspace spends on other people's APIs, in
 * one place, so "what did this month cost" has a single answer instead of three
 * provider dashboards.
 *
 * Two of the three are FREE. Recording a dollar figure for PageSpeed and CrUX
 * would show $0.00 for ever and tell the owner nothing, so what is tracked for
 * those is CALLS against Google's per-project quota — which is the number that
 * can actually run out and break an audit.
 */
import { prismaUnsafe } from "./db";

export const API_PROVIDERS = ["dataforseo", "pagespeed", "crux", "places"] as const;
export type ApiProvider = (typeof API_PROVIDERS)[number];

export interface ProviderMeta {
  label: string;
  /** False for the free Google APIs. */
  billed: boolean;
  /**
   * Google's documented free quota per project per day, at the time of
   * writing. Shown as headroom, not enforced by us — Google enforces it, and
   * hardcoding a number we cannot verify at runtime would be worse than
   * showing the count alone. Null when the provider has no daily figure.
   */
  dailyQuota: number | null;
  note: string;
}

export const PROVIDER_META: Record<ApiProvider, ProviderMeta> = {
  dataforseo: {
    label: "DataForSEO",
    billed: true,
    dailyQuota: null,
    note: "Rank tracking. Billed per query; runs weekly.",
  },
  pagespeed: {
    label: "PageSpeed Insights",
    billed: false,
    dailyQuota: 25_000,
    note: "Free. Lab performance scores on every audit.",
  },
  crux: {
    label: "Chrome UX Report",
    billed: false,
    dailyQuota: null,
    note: "Free, rate-limited per minute. Field data on every audit.",
  },
  places: {
    label: "Google Places",
    billed: true,
    dailyQuota: null,
    note: "Prospector search and competitor suggestions.",
  },
};

export interface RecordUsageInput {
  workspaceId: string;
  provider: ApiProvider;
  operation: string;
  /** HTTP requests this represents. CrUX may try up to four. */
  calls?: number;
  costUsd?: number;
}

/**
 * Record a call. NEVER throws.
 *
 * Bookkeeping must not be able to fail the work it is measuring: an audit that
 * died because the usage insert timed out would be a strictly worse product
 * than one whose cost panel is missing a row.
 */
export async function recordApiUsage(input: RecordUsageInput): Promise<void> {
  try {
    await prismaUnsafe.apiUsage.create({
      data: {
        workspaceId: input.workspaceId,
        provider: input.provider,
        operation: input.operation,
        calls: Math.max(1, Math.round(input.calls ?? 1)),
        cost: input.costUsd ?? 0,
      },
    });
  } catch {
    /* see above */
  }
}

/** A recorder bound to one workspace, for passing into a fetcher. */
export function usageRecorderFor(
  workspaceId: string,
  provider: ApiProvider,
  operation: string,
): (calls: number, costUsd?: number) => void {
  return (calls, costUsd) => {
    void recordApiUsage({ workspaceId, provider, operation, calls, costUsd });
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export interface ProviderUsage {
  provider: ApiProvider | string;
  label: string;
  billed: boolean;
  note: string;
  dailyQuota: number | null;
  callsToday: number;
  callsMonth: number;
  costTodayUsd: number;
  costMonthUsd: number;
  /** Percent of the documented daily quota used, when there is one. */
  quotaPct: number | null;
}

export interface ApiCostReport {
  providers: ProviderUsage[];
  /** Every billed provider, this calendar month so far. */
  billedMonthUsd: number;
  /** Claude, today and this month, from its own table. */
  claude: { todayUsd: number; monthUsd: number; capUsd: number };
  totalMonthUsd: number;
}

export function startOfUtcDay(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function startOfUtcMonth(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Pure shaping, so the arithmetic is testable without a database. */
export function buildProviderUsage(
  provider: string,
  today: { calls: number; cost: number },
  month: { calls: number; cost: number },
): ProviderUsage {
  const meta = PROVIDER_META[provider as ApiProvider] ?? {
    label: provider,
    billed: true,
    dailyQuota: null,
    note: "",
  };
  return {
    provider,
    label: meta.label,
    billed: meta.billed,
    note: meta.note,
    dailyQuota: meta.dailyQuota,
    callsToday: today.calls,
    callsMonth: month.calls,
    costTodayUsd: today.cost,
    costMonthUsd: month.cost,
    quotaPct:
      meta.dailyQuota && meta.dailyQuota > 0
        ? Math.min(100, Math.round((today.calls / meta.dailyQuota) * 100))
        : null,
  };
}

export async function getApiCostReport(
  workspaceId: string,
  now: Date = new Date(),
): Promise<ApiCostReport> {
  const dayStart = startOfUtcDay(now);
  const monthStart = startOfUtcMonth(now);

  const [todayRows, monthRows, claudeToday, claudeMonth, ws] = await Promise.all([
    prismaUnsafe.apiUsage.groupBy({
      by: ["provider"],
      where: { workspaceId, at: { gte: dayStart } },
      _sum: { calls: true, cost: true },
    }),
    prismaUnsafe.apiUsage.groupBy({
      by: ["provider"],
      where: { workspaceId, at: { gte: monthStart } },
      _sum: { calls: true, cost: true },
    }),
    prismaUnsafe.claudeUsage.aggregate({
      _sum: { cost: true },
      where: { workspaceId, at: { gte: dayStart } },
    }),
    prismaUnsafe.claudeUsage.aggregate({
      _sum: { cost: true },
      where: { workspaceId, at: { gte: monthStart } },
    }),
    prismaUnsafe.workspace.findUnique({
      where: { id: workspaceId },
      select: { claudeBudget: true },
    }),
  ]);

  const todayBy = new Map(
    todayRows.map((r) => [
      r.provider,
      { calls: r._sum.calls ?? 0, cost: Number(r._sum.cost ?? 0) },
    ]),
  );
  const monthBy = new Map(
    monthRows.map((r) => [
      r.provider,
      { calls: r._sum.calls ?? 0, cost: Number(r._sum.cost ?? 0) },
    ]),
  );

  // Every known provider is listed even at zero: "we have not called this yet"
  // and "this is not wired up" look identical otherwise, and the first is
  // information while the second is a bug.
  const names = [...new Set([...API_PROVIDERS, ...todayBy.keys(), ...monthBy.keys()])];
  const providers = names.map((name) =>
    buildProviderUsage(
      name,
      todayBy.get(name) ?? { calls: 0, cost: 0 },
      monthBy.get(name) ?? { calls: 0, cost: 0 },
    ),
  );

  const billedMonthUsd = providers.reduce((sum, p) => sum + p.costMonthUsd, 0);
  const claudeMonthUsd = Number(claudeMonth._sum.cost ?? 0);

  return {
    providers,
    billedMonthUsd,
    claude: {
      todayUsd: Number(claudeToday._sum.cost ?? 0),
      monthUsd: claudeMonthUsd,
      capUsd: Number(ws?.claudeBudget ?? 0),
    },
    totalMonthUsd: billedMonthUsd + claudeMonthUsd,
  };
}
