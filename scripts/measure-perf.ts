/**
 * Timing the slowest interactions (playbook-v2 P6/3).
 *
 *   npm run perf                 measure and print
 *   npm run perf -- --save NAME  also write the numbers to docs/perf/NAME.json
 *   npm run perf -- --compare A B   print A against B
 *
 * Server-side timings only, deliberately. What the playbook asks for is
 * "before/after timings for the 5 slowest interactions", and the five slowest
 * are all dominated by a query and an in-memory pass over its result — the
 * render is a rounding error beside a 5,000-row fetch. A browser harness would
 * add variance without adding information.
 *
 * Each measurement runs a warm-up pass that is discarded (the first Prisma
 * query in a process pays for the connection and the query plan), then the
 * median of N runs. Median rather than mean: one GC pause should not decide
 * whether an optimisation counts.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { prismaUnsafe } from "../src/lib/db";
import { loadLeadsTable, matchingLeadIds } from "../src/modules/leads/table";
import { listPipelines, loadPipelineBoard, dealChipsForLeads } from "../src/modules/deals/store";
import { loadForecast } from "../src/modules/deals/forecast-data";
import { getWorkspaceClient } from "../src/lib/db";
import { broadSearch } from "../src/modules/search/broad";
import { EMPTY_FILTER_SET, DEFAULT_SORT } from "../src/modules/leads/filters";
import { listDuplicateCandidates } from "../src/modules/merge/store";
import { clearCache } from "../src/lib/ttl-cache";

const RUNS = Number(process.env.PERF_RUNS ?? 7);
const OUT_DIR = resolve(process.cwd(), "docs/perf");

interface Measurement {
  name: string;
  medianMs: number;
  minMs: number;
  maxMs: number;
  detail: string;
}

async function measure(
  name: string,
  fn: () => Promise<string>,
): Promise<Measurement> {
  await fn(); // warm-up, discarded
  const times: number[] = [];
  let detail = "";
  for (let i = 0; i < RUNS; i += 1) {
    const started = performance.now();
    detail = await fn();
    times.push(performance.now() - started);
  }
  times.sort((a, b) => a - b);
  return {
    name,
    medianMs: Math.round(times[Math.floor(times.length / 2)] * 10) / 10,
    minMs: Math.round(times[0] * 10) / 10,
    maxMs: Math.round(times[times.length - 1] * 10) / 10,
    detail,
  };
}

async function main() {
  const ws = await prismaUnsafe.workspace.findFirst({ orderBy: { createdAt: "asc" } });
  if (!ws) throw new Error("No workspace. Run `npm run db:seed` first.");
  const db = getWorkspaceClient(ws.id);

  const [leadCount, dealCount] = await Promise.all([
    db.lead.count(),
    db.deal.count(),
  ]);
  console.log(`Workspace ${ws.name} — ${leadCount} leads, ${dealCount} deals, ${RUNS} runs each.\n`);

  const pipelines = await listPipelines(db);
  const firstPipeline = pipelines[0];

  const results: Measurement[] = [];

  results.push(
    await measure("leads table — first page, unfiltered", async () => {
      const page = await loadLeadsTable(ws.id, {
        filters: EMPTY_FILTER_SET,
        sort: DEFAULT_SORT,
        page: 1,
      });
      return `${page.rows.length} rows of ${page.total}`;
    }),
  );

  results.push(
    await measure("leads table — filtered by stage + score", async () => {
      const page = await loadLeadsTable(ws.id, {
        filters: {
          match: "all",
          conditions: [
            { field: "stage", operator: "is", value: "CONTACTED" },
            { field: "icpScore", operator: "gte", value: 3 },
          ],
        },
        sort: DEFAULT_SORT,
        page: 1,
      });
      return `${page.total} matched`;
    }),
  );

  results.push(
    await measure("pipeline board — as the page loads it", async () => {
      const stages = [
        "RESEARCHED",
        "CONTACTED",
        "ACCEPTED",
        "REPLIED",
        "QUALIFIED",
        "MEETING_BOOKED",
        "HANDED_OFF",
        "NOT_NOW",
        "DISQUALIFIED",
      ];
      const perStage = Number(process.env.PERF_STAGE_CAP ?? 25);
      const leads = (
        await Promise.all(
          stages.map((stage) =>
            db.lead.findMany({
              where: { mergedIntoId: null, stage: stage as never },
              orderBy: { stageEnteredAt: "asc" },
              take: perStage > 0 ? perStage : undefined,
              include: { company: { select: { name: true } } },
            }),
          ),
        )
      ).flat();
      const chips = await dealChipsForLeads(
        ws.id,
        leads.map((l) => l.id),
      );
      return `${leads.length} cards, ${chips.size} with a deal`;
    }),
  );

  results.push(
    await measure("deals board — one pipeline", async () => {
      if (!firstPipeline) return "no pipeline";
      const cards = await loadPipelineBoard(ws.id, firstPipeline.id);
      return `${cards.length} cards`;
    }),
  );

  results.push(
    await measure("forecast — six months, every pipeline", async () => {
      const view = await loadForecast(ws.id);
      return `${view.overall.totals.count} open deals`;
    }),
  );

  results.push(
    await measure("global search — fuzzy fallback", async () => {
      const hits = await broadSearch(db, "kovcs");
      return `${hits.length} hits`;
    }),
  );

  results.push(
    await measure("duplicate scan — Settings and the lead banner", async () => {
      clearCache();
      const { companies, leads } = await listDuplicateCandidates(ws.id);
      return `${companies.length} company + ${leads.length} lead candidates`;
    }),
  );

  results.push(
    await measure("select-all-matching — resolve the filtered id set", async () => {
      const ids = await matchingLeadIds(ws.id, {
        match: "all",
        conditions: [{ field: "hasEmail", operator: "is_true" }],
      });
      return `${ids.length} ids`;
    }),
  );

  const width = Math.max(...results.map((r) => r.name.length));
  console.log(`${"INTERACTION".padEnd(width)}  ${"MEDIAN".padStart(9)}  ${"MIN".padStart(8)}  ${"MAX".padStart(8)}  DETAIL`);
  for (const r of results) {
    console.log(
      `${r.name.padEnd(width)}  ${`${r.medianMs}ms`.padStart(9)}  ${`${r.minMs}ms`.padStart(8)}  ${`${r.maxMs}ms`.padStart(8)}  ${r.detail}`,
    );
  }

  const saveIndex = process.argv.indexOf("--save");
  if (saveIndex !== -1 && process.argv[saveIndex + 1]) {
    mkdirSync(OUT_DIR, { recursive: true });
    const path = resolve(OUT_DIR, `${process.argv[saveIndex + 1]}.json`);
    writeFileSync(
      path,
      `${JSON.stringify({ leadCount, dealCount, runs: RUNS, results }, null, 2)}\n`,
    );
    console.log(`\nSaved to ${path}`);
  }

  const compareIndex = process.argv.indexOf("--compare");
  if (compareIndex !== -1 && process.argv[compareIndex + 2]) {
    compare(process.argv[compareIndex + 1], process.argv[compareIndex + 2]);
  }

  await prismaUnsafe.$disconnect();
}

function compare(before: string, after: string): void {
  const read = (name: string) =>
    JSON.parse(readFileSync(resolve(OUT_DIR, `${name}.json`), "utf8")) as {
      results: Measurement[];
    };
  const a = read(before);
  const b = read(after);
  const byName = new Map(b.results.map((r) => [r.name, r]));

  console.log(`\n${before} → ${after}\n`);
  const width = Math.max(...a.results.map((r) => r.name.length));
  for (const row of a.results) {
    const now = byName.get(row.name);
    if (!now) continue;
    const delta = ((now.medianMs - row.medianMs) / row.medianMs) * 100;
    const arrow = delta <= -5 ? "faster" : delta >= 5 ? "SLOWER" : "same";
    console.log(
      `${row.name.padEnd(width)}  ${`${row.medianMs}ms`.padStart(9)} → ${`${now.medianMs}ms`.padStart(9)}  ${`${delta > 0 ? "+" : ""}${delta.toFixed(0)}%`.padStart(6)}  ${arrow}`,
    );
  }
}

main().catch(async (e) => {
  console.error(e);
  await prismaUnsafe.$disconnect();
  process.exit(1);
});
