/**
 * The pipelines a fresh workspace starts with (playbook-v2 P4/a).
 *
 * Pipelines and stages are DATA — this file is only the seed, not the schema.
 * A workspace renames, reorders and re-weights them afterwards, and nothing in
 * the app reads a stage by its name.
 *
 * Each stage may declare which LEAD stages it absorbs (`fromLeadStages`). That
 * is what the P4 migration walks: it never guesses, and the dry-run prints the
 * table below back at you before a single row is written.
 */

import type { Stage } from "@prisma/client";

export interface StageSeed {
  key: string;
  name: string;
  /** 0-100 default probability for deals sitting here. */
  probability: number;
  /** Days in stage before the card is flagged. Null = a stage nothing rots in. */
  rottingDays: number | null;
  /** open | won | lost. */
  kind: "open" | "won" | "lost";
  /** Lead stages that map onto this stage during the P4 migration. */
  fromLeadStages?: Stage[];
}

export interface PipelineSeed {
  key: string;
  name: string;
  position: number;
  isDefault: boolean;
  stages: StageSeed[];
}

/**
 * "Web projects" — the ordinary build-a-site journey, and the default landing
 * place for a converted lead.
 */
const WEB_PROJECTS: PipelineSeed = {
  key: "web-projects",
  name: "Web projects",
  position: 0,
  isDefault: true,
  stages: [
    {
      key: "qualified",
      name: "Qualified",
      probability: 20,
      rottingDays: 14,
      kind: "open",
      fromLeadStages: ["QUALIFIED"],
    },
    {
      key: "meeting",
      name: "Meeting booked",
      probability: 40,
      rottingDays: 10,
      kind: "open",
      fromLeadStages: ["MEETING_BOOKED"],
    },
    { key: "quote_sent", name: "Quote sent", probability: 60, rottingDays: 14, kind: "open" },
    { key: "negotiation", name: "Negotiation", probability: 75, rottingDays: 10, kind: "open" },
    {
      key: "handed_off",
      name: "Handed off",
      probability: 90,
      rottingDays: 7,
      kind: "open",
      fromLeadStages: ["HANDED_OFF"],
    },
    { key: "won", name: "Won", probability: 100, rottingDays: null, kind: "won" },
    { key: "lost", name: "Lost", probability: 0, rottingDays: null, kind: "lost" },
  ],
};

/**
 * "Grants" — pályázat work. Same shape, a completely different clock: an
 * application sits with the awarding body for weeks and is not rotting while it
 * does, which is exactly why one shared set of thresholds could not serve both.
 */
const GRANTS: PipelineSeed = {
  key: "grants",
  name: "Grants",
  position: 1,
  isDefault: false,
  stages: [
    { key: "qualified", name: "Qualified", probability: 15, rottingDays: 21, kind: "open" },
    {
      key: "meeting",
      name: "Consultation booked",
      probability: 30,
      rottingDays: 14,
      kind: "open",
    },
    {
      key: "application",
      name: "Application drafted",
      probability: 50,
      rottingDays: 30,
      kind: "open",
    },
    { key: "submitted", name: "Submitted", probability: 70, rottingDays: 60, kind: "open" },
    { key: "won", name: "Won", probability: 100, rottingDays: null, kind: "won" },
    { key: "lost", name: "Lost", probability: 0, rottingDays: null, kind: "lost" },
  ],
};

export const DEFAULT_PIPELINES: PipelineSeed[] = [WEB_PROJECTS, GRANTS];

export const DEFAULT_PIPELINE_KEY = WEB_PROJECTS.key;

/** Lead stages the deals layer takes over. Everything earlier stays a lead. */
export const DEAL_OWNED_LEAD_STAGES: Stage[] = ["QUALIFIED", "MEETING_BOOKED", "HANDED_OFF"];

/** Lead stages that remain the lead board's business (P4/a — the boundary). */
export const LEAD_OWNED_STAGES: Stage[] = ["RESEARCHED", "CONTACTED", "ACCEPTED", "REPLIED"];

export function pipelineSeed(key: string): PipelineSeed | undefined {
  return DEFAULT_PIPELINES.find((p) => p.key === key);
}

/**
 * Which stage of a pipeline a lead in `stage` belongs in.
 *
 * Falls back to the pipeline's first open stage rather than refusing: a
 * pipeline that does not model "meeting booked" still has somewhere sensible to
 * put a lead who has one, and dropping the lead instead would lose it.
 */
export function stageForLeadStage(pipeline: PipelineSeed, stage: Stage): StageSeed {
  const exact = pipeline.stages.find((s) => s.fromLeadStages?.includes(stage));
  if (exact) return exact;
  const firstOpen = pipeline.stages.find((s) => s.kind === "open");
  if (!firstOpen) throw new Error(`Pipeline ${pipeline.key} has no open stage`);
  return firstOpen;
}

/**
 * Which pipeline an existing lead belongs to.
 *
 * Grant work announces itself in the words people already used — a signal tag
 * or an industry that says pályázat/grant/tender. Everything else is a web
 * project, which is what almost all of it is. Deliberately a small, printable
 * rule: the dry-run shows the chosen pipeline per lead so a wrong guess is
 * visible before anything is written, not discovered afterwards.
 */
export function pipelineKeyForLead(input: {
  signals: string[];
  industry: string | null;
  companyName: string | null;
  notes?: string | null;
}): string {
  const hay = [
    ...input.signals,
    input.industry ?? "",
    input.companyName ?? "",
  ]
    .join(" ")
    .toLowerCase();
  const grantish = ["pályázat", "palyazat", "grant", "tender", "eu-forrás", "eu forras"];
  return grantish.some((w) => hay.includes(w)) ? GRANTS.key : WEB_PROJECTS.key;
}
