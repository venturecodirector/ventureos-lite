import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../helpers/strip-comments";

/**
 * Research reports its refusals as DATA, not as exceptions.
 *
 * ── THE REPORTED ERROR ──────────────────────────────────────────────────────
 *
 *     An error occurred in the Server Components render. The specific message is
 *     omitted in production builds to avoid leaking sensitive details. A digest
 *     property is included on this error instance…
 *
 * The production log behind that digest said:
 *
 *     ResearchInputError: There is no profile text to analyse yet.
 *
 * A perfectly ordinary, user-fixable condition — reaching the operator as an
 * opaque crash. Next.js redacts anything thrown out of a Server Action: the
 * client gets a bare Error with a digest and no message. The UI was already
 * catching it and rendering `e.message`; there was simply nothing left to render.
 *
 * It worked in development, which is exactly why it survived to production.
 *
 * These are source-level assertions rather than a live call, because reaching the
 * real function needs a session, a workspace and an Anthropic key. What they pin
 * is the SHAPE — that the expected outcomes leave by `return` and not by `throw`,
 * which is the whole of the bug.
 */
const ACTIONS = stripComments(
  readFileSync(join(process.cwd(), "src/modules/leads/actions.ts"), "utf8"),
);
/** Just the body of runResearch. */
const RUN_RESEARCH = (() => {
  const start = ACTIONS.indexOf("export async function runResearch");
  expect(start).toBeGreaterThan(-1);
  const rest = ACTIONS.slice(start);
  const end = rest.indexOf("\nexport ", 1);
  return end === -1 ? rest : rest.slice(0, end);
})();

describe("expected outcomes leave by return", () => {
  it("declares a result type with an ok flag", () => {
    expect(ACTIONS).toMatch(/export type ResearchResult\s*=/);
    expect(ACTIONS).toMatch(/ok:\s*true;\s*card/);
    expect(ACTIONS).toMatch(/ok:\s*false;\s*error:\s*string/);
  });

  /** THE BUG: a user-facing condition that left by `throw`. */
  it("no longer throws for a lead with nothing to analyse", () => {
    expect(RUN_RESEARCH).not.toMatch(/throw new ResearchInputError/);
    expect(RUN_RESEARCH).toMatch(/reason:\s*"no_text"/);
  });

  it("throws nothing at all out of the happy or the refusing paths", () => {
    // Anything left would be redacted to a digest in production, which is the
    // failure mode this whole change exists to remove.
    expect(RUN_RESEARCH.match(/\bthrow\b/g) ?? []).toHaveLength(0);
  });

  it("names every refusal so the UI can tell them apart", () => {
    for (const reason of ["no_text", "not_found", "ai_failed", "budget"]) {
      expect(RUN_RESEARCH, `no branch returns ${reason}`).toContain(`"${reason}"`);
    }
  });

  it("catches the AI failures rather than letting them escape", () => {
    // A refusal, unreadable JSON, or an exhausted budget are all expected.
    expect(RUN_RESEARCH).toMatch(/BudgetExceededError/);
    expect(RUN_RESEARCH).toMatch(/ClaudeRefusalError/);
    expect(RUN_RESEARCH).toMatch(/catch\s*\(/);
  });

  it("returns ok:true on the success path", () => {
    expect(RUN_RESEARCH).toMatch(/return\s*\{\s*ok:\s*true,\s*card,\s*icpScore\s*\}/);
  });
});

describe("the callers handle the refusal instead of relying on a thrown message", () => {
  const engine = stripComments(
    readFileSync(join(process.cwd(), "src/components/lead-engine.tsx"), "utf8"),
  );
  const table = stripComments(
    readFileSync(join(process.cwd(), "src/components/leads-table.tsx"), "utf8"),
  );

  it("the lead engine checks ok before reading the card", () => {
    expect(engine).toMatch(/if\s*\(!res\.ok\)/);
    expect(engine).toMatch(/setError\(res\.error\)/);
  });

  it("the table surfaces a refusal in its own error strip", () => {
    expect(table).toMatch(/if\s*\(!res\.ok\)\s*\{[\s\S]{0,120}setError\(res\.error\)/);
  });

  /**
   * A capture that succeeded followed by research that declined is TWO facts, and
   * the operator needs both — otherwise a saved lead looks like a lost one.
   */
  it("says the lead was still saved when only the analysis declined", () => {
    expect(engine).toMatch(/The lead was saved\./);
  });
});

/**
 * ── THE GOOGLE-SOURCED LEAD ─────────────────────────────────────────────────
 *
 * "If the lead comes from Google there is no phone and no email — that is
 * impossible."
 *
 * Two separate causes, and the second one was hiding behind the first:
 *
 *   1. Places gives a phone, and `addProspectAsLead` put it on the COMPANY and
 *      nowhere else, so the lead's own Phone field was empty.
 *   2. Places gives no email for any business, ever. The address is on the
 *      company's website — which we fetch, and cache, and were reading for its
 *      copy while discarding the markup the addresses live in. And research
 *      refused BEFORE that fetch, so on exactly the leads that needed the site
 *      most, it was never downloaded at all.
 */
describe("a lead from Google Places arrives with contacts", () => {
  const prospector = stripComments(
    readFileSync(join(process.cwd(), "src/modules/prospector/actions.ts"), "utf8"),
  );

  it("puts the Places phone on the lead, not only on the company", () => {
    expect(prospector).toMatch(/lead\.create\(\{[\s\S]{0,400}phone:/);
  });

  it("normalises it, so one business cannot become two leads", () => {
    expect(prospector).toMatch(/normalizePhone\(input\.phone\)/);
  });

  /** THE ORDERING BUG: the gate ran before the fetch that would have passed it. */
  it("fetches the company's site BEFORE deciding there is nothing to analyse", () => {
    const fetchAt = RUN_RESEARCH.indexOf("enrichCompanySite");
    const gateAt = RUN_RESEARCH.indexOf('reason: "no_text"');
    expect(fetchAt).toBeGreaterThan(-1);
    expect(gateAt).toBeGreaterThan(-1);
    expect(fetchAt, "the gate still runs before the site fetch").toBeLessThan(gateAt);
  });

  it("counts the website's copy as analysable text", () => {
    expect(RUN_RESEARCH).toMatch(/!hasAnalyzableText\([^)]*\)\s*&&\s*!site\?\.text/);
  });

  it("applies the site's contacts to the lead, filling blanks only", () => {
    expect(RUN_RESEARCH).toMatch(/siteContacts/);
    // `current?.email ?? …` — a value a human typed is never overwritten.
    expect(RUN_RESEARCH).toMatch(/email:\s*current\?\.email\s*\?\?/);
    expect(RUN_RESEARCH).toMatch(/phone:\s*current\?\.phone\s*\?\?/);
  });

  it("explains WHY when the site could not be read", () => {
    expect(RUN_RESEARCH).toMatch(/site\?\.skipped/);
  });
});
