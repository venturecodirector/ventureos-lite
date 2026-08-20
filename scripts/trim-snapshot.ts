import { readFileSync, writeFileSync } from "node:fs";

/**
 * Trim a recorded LinkedIn snapshot down to the records that teach something.
 *
 *   npx tsx scripts/trim-snapshot.ts <in.json> <out.json> [--keep-json]
 *
 * ── WHY A SCRIPT AND NOT A MANUAL EDIT ─────────────────────────────────────
 *
 * A raw capture is around 11 MB: twenty records, of which four carry the
 * discriminators a field mapping keys off and the rest are app config, feed
 * payload and telemetry. Committing 11 MB of that to teach 500 KB of structure
 * is a poor trade, and hand-deleting entries from a JSON file is not a thing
 * anyone can check or repeat.
 *
 * The rule is stated rather than eyeballed: keep a record if it carries at least
 * one `viewTrackingSpecs.viewName` matching a domain we map from, and say
 * exactly what was dropped. Silent truncation would make a fixture look
 * complete when it is not.
 */
/**
 * The discriminators this fixture exists to teach.
 *
 * Not "every profile-ish view": that rule kept eighteen of twenty records and 8
 * MB, because a browsemap card and an app-config blob both carry tracked views.
 * This list names the FIELDS a mapping needs — top card, about, experience,
 * contact — and nothing else earns its bytes.
 *
 * Adding a mapping target means adding to this list and, usually, recording
 * again. That is the honest cost, and it is better paid explicitly than by
 * committing a capture whole in case something in it turns out to be useful.
 */
const KEEP =
  /^(profile-top-card|profile-card-(about|experience)|profile-contact-info|contact-|experience-)/;

interface Record_ {
  url: string;
  bodySize: number | null;
  bodyFormat: string | null;
  body: unknown;
}

function viewNames(value: unknown, out: Set<string>, depth = 0): void {
  if (depth > 60 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const v of value) viewNames(v, out, depth + 1);
    return;
  }
  const node = value as Record<string, unknown>;
  const specs = node.viewTrackingSpecs as { viewName?: unknown } | undefined;
  if (specs && typeof specs.viewName === "string") out.add(specs.viewName);
  for (const v of Object.values(node)) viewNames(v, out, depth + 1);
}

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error("Usage: npx tsx scripts/trim-snapshot.ts <in.json> <out.json>");
  process.exit(1);
}

const snapshot = JSON.parse(readFileSync(input, "utf8")) as {
  records: Record_[];
  note?: string | null;
  recordCount?: number;
};

const dropped: Array<{ url: string; bytes: number | null; why: string }> = [];
const candidates: Array<{ record: Record_; views: string[] }> = [];

for (const record of snapshot.records) {
  const names = new Set<string>();
  viewNames(record.body, names);
  const relevant = [...names].filter((n) => KEEP.test(n)).sort();
  if (relevant.length > 0) candidates.push({ record, views: relevant });
  else {
    dropped.push({
      url: record.url,
      bytes: record.bodySize,
      why: names.size === 0 ? "no tracked views at all" : "carries no field this fixture teaches",
    });
  }
}

/**
 * A record whose views are all covered by a RICHER record teaches nothing extra.
 *
 * One session visited two profiles, so the capture holds two profile documents.
 * The second one's discriminators are a subset of the first's — it is another
 * person's copy of the same structure, and 800 KB for a second copy is not a
 * trade worth making. Richest first, so the subset is the one dropped.
 */
const byRichness = [...candidates].sort((a, b) => b.views.length - a.views.length);
const kept: Record_[] = [];
const covered = new Set<string>();
for (const { record, views } of byRichness) {
  if (views.every((v) => covered.has(v))) {
    dropped.push({
      url: record.url,
      bytes: record.bodySize,
      why: `its views are all covered by a richer record (${views.join(", ")})`,
    });
    continue;
  }
  for (const v of views) covered.add(v);
  kept.push(record);
}

const out = {
  ...snapshot,
  recordCount: kept.length,
  records: kept,
  /** What was removed, so the file cannot pretend to be a whole capture. */
  trimmed: {
    rule: "kept records carrying a viewTrackingSpecs.viewName matching /^(profile|contact|experience)-/",
    droppedCount: dropped.length,
    dropped,
  },
};
/**
 * Written COMPACT, not pretty-printed.
 *
 * Indentation tripled the file — 456 KB of body became 1.5 MB on disk — and a
 * 500,000-line JSON diff is not readable at any indentation. It is machine-read;
 * `jq` exists for when a human needs to look.
 */
writeFileSync(output, JSON.stringify(out));

const size = (n: number) => `${Math.round(n / 1024)} KB`;
console.log(`  kept    ${kept.length} record(s)`);
for (const r of kept) {
  const names = new Set<string>();
  viewNames(r.body, names);
  console.log(`     ${String(r.bodySize).padStart(8)}  ${[...names].filter((n) => KEEP.test(n)).length} views  ${r.url.slice(0, 62)}`);
}
console.log(`  dropped ${dropped.length} record(s), ${size(dropped.reduce((a, b) => a + (b.bytes ?? 0), 0))} of bodies`);
console.log(`  ${size(readFileSync(input).length)} → ${size(readFileSync(output).length)}`);
