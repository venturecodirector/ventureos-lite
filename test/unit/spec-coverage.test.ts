import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The spec is named as the source of truth, so it has to be true.
 *
 * CLAUDE.md opens with "Read docs/spec.md (source of truth for features)".
 * It had drifted a whole release behind: nothing in it about notifications,
 * tasks, search, the revenue layer, the signal layer, verification, projects or
 * the self-serve funnel — all of them shipped and live. Every future piece of
 * work, including one done by somebody reading it for the first time, starts
 * from that file.
 *
 * The map is EXPLICIT rather than derived. A module appearing here should be a
 * decision — which is the point of a list you have to edit.
 */
const SPEC = readFileSync(join(__dirname, "..", "..", "docs", "spec.md"), "utf8").toLowerCase();

/** module directory → a phrase the spec must contain if that module exists. */
const MUST_DESCRIBE: Record<string, string> = {
  notifications: "notification centre",
  tasks: "a first-class task",
  search: "trigram search",
  email: "two-way per-user mailbox sync",
  verification: "role-address detection",
  tracking: "first-party measurement script",
  revenue: "client health",
  projects: "a milestone is a task",
  "quote-rules": "quote follow-up rules",
  "public-audit": "self-serve",
  prospector: "prospector",
  deals: "deals & pipelines",
  merge: "duplicate merge",
  fields: "custom fields",
  workflow: "workflow-lite",
  undo: "undo",
};

const MODULES = readdirSync(join(__dirname, "..", "..", "src", "modules"), {
  withFileTypes: true,
})
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

describe("docs/spec.md describes what has actually been built", () => {
  it("finds the modules it means to check", () => {
    expect(MODULES.length).toBeGreaterThan(20);
  });

  for (const [module, phrase] of Object.entries(MUST_DESCRIBE)) {
    it(`covers the ${module} module`, () => {
      expect(MODULES, `${module} is in the map but not in src/modules`).toContain(module);
      expect(
        SPEC.includes(phrase.toLowerCase()),
        `docs/spec.md never mentions "${phrase}" — the ${module} module is undocumented`,
      ).toBe(true);
    });
  }

  /**
   * The one promise in CLAUDE.md that was written down and not kept. Worth its
   * own line so the spec cannot go back to describing an inert layer as if it
   * were protecting anything.
   */
  it("says how tenancy is actually enforced, both belts", () => {
    expect(SPEC).toContain("prisma tenant guard");
    expect(SPEC).toContain("row-level security");
    expect(SPEC).toContain("nobypassrls");
  });
});
