import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * No output surface may name a brand (audit-v2 item 6).
 *
 * This is the test that keeps the white-label honest. Every template, page and
 * mailer that a client can see is scanned for the seed's identity — the
 * wordmark, the company name, and the design tokens the templates used to
 * hardcode. All of it must come from the workspace's configuration, which means
 * the only file allowed to contain those literals is the one that defines the
 * seed.
 *
 * A new template that pastes in "venture co.group" fails here rather than in a
 * client's inbox.
 */

const ROOT = join(__dirname, "..", "..");

/**
 * The one file allowed to name the seed, plus the places that legitimately name
 * the PRODUCT rather than a workspace's client-facing identity.
 */
const ALLOWED = new Set([
  // The seed itself.
  "src/modules/workspaces/brand.ts",
  // Product chrome and installability: the app is called Venture OS whoever is
  // logged into it, exactly as Slack is called Slack in every workspace.
  "src/app/layout.tsx",
  "src/app/manifest.ts",
  "src/lib/auth/totp.ts",
  // The crawler's user agent, which identifies the software to the sites it
  // audits and must stay stable and attributable.
  "src/lib/robots.ts",
  // A password blocklist, which is the opposite of branding.
  "src/lib/auth/password.ts",
  // Internal postMessage channel names for the browser extension.
  "src/lib/extension-bridge.ts",
  "src/lib/locale.ts",
  // PRE-AUTHENTICATION screens. There is no workspace yet — nobody has signed
  // in — so there is nothing to brand with, and the product's own name is the
  // only honest thing to show. The line is: pre-auth is the product, post-auth
  // is the workspace (which is why app-shell IS brand-driven).
  "src/app/login/page.tsx",
  "src/app/reset/[token]/page.tsx",
  "src/app/enroll-2fa/page.tsx",
  // Deployment configuration: real domains named in env validation messages,
  // the integrations registry and the mail-domain error. These describe how to
  // configure THIS installation, and are never rendered to a client.
  "src/lib/env.ts",
  "src/modules/integrations/registry.ts",
  "src/modules/mail/identity.ts",
]);

/**
 * AI prompt constants name the agency inside the instructions they send to
 * Claude. That is a REAL white-label leak — a second workspace's drafted
 * outreach would introduce itself as this agency — but the prompts are
 * versioned artefacts whose wording changes model behaviour and cache keys, so
 * rewriting them belongs in its own change with its own evaluation. They are
 * excluded here deliberately and NOT silently: see the note in the item-6
 * summary.
 */
const PROMPTS = "src/lib/ai/prompts/";

/** Env examples and integration registries reference real domains by design. */
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "data"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(abs);
  }
  return out;
}

/** Strip comments — a note ABOUT the seed is not a brand string in output. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const FILES = walk(join(ROOT, "src")).map((abs) => ({
  rel: relative(ROOT, abs).replace(/\\/g, "/"),
  code: stripComments(readFileSync(abs, "utf8")),
}));

const scanned = FILES.filter(
  (f) => !ALLOWED.has(f.rel) && !f.rel.startsWith(PROMPTS),
);

describe("no source file outside the brand module names the seed", () => {
  it("scans a meaningful number of files", () => {
    // Guards the guard: a broken walk would make every assertion below vacuous.
    expect(scanned.length).toBeGreaterThan(200);
  });

  it("contains no 'co.group' wordmark half", () => {
    const offenders = scanned.filter((f) => /co\.group/i.test(f.code)).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it("contains no 'Venture CO Group' company name", () => {
    const offenders = scanned
      .filter((f) => /venture\s+co\s+group/i.test(f.code.replace(/[^\w\s]/g, " ")))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it("contains no bare 'venture' wordmark in rendered markup", () => {
    // Looks for the wordmark as it appeared in templates: inside a tag, a JSX
    // text node, or a quoted string — not for the word in an import path.
    const offenders = scanned
      .filter((f) => /(>|["'`])\s*venture\s*(<|["'`])/i.test(f.code))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });
});

describe("no template hardcodes a design token", () => {
  /** The surfaces a client can see. These must be brand-driven, not token-driven. */
  const OUTPUT_SURFACES = scanned.filter((f) =>
    /(pdf-template|-pdf|mail\/layout|mail\/report|letterhead|brand-mark)\.tsx?$/.test(f.rel) ||
    /^src\/app\/(accept|book|share|public-audit)\//.test(f.rel),
  );

  it("finds the surfaces it means to check", () => {
    expect(OUTPUT_SURFACES.length).toBeGreaterThanOrEqual(6);
  });

  for (const token of ["#00051D", "#EFF1F8", "#7427C6", "#310B59", "#858CAE"]) {
    it(`has no ${token} in a client-facing template`, () => {
      const offenders = OUTPUT_SURFACES.filter((f) => f.code.includes(token)).map((f) => f.rel);
      expect(offenders).toEqual([]);
    });
  }

  /**
   * Semantic status colours, which are NOT brand identity: green means "passed"
   * in anybody's palette, and re-tinting a pass/warn/fail chip per workspace
   * would make the audit report harder to read rather than more theirs.
   */
  const SEMANTIC = new Set(["#3DDC97", "#F5B841", "#FF5C7A", "#8FE9C3"]);

  /**
   * The payroll PDF is deliberately a LIGHT document — dark ink on paper,
   * unlike every prospect-facing artefact, because it is printed and filed
   * rather than sent to a client. Its greys are paper and rule colours, not
   * brand identity; the wordmark, accent rule, footer and fonts all come from
   * the brand. Mapping its text to --brand-ink would have made it near-white on
   * white for the seed workspace.
   */
  const PAPER = new Set(["#12162B", "#6B7290", "#D7DAE6", "#EEF0F6", "#F4F5FA", "#444B66"]);

  it("has no OTHER hardcoded colour either", () => {
    // The narrow five-token list is what let #C9CEE3 through — a fixed light
    // grey that is invisible on a light canvas, so a second workspace's quote
    // body text came out unreadable. Any hex that is not a semantic status
    // colour has to be a brand variable.
    const offenders: string[] = [];
    for (const f of OUTPUT_SURFACES) {
      for (const hex of f.code.match(/#[0-9A-Fa-f]{6}\b/g) ?? []) {
        const h = hex.toUpperCase();
        if (SEMANTIC.has(h) || PAPER.has(h)) continue;
        // Pure white on a coloured button is contrast, not identity.
        if (h === "#FFFFFF") continue;
        offenders.push(`${f.rel}: ${hex}`);
      }
    }
    expect([...new Set(offenders)]).toEqual([]);
  });
});
