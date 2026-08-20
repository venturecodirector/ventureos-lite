import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { attempt, attemptVoid, serverActionError } from "../../src/lib/client/server-action";
import { stripComments } from "../helpers/strip-comments";

/**
 * The silence that looked like a broken button.
 *
 * ── THE REPORTED PROBLEM ────────────────────────────────────────────────────
 *
 *   "Lead szerkesztésekor a mentés nem megy"  — Save does nothing
 *   "Run research nem csinál semmit"          — Run research does nothing
 *
 * Neither was a dead button and neither was a refusal. Both were an UNEXPECTED
 * throw inside a Server Action, and Next.js redacts those in production: the
 * client receives an Error whose `message` is EMPTY and whose only content is a
 * `digest`. Two ways that reached the operator as nothing at all:
 *
 *   1. No catch — the rejection inside `startTransition` went nowhere, the
 *      button flipped back from "Saving…", and no message was ever set.
 *   2. `setError((e as Error).message)` — an empty string, and the error strip
 *      is rendered as `{error && …}`, so an empty string renders nothing.
 *
 * The first is why the save was silent; the second is why research was. They
 * are the same bug with two spellings.
 */
describe("an unexpected throw always produces something readable", () => {
  it("turns a redacted production error into a message with its digest", () => {
    const redacted = Object.assign(new Error(""), { digest: "1234567890abcdef" });
    const text = serverActionError(redacted);
    expect(text.length).toBeGreaterThan(0);
    // The digest is the only handle that ties what the operator saw to the
    // server log line. It is a hash, which is why Next.js sends it at all.
    expect(text).toContain("1234567890ab");
  });

  it("never returns an empty string, whatever it is handed", () => {
    for (const thrown of [new Error(""), new Error("boom"), null, undefined, "", 0, {}]) {
      expect(serverActionError(thrown).trim().length).toBeGreaterThan(0);
    }
  });

  it("says so plainly when the network is the problem", () => {
    expect(serverActionError(new TypeError("Failed to fetch"))).toMatch(/reach the server/i);
  });

  it("keeps the real message in development, where there is one", () => {
    expect(serverActionError(new Error("Company not found"))).toContain("Company not found");
  });
});

describe("attempt", () => {
  it("passes a successful result through untouched", async () => {
    const value = { ok: true as const, id: "x" };
    expect(await attempt(Promise.resolve(value))).toBe(value);
  });

  it("passes a REFUSAL through untouched — refusals are data, not failures", async () => {
    const refusal = { ok: false as const, error: "Check the values and try again." };
    expect(await attempt(Promise.resolve(refusal))).toBe(refusal);
  });

  it("converts a throw into the same shape every caller already handles", async () => {
    const res = await attempt(Promise.reject(Object.assign(new Error(""), { digest: "abc123" })));
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toMatch(/abc123/);
  });

  /**
   * `redirect()` signals by throwing. Swallowing it would strand the user on a
   * page they were being moved off — a revoked session would silently do
   * nothing instead of showing the login form.
   */
  it("re-throws a redirect instead of swallowing it", async () => {
    const redirect = Object.assign(new Error("NEXT_REDIRECT"), {
      digest: "NEXT_REDIRECT;replace;/login;307;",
    });
    await expect(attempt(Promise.reject(redirect))).rejects.toBe(redirect);
  });

  it("attemptVoid gives back the error text, or null on success", async () => {
    expect(await attemptVoid(Promise.resolve(1))).toBeNull();
    expect(await attemptVoid(Promise.reject(new Error("nope")))).toContain("nope");
  });
});

/**
 * Source-level, because the bug was not in a function — it was in the ABSENCE
 * of one at each call site. A test that only exercises the helper would have
 * passed on the broken code.
 */
describe("the reported call sites no longer swallow a throw", () => {
  const read = (p: string) => stripComments(readFileSync(join(process.cwd(), p), "utf8"));

  it("the lead modal wraps its save", () => {
    const src = read("src/components/lead-detail-modal.tsx");
    expect(src).toMatch(/attempt\(\s*updateLeadDetail\(/);
  });

  it("the leads table wraps its research", () => {
    const src = read("src/components/leads-table.tsx");
    expect(src).toMatch(/attempt\(runResearch\(/);
    // The old spelling, which rendered an empty string.
    expect(src).not.toMatch(/setError\(\(e as Error\)\.message\)/);
  });

  it("the audit runner reports a rejected URL instead of nothing", () => {
    const src = read("src/components/audit-runner.tsx");
    expect(src).toMatch(/serverActionError\(e\)/);
    expect(src).not.toMatch(/setError\(\(e as Error\)\.message\)/);
  });

  /**
   * A guard against the pattern coming back somewhere else. `.message` on a
   * caught Server Action error is empty in production, and `{x && …}` renders
   * nothing for an empty string — so this spelling is always a silent failure.
   */
  it("no component renders a caught action's bare .message any more", () => {
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const hits = execSync(
      "grep -rln 'set[A-Za-z]*((e as Error).message)' src/components src/app || true",
      { encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean);
    expect(hits, `still swallowing: ${hits.join(", ")}`).toEqual([]);
  });
});
