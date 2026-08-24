import { readFileSync, writeFileSync } from "node:fs";

/**
 * Re-run the current scrubber over an already-recorded snapshot.
 *
 *   npx tsx scripts/rescrub-snapshot.ts <in.json> <out.json>
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * The scrubber has had to learn the payload's shape in stages, and each lesson
 * came from a capture that had already been made. Without this, every fix meant
 * asking for another recording — and a recording is ten minutes of somebody
 * else's time plus a browser session that cannot be automated.
 *
 * It re-walks the PARSED rows with the current rules, which catches anything a
 * newer rule would now redact. What it cannot do is bring back what an older
 * pass destroyed: a value already reduced to `<text:12>` has lost its content
 * for good. So this closes leaks; it does not restore structure.
 */
const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error("Usage: npx tsx scripts/rescrub-snapshot.ts <in.json> <out.json>");
  process.exit(1);
}

interface Scrub {
  createReplacer(): unknown;
  scrubFlightBody(body: unknown, replacer: unknown, slug: string): unknown;
}
const g: { VentureApiScrub?: Scrub } = {};
new Function("globalThis", "URL", readFileSync("extension/api-scrub.js", "utf8"))(g, URL);
const S = g.VentureApiScrub!;

const snapshot = JSON.parse(readFileSync(input, "utf8")) as {
  records: Array<{ url: string; body: { rows?: unknown[] } | null }>;
};

const replacer = S.createReplacer();
let rows = 0;
for (const record of snapshot.records) {
  if (!record.body?.rows) continue;
  record.body.rows = record.body.rows.map((row) => {
    rows += 1;
    return S.scrubFlightBody(row, replacer, record.url);
  });
}
writeFileSync(output, JSON.stringify(snapshot));
console.log(`  re-scrubbed ${rows} row(s) across ${snapshot.records.length} record(s)`);
