import type { ZodType } from "zod";
import { prismaUnsafe, getWorkspaceClient } from "../db";
import { getAnthropic } from "./client";
import type { ModelId, UseCase } from "./models";
import { modelForUseCase, DEFAULT_MAX_TOKENS } from "./models";
import { computeCostUsd, type ClaudeUsageTokens } from "./cost";
import { assertWithinBudget } from "./budget";
import { ClaudeRefusalError, ClaudeJsonError } from "./errors";

/**
 * The single Claude wrapper (CLAUDE.md hard rule #3, spec §5–6):
 *   - routes to sonnet or haiku per use case,
 *   - caches static system content (Anthropic prompt caching),
 *   - validates JSON output with zod + one repair-retry,
 *   - enforces the per-workspace daily USD cap before the call (BudgetExceeded),
 *   - logs every call (with cost) to ClaudeUsage.
 * Deterministic APIs must do everything they can before this is ever called.
 */

export interface ClaudeMessage {
  role: "user" | "assistant";
  content: string;
}

interface SystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

export interface ClaudeRequest {
  model: string;
  max_tokens: number;
  system?: SystemBlock[];
  messages: ClaudeMessage[];
}

export interface ClaudeResponse {
  content: Array<{ type: string; text?: string }>;
  usage: ClaudeUsageTokens;
  stop_reason: string | null;
  model: string;
}

export interface UsageLogEntry {
  workspaceId: string;
  useCase: UseCase;
  model: ModelId;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  usage: ClaudeUsageTokens;
}

export interface CallClaudeDeps {
  createMessage(req: ClaudeRequest): Promise<ClaudeResponse>;
  spentTodayUsd(workspaceId: string): Promise<number>;
  capUsd(workspaceId: string): Promise<number>;
  logUsage(entry: UsageLogEntry): Promise<void>;
}

export interface CallClaudeParams<T> {
  useCase: UseCase;
  workspaceId: string;
  system: string;
  messages: ClaudeMessage[];
  /** When set, output is JSON-parsed and zod-validated with one repair-retry. */
  schema?: ZodType<T>;
  maxTokens?: number;
  modelOverride?: ModelId;
  /** Mark the static system block for prompt caching (default true). */
  cacheSystem?: boolean;
}

export interface CallClaudeResult<T> {
  data: T | string;
  model: ModelId;
  usage: ClaudeUsageTokens;
  costUsd: number;
}

const ZERO_USAGE: ClaudeUsageTokens = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

function extractText(res: ClaudeResponse): string {
  return res.content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
}

function stripFences(text: string): string {
  const s = text.trim();
  const fenced = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (fenced ? fenced[1] : s).trim();
}

function addUsage(a: ClaudeUsageTokens, b: ClaudeUsageTokens): ClaudeUsageTokens {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_read_input_tokens:
      (a.cache_read_input_tokens ?? 0) + (b.cache_read_input_tokens ?? 0),
    cache_creation_input_tokens:
      (a.cache_creation_input_tokens ?? 0) +
      (b.cache_creation_input_tokens ?? 0),
  };
}

function tryParse<T>(
  schema: ZodType<T>,
  raw: string,
): { ok: true; value: T } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(stripFences(raw));
  } catch (e) {
    return { ok: false, error: `invalid JSON: ${(e as Error).message}` };
  }
  const parsed = schema.safeParse(json);
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    error: parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; "),
  };
}

