import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "../helpers/strip-comments";

/**
 * EVERY email this system sends goes through the brand layout.
 *
 * ── HOW THE FOUR REPORTS ESCAPED ────────────────────────────────────────────
 *
 * The layout, the palette derivation, the plain-text alternative and the
 * white-label brand plumbing were all built and tested — and the six
 * transactional senders used them. The four report senders never did: each
 * concatenated `<h2>`, `<p>` and `<ul>` inline, which no test noticed because
 * every test was about the layout rather than about who calls it.
 *
 * So this test is about the CALLERS. It walks the source, finds every send site,
 * and holds each to the two rules that were being broken.
 */
const ROOT = process.cwd();

/** Every module file that calls the mail provider. */
function senderFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) {
        const src = readFileSync(full, "utf8");
        if (/getMailProvider\(\)\s*\.send\(/.test(src)) out.push(full);
      }
    }
  };
  walk(join(ROOT, "src/modules"));
  return out;
}

const SENDERS = senderFiles();

/**
 * The cold-email sender is deliberately excluded, and this is the one place it
 * is worth stating why: cold mail is PLAIN-TEXT-FIRST by policy (CLAUDE.md —
 * the cold guardrails). A styled HTML shell with a wordmark and a gradient
 * button is exactly what makes a first-contact email look like bulk mail, so it
 * sends the operator's own words with line breaks and nothing else. Adding the
 * brand layout there would be a regression, not an improvement.
 */
const COLD = "campaigns/send.ts";

describe("every sender uses the brand layout", () => {
  it("finds the send sites", () => {
    expect(SENDERS.length).toBeGreaterThanOrEqual(8);
  });

  for (const file of SENDERS) {
    const rel = file.slice(file.indexOf("src/modules/") + "src/modules/".length);
    if (rel.endsWith(COLD)) continue;

    describe(rel, () => {
      const src = stripComments(readFileSync(file, "utf8"));

      it("renders its HTML through brandEmail", () => {
        expect(src).toMatch(/brandEmail\(/);
      });

      /** Some clients prefer it, and a text part measurably helps delivery. */
      /**
       * Some clients prefer it, and a text part measurably helps delivery. It
       * has to come from the SAME options object as the HTML — three senders
       * had a hand-written one-liner alongside a full HTML body, which is how a
       * text part quietly stops saying what the email says.
       */
      it("sends a plain-text alternative rendered from the same object", () => {
        expect(src).toMatch(/brandEmailText\(/);
        const texts = [...src.matchAll(/text:\s*([^,\n]+)/g)].map((m) => m[1].trim());
        for (const t of texts) {
          expect(t, `hand-written text part: ${t}`).toMatch(/^brandEmailText\(/);
        }
      });

      /** THE BUG: tags concatenated inline instead of going through the layout. */
      it("builds no HTML of its own", () => {
        for (const tag of ["<h2>", "<h3>", "<ul>", "<li>", "<p>"]) {
          expect(src, `still assembling ${tag} by hand`).not.toContain(tag);
        }
      });
    });
  }
});

/**
 * ── THE WHITE-LABEL LEAK IN THE SUBJECT LINE ────────────────────────────────
 *
 * Three of the four reports put the literal "Venture OS" in the subject and the
 * heading of every workspace's mail. On a white-labelled deployment that means
 * the operator's client receives a quarterly report from a company they have
 * never heard of — the exact failure the brand work existed to prevent, in the
 * one place nobody checked because the product name is a legitimate string
 * elsewhere (the PWA manifest, the page title).
 *
 * The rule is not "never write the product name". It is that a subject line
 * names the SENDING WORKSPACE, which it can only do by reading the brand.
 */
describe("no sender hardcodes a brand name in what the recipient sees", () => {
  for (const file of SENDERS) {
    const rel = file.slice(file.indexOf("src/modules/") + "src/modules/".length);
    const src = stripComments(readFileSync(file, "utf8"));

    it(`${rel} keeps the product name out of its subject`, () => {
      const subjects = [...src.matchAll(/subject\s*[:=]\s*([^,\n]+)/g)].map((m) => m[1]);
      for (const s of subjects) {
        expect(s, `hardcoded product name in a subject: ${s}`).not.toMatch(/Venture\s*OS/i);
      }
      expect(src).not.toMatch(/`Venture OS/);
    });
  }

  it("the report senders derive the subject from the workspace brand", () => {
    for (const rel of [
      "src/modules/mail/report.ts",
      "src/modules/analytics/digest.ts",
      "src/modules/analytics/monday-digest.ts",
      "src/modules/analytics/report-job.ts",
    ]) {
      const src = stripComments(readFileSync(join(ROOT, rel), "utf8"));
      expect(src, `${rel} does not read the brand`).toMatch(/brandFrom\(/);
      // Either directly in the subject, or via a title built from the brand a
      // few lines above it. What matters is that no literal name is in there.
      expect(src, `${rel} builds a subject without the brand`).toMatch(
        /(subject|Title)[^\n]{0,40}=?[^\n]{0,40}\$\{brand\.name\}/,
      );
    }
  });
});
