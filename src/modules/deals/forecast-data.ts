/**
 * The weighted forecast, assembled (playbook-v2 P4/c).
 *
 * The arithmetic is in `logic.ts` and touches no database; this reads the rows
 * and the workspace's commit threshold, and lines the result up against the
 * revenue targets that already exist.
 */

import { getWorkspaceClient, prismaUnsafe } from "@/lib/db";
import {
  buildForecast,
  monthKeyOf,
  monthRange,
  DEFAULT_COMMIT_THRESHOLD,
  type ForecastResult,
} from "./logic";
import { listPipelines, loadForecastDeals, type PipelineView } from "./store";

export const FORECAST_MONTHS = 6;

/** The commit/upside split point, per workspace. */
export function commitThresholdFrom(dealsConfig: unknown): number {
  if (!dealsConfig || typeof dealsConfig !== "object" || Array.isArray(dealsConfig)) {
    return DEFAULT_COMMIT_THRESHOLD;
  }
  const raw = (dealsConfig as Record<string, unknown>).commitThreshold;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_COMMIT_THRESHOLD;
  return Math.max(0, Math.min(100, Math.round(n)));
}

export interface PipelineForecast {
  pipelineId: string;
  pipelineName: string;
  forecast: ForecastResult;
}

export interface ForecastView {
  months: string[];
  commitThreshold: number;
  /** Every open deal in the workspace, one row set. */
  overall: ForecastResult;
  perPipeline: PipelineForecast[];
  /**
   * The monthly revenue target, when one is set. Compared against forecast
   * weight rather than against raw pipeline value: a target met only by
   * counting every long shot at face value has not been met.
   */
  monthlyTarget: number | null;
  pipelines: PipelineView[];
}

export async function loadForecast(
  workspaceId: string,
  opts?: { now?: Date },
): Promise<ForecastView> {
  const now = opts?.now ?? new Date();
  const db = getWorkspaceClient(workspaceId);

  const [deals, pipelines, ws, target] = await Promise.all([
    loadForecastDeals(workspaceId),
    listPipelines(db),
    prismaUnsafe.workspace.findUnique({
      where: { id: workspaceId },
      select: { dealsConfig: true },
    }),
    db.target.findFirst({ where: { metric: "revenue", period: "monthly" } }),
  ]);

  const commitThreshold = commitThresholdFrom(ws?.dealsConfig);
  // Always start at the current month, so an empty next month reads as zero
  // rather than as an absent row somebody has to notice is missing.
  const months = monthRange(new Date(now.getFullYear(), now.getMonth(), 1), FORECAST_MONTHS);

  const overall = buildForecast(deals, { commitThreshold, months });
  const perPipeline = pipelines.map((p) => ({
    pipelineId: p.id,
    pipelineName: p.name,
    forecast: buildForecast(
      deals.filter((d) => d.pipelineId === p.id),
      { commitThreshold, months },
    ),
  }));

  return {
    months,
    commitThreshold,
    overall,
    perPipeline,
    monthlyTarget: target?.value ?? null,
    pipelines,
  };
}

/** The month the forecast opens on — exported so a test can pin it. */
export function currentMonthKey(now: Date = new Date()): string {
  return monthKeyOf(now);
}
