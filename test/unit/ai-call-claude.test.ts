import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import {
  callClaude,
  type CallClaudeDeps,
  type ClaudeResponse,
} from "../../src/lib/ai/call-claude";
import { BudgetExceededError } from "../../src/lib/ai/budget";

function res(over: Partial<ClaudeResponse> = {}): ClaudeResponse {
  return {
    content: [{ type: "text", text: '{"ok":true}' }],
    usage: { input_tokens: 100, output_tokens: 20 },
    stop_reason: "end_turn",
    model: "claude-haiku-4-5",
    ...over,
  };
}

function makeDeps(over: Partial<CallClaudeDeps> = {}): CallClaudeDeps {
  return {
    createMessage: vi.fn(async () => res()),
    spentTodayUsd: vi.fn(async () => 0),
    capUsd: vi.fn(async () => 2),
    logUsage: vi.fn(async () => {}),
    ...over,
  };
}

describe("callClaude budget enforcement", () => {
  it("rejects with BudgetExceededError at the cap, without calling the API or logging", async () => {
    const deps = makeDeps({
      spentTodayUsd: vi.fn(async () => 2),
      capUsd: vi.fn(async () => 2),
    });
    await expect(
      callClaude(
        {
          useCase: "reply_analysis",
          workspaceId: "w",
          system: "S",
          messages: [{ role: "user", content: "hi" }],
        },
        deps,
      ),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    expect(deps.createMessage).not.toHaveBeenCalled();
    expect(deps.logUsage).not.toHaveBeenCalled();
  });
});

describe("callClaude routing, JSON validation, logging", () => {
  it("routes reply_analysis to haiku, validates JSON, logs computed cost", async () => {
    const deps = makeDeps();
    const schema = z.object({ ok: z.boolean() });
    const out = await callClaude(
      {
        useCase: "reply_analysis",
        workspaceId: "w",
        system: "S",
        messages: [{ role: "user", content: "hi" }],
        schema,
      },
      deps,
    );
    expect(out.model).toBe("claude-haiku-4-5");
    expect(out.data).toEqual({ ok: true });
    expect(out.costUsd).toBeCloseTo((100 * 1 + 20 * 5) / 1e6, 12);
    expect(deps.logUsage).toHaveBeenCalledTimes(1);
    const logged = (deps.logUsage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(logged.workspaceId).toBe("w");
    expect(logged.model).toBe("claude-haiku-4-5");
    expect(logged.tokensIn).toBe(100);
  });

  it("routes lead_research to sonnet and returns raw text when no schema", async () => {
    const deps = makeDeps({
      createMessage: vi.fn(async () =>
        res({
          content: [{ type: "text", text: "hello world" }],
          usage: { input_tokens: 10, output_tokens: 5 },
          model: "claude-sonnet-4-6",
        }),
      ),
    });
    const out = await callClaude(
      {
        useCase: "lead_research",
        workspaceId: "w",
        system: "S",
        messages: [{ role: "user", content: "x" }],
      },
      deps,
    );
    expect(out.model).toBe("claude-sonnet-4-6");
    expect(out.data).toBe("hello world");
  });

  it("repairs invalid JSON once then succeeds, summing cost across both calls", async () => {
    const createMessage = vi
      .fn<CallClaudeDeps["createMessage"]>()
      .mockResolvedValueOnce(
        res({ content: [{ type: "text", text: "not json" }], usage: { input_tokens: 100, output_tokens: 10 } }),
      )
      .mockResolvedValueOnce(
        res({ content: [{ type: "text", text: '{"ok":true}' }], usage: { input_tokens: 120, output_tokens: 12 } }),
      );
    const deps = makeDeps({ createMessage });
    const schema = z.object({ ok: z.boolean() });
    const out = await callClaude(
      {
        useCase: "reply_analysis",
        workspaceId: "w",
        system: "S",
        messages: [{ role: "user", content: "hi" }],
        schema,
      },
      deps,
    );
    expect(createMessage).toHaveBeenCalledTimes(2);
    expect(out.data).toEqual({ ok: true });
    // summed: input 220, output 22 on haiku
    expect(out.costUsd).toBeCloseTo((220 * 1 + 22 * 5) / 1e6, 12);
    expect(deps.logUsage).toHaveBeenCalledTimes(1);
  });
});
