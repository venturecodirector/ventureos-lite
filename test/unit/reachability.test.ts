import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");

/**
 * Built, and reachable.
 *
 * ── WHAT THIS FOUND ────────────────────────────────────────────────────────
 *
 * A sweep of the codebase turned up twenty-one exported server actions that
 * nothing called, an audit log written in fifty-one places and read in none, a
 * `Target` table read twice and written never, and a complete keyword-tracking
 * component mounted on no page. None of it failed anything: it type-checked,
 * it linted, and the tests were green. That is the shape of this particular
 * decay — nothing breaks, the feature simply is not there.
 */

describe('"use server" files export only functions', () => {
  /**
   * The trap, twice now. A const exported from a `"use server"` file fails the
   * PRODUCTION build with "can only export async functions, found object" —
   * and passes typecheck, lint, and a cached local build.
   */
  /**
   * Files whose FIRST line is the directive. Grepping for the string matches
   * every comment that mentions it — including the comments warning about this
   * very trap.
   */
  const serverFiles = execSync('grep -rl \'"use server"\' src --include="*.ts"', {
    cwd: ROOT,
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter(Boolean)
    .filter((rel) => readFileSync(join(ROOT, rel), "utf8").split("\n")[0]!.includes('"use server"'));

  it("finds the server files it means to check", () => {
    expect(serverFiles.length).toBeGreaterThan(20);
  });

  for (const rel of serverFiles) {
    it(`${rel} exports no value`, () => {
      const src = readFileSync(join(ROOT, rel), "utf8");
      const offenders = [
        ...src.matchAll(/^export (?!async function|type|interface)(const|let|var|class)\s+(\w+)/gm),
      ].map((m) => m[2]);
      expect(offenders, `${rel} exports ${offenders.join(", ")} — move it to a plain module`).toEqual([]);
    });
  }
});

describe("every exported server action has a caller", () => {
  /**
   * An action nothing calls is not a half-finished feature, it is maintenance
   * debt: it type-checks, no test covers it, and the next person to read it
   * assumes it works.
   */
  const actionFiles = execSync(
    'find src/modules -name "actions.ts" -o -name "*-actions.ts" | sort',
    { cwd: ROOT, encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .filter(Boolean);

  const allSource = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(entry.name)) allSource.set(rel, readFileSync(join(ROOT, rel), "utf8"));
    }
  };
  walk("src");

  it("finds the action files it means to check", () => {
    expect(actionFiles.length).toBeGreaterThan(15);
  });

  for (const rel of actionFiles) {
    const src = allSource.get(rel) ?? "";
    const exported = [...src.matchAll(/^export async function (\w+)/gm)].map((m) => m[1]!);
    for (const fn of exported) {
      it(`${rel} → ${fn} is called from somewhere`, () => {
        const callers = [...allSource.entries()].filter(
          ([path, text]) => path !== rel && new RegExp(`\\b${fn}\\b`).test(text),
        );
        expect(
          callers.length,
          `${fn} is exported and nothing references it — wire it up or delete it`,
        ).toBeGreaterThan(0);
      });
    }
  }
});

describe("what the database records, somebody can read", () => {
  const allText = execSync('find src -name "*.ts" -o -name "*.tsx"', {
    cwd: ROOT,
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .map((f) => readFileSync(join(ROOT, f), "utf8"))
    .join("\n");

  /**
   * Hard rule #8 requires the audit log. It was written faithfully in
   * fifty-one places and read nowhere, which makes it a table rather than a
   * control.
   */
  it("the audit log is read, not only written", () => {
    expect(/auditLog\.(findMany|findFirst|count)/.test(allText)).toBe(true);
  });

  /** The Friday report compared four KPIs against targets nothing could set. */
  it("weekly targets can be written, not only read", () => {
    expect(/target\.(create|update|delete)/.test(allText)).toBe(true);
  });

  /** A complete rank-tracking feature was mounted on no page. */
  it("the search-visibility panel is mounted somewhere", () => {
    expect(/<SearchVisibility\b/.test(allText)).toBe(true);
  });

  /**
   * A panel that exists but is mounted nowhere is the same non-feature as one
   * that was never written — and the component name alone proves nothing, so
   * these assert the JSX tag.
   */
  it("the reader panels are mounted on a page", () => {
    expect(/<AuditLogPanel\b/.test(allText)).toBe(true);
    expect(/<SettingsTargets\b/.test(allText)).toBe(true);
    expect(/<SettingsAuditWatches\b/.test(allText)).toBe(true);
  });

  /** Watches are created by a job; there was no list and no off switch. */
  it("audit watches can be listed and stopped from the UI", () => {
    expect(/listAuditWatches\b/.test(allText)).toBe(true);
    expect(/clearAuditWatch\b/.test(allText)).toBe(true);
  });
});
