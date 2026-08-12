import { describe, it, expect } from "vitest";
import {
  CONTENT_STATUSES,
  allowedTransitions,
  canTransition,
  isChannel,
  maxCharsFor,
  isOverLimit,
  validateForStatus,
} from "../../src/modules/content/board";
import { USE_CASE_MODEL } from "../../src/lib/ai/models";

describe("board shape", () => {
  it("is Draft → In review → Approved → Published", () => {
    expect([...CONTENT_STATUSES]).toEqual(["DRAFT", "IN_REVIEW", "APPROVED", "PUBLISHED"]);
  });
});

describe("transitions", () => {
  it("walks the happy path forward", () => {
    expect(canTransition("DRAFT", "IN_REVIEW", false)).toEqual({ allowed: true });
    expect(canTransition("IN_REVIEW", "APPROVED", true)).toEqual({ allowed: true });
    expect(canTransition("APPROVED", "PUBLISHED", false)).toEqual({ allowed: true });
  });

  it("refuses to skip a step", () => {
    const jump = canTransition("DRAFT", "APPROVED", true);
    expect(jump.allowed).toBe(false);
    if (!jump.allowed) expect(jump.reason).toBe("illegal");
    expect(canTransition("DRAFT", "PUBLISHED", true).allowed).toBe(false);
    expect(canTransition("IN_REVIEW", "PUBLISHED", true).allowed).toBe(false);
  });

  it("lets only an approver approve", () => {
    const denied = canTransition("IN_REVIEW", "APPROVED", false);
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) {
      expect(denied.reason).toBe("forbidden");
      expect(denied.message).toMatch(/Owner or Admin/);
    }
  });

  it("lets anyone send a post back to draft, but only an approver reopen a signed-off one", () => {
    // Rejecting during review is ordinary editing.
    expect(canTransition("IN_REVIEW", "DRAFT", false).allowed).toBe(true);
    // Undoing an approval or a publish is not.
    expect(canTransition("APPROVED", "DRAFT", false).allowed).toBe(false);
    expect(canTransition("APPROVED", "DRAFT", true).allowed).toBe(true);
    expect(canTransition("PUBLISHED", "DRAFT", false).allowed).toBe(false);
    expect(canTransition("PUBLISHED", "DRAFT", true).allowed).toBe(true);
  });

  it("offers a BDR fewer moves than an approver", () => {
    expect(allowedTransitions("IN_REVIEW", false).map((t) => t.to)).toEqual(["DRAFT"]);
    expect(allowedTransitions("IN_REVIEW", true).map((t) => t.to)).toEqual(["APPROVED", "DRAFT"]);
    expect(allowedTransitions("PUBLISHED", false)).toEqual([]);
  });
});

describe("channels", () => {
  it("knows its channels and their limits", () => {
    expect(isChannel("linkedin")).toBe(true);
    expect(isChannel("tiktok")).toBe(false);
    expect(maxCharsFor("linkedin")).toBe(3000);
    expect(maxCharsFor("blog")).toBeNull();
  });

  it("only enforces a limit where one exists", () => {
    expect(isOverLimit("linkedin", "x".repeat(3001))).toBe(true);
    expect(isOverLimit("linkedin", "x".repeat(3000))).toBe(false);
    expect(isOverLimit("blog", "x".repeat(50_000))).toBe(false);
  });
});

describe("validation on the way out of Draft", () => {
  const base = { title: "T", body: "Some words.", channel: "linkedin" as const };

  it("lets a draft be anything, including empty", () => {
    expect(validateForStatus({ ...base, title: "", body: "", status: "DRAFT" })).toEqual({ ok: true });
  });

  it("requires a title and body to leave Draft", () => {
    expect(validateForStatus({ ...base, title: "", status: "IN_REVIEW" }).ok).toBe(false);
    expect(validateForStatus({ ...base, body: "   ", status: "IN_REVIEW" }).ok).toBe(false);
    expect(validateForStatus({ ...base, status: "IN_REVIEW" })).toEqual({ ok: true });
  });

  it("blocks an over-length LinkedIn post and says how much to cut", () => {
    const res = validateForStatus({ ...base, body: "x".repeat(3120), status: "IN_REVIEW" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toContain("120");
  });
});

describe("model routing (CLAUDE.md hard rule #3)", () => {
  it("drafts content on Haiku — Sonnet is reserved for four other use cases", () => {
    expect(USE_CASE_MODEL.content_draft).toBe("claude-haiku-4-5");
    const sonnet = Object.entries(USE_CASE_MODEL)
      .filter(([, m]) => m === "claude-sonnet-4-6")
      .map(([k]) => k)
      .sort();
    expect(sonnet).toEqual([
      "campaign_frame",
      "lead_research",
      "meeting_brief",
      "outreach_draft",
      "signal_engine",
    ]);
  });
});