export async function callClaude<T = string>(
  params: CallClaudeParams<T>,
  deps: CallClaudeDeps = defaultDeps,
): Promise<CallClaudeResult<T>> {
  const model = params.modelOverride ?? modelForUseCase(params.useCase);

  // Budget gate — fail closed BEFORE any API call.
  const [spent, cap] = await Promise.all([
    deps.spentTodayUsd(params.workspaceId),
    deps.capUsd(params.workspaceId),
  ]);
  assertWithinBudget({
    workspaceId: params.workspaceId,
    spentUsd: spent,
    capUsd: cap,
  });

  const maxTokens = params.maxTokens ?? DEFAULT_MAX_TOKENS[model];
  const cacheSystem = params.cacheSystem ?? true;
  const system: SystemBlock[] = [
    {
      type: "text",
      text: params.system,
      ...(cacheSystem ? { cache_control: { type: "ephemeral" as const } } : {}),
    },
  ];

  // Keep the cached system prefix byte-stable: the JSON directive rides in the
  // user turn, not the system prompt.
  const messages = params.messages.map((m) => ({ ...m }));
  if (params.schema && messages.length > 0) {
    const last = messages[messages.length - 1];
    last.content +=
      "\n\nRespond with ONLY a JSON value matching the required schema — no markdown, no prose.";
  }

  let usage = ZERO_USAGE;
  const finalizeAndLog = async (): Promise<number> => {
    const costUsd = computeCostUsd(model, usage);
    await deps.logUsage({
      workspaceId: params.workspaceId,
      useCase: params.useCase,
      model,
      tokensIn: usage.input_tokens,
      tokensOut: usage.output_tokens,
      costUsd,
      usage,
    });
    return costUsd;
  };

  let res = await deps.createMessage({ model, max_tokens: maxTokens, system, messages });
  usage = addUsage(usage, res.usage);

  if (res.stop_reason === "refusal") {
    await finalizeAndLog();
    throw new ClaudeRefusalError();
  }

  if (!params.schema) {
    const costUsd = await finalizeAndLog();
    return { data: extractText(res), model, usage, costUsd };
  }

  const raw1 = extractText(res);
  const first = tryParse(params.schema, raw1);
  if (first.ok) {
    const costUsd = await finalizeAndLog();
    return { data: first.value, model, usage, costUsd };
  }

  // One repair retry with the validation error fed back.
  const repairMessages: ClaudeMessage[] = [
    ...messages,
    { role: "assistant", content: raw1 },
    {
      role: "user",
      content: `Your previous response failed schema validation (${first.error}). Return ONLY the corrected JSON value — nothing else.`,
    },
  ];
  res = await deps.createMessage({
    model,
    max_tokens: maxTokens,
    system,
    messages: repairMessages,
  });
  usage = addUsage(usage, res.usage);

  if (res.stop_reason === "refusal") {
    await finalizeAndLog();
    throw new ClaudeRefusalError();
  }

  const raw2 = extractText(res);
  const second = tryParse(params.schema, raw2);
  if (second.ok) {
    const costUsd = await finalizeAndLog();
    return { data: second.value, model, usage, costUsd };
  }

  await finalizeAndLog();
  throw new ClaudeJsonError(
    `Claude output failed schema validation after one repair retry: ${second.error}`,
    raw2,
  );
}

// ---------------------------------------------------------------------------
// Default wiring: real Anthropic client + guarded Prisma (tenant-scoped usage).
// ---------------------------------------------------------------------------

function startOfUtcDay(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

export const defaultDeps: CallClaudeDeps = {
  async createMessage(req) {
    const res = await getAnthropic().messages.create({
      model: req.model,
      max_tokens: req.max_tokens,
      ...(req.system ? { system: req.system } : {}),
      messages: req.messages,
    });
    return {
      content: res.content as unknown as Array<{ type: string; text?: string }>,
      usage: {
        input_tokens: res.usage.input_tokens,
        output_tokens: res.usage.output_tokens,
        cache_read_input_tokens: res.usage.cache_read_input_tokens,
        cache_creation_input_tokens: res.usage.cache_creation_input_tokens,
      },
      stop_reason: res.stop_reason,
      model: res.model,
    };
  },

  async spentTodayUsd(workspaceId) {
    const db = getWorkspaceClient(workspaceId);
    const agg = await db.claudeUsage.aggregate({
      _sum: { cost: true },
      where: { at: { gte: startOfUtcDay() } },
    });
    return Number(agg._sum.cost ?? 0);
  },

  async capUsd(workspaceId) {
    // Fail closed: unknown workspace → $0 cap → everything is blocked.
    const ws = await prismaUnsafe.workspace.findUnique({
      where: { id: workspaceId },
      select: { claudeBudget: true },
    });
    return Number(ws?.claudeBudget ?? 0);
  },

  async logUsage(entry) {
    const db = getWorkspaceClient(entry.workspaceId);
    await db.claudeUsage.create({
      // workspaceId is also re-forced by the tenant guard to this exact value;
      // it's stated here only to satisfy Prisma's static create input type.
      data: {
        workspaceId: entry.workspaceId,
        useCase: entry.useCase,
        model: entry.model,
        tokensIn: entry.tokensIn,
        tokensOut: entry.tokensOut,
        cost: entry.costUsd,
      },
    });
  },
};
