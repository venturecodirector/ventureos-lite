/**
 * Realistic scale data for performance work (playbook-v2 P6/3).
 *
 *   npm run seed:scale            5,000 leads and 2,000 deals
 *   npm run seed:scale -- --clean remove them again
 *
 * Everything it creates is tagged (companies are named "Scale …", leads carry a
 * `scale_fixture` signal, deals a `scale_fixture` source), so `--clean` removes
 * exactly its own rows and nothing a person has been working on.
 *
 * REALISTIC, not random noise: the point is to make the slow queries slow in
 * the way they will actually be slow. So the leads are spread across stages in
 * roughly the shape a real funnel has, names carry Hungarian accents (the fuzzy
 * search folds them, and folding is O(n) over every candidate), a third have
 * signals, and the deals sit across both pipelines with close dates spread over
 * six months so the forecast has something to group.
 */

import { PrismaClient } from "@prisma/client";
import { DEFAULT_PIPELINES } from "../src/modules/deals/pipelines";

const prisma = new PrismaClient();

const LEADS = Number(process.env.SCALE_LEADS ?? 5000);
const DEALS = Number(process.env.SCALE_DEALS ?? 2000);
const FIXTURE_SIGNAL = "scale_fixture";
const FIXTURE_SOURCE = "scale_fixture";
const COMPANY_PREFIX = "Scale";

const FIRST = ["Anna", "Péter", "Kata", "Gábor", "Zsófia", "Bence", "Réka", "Ádám", "Eszter", "Máté"];
const LAST = ["Kovács", "Nagy", "Tóth", "Szabó", "Horváth", "Varga", "Kiss", "Molnár", "Németh", "Farkas"];
const INDUSTRIES = ["HoReCa", "Retail", "Fogászat", "Építőipar", "Ügyvédi iroda", "Webshop", "Fitness"];
const CITIES = ["Budapest", "Debrecen", "Szeged", "Győr", "Pécs", "Miskolc", "Kecskemét"];
const SIGNALS = ["hiring", "új telephely", "pályázat", "rebrand", "funding", "expansion"];
const STAGES = [
  ["RESEARCHED", 0.42],
  ["CONTACTED", 0.22],
  ["ACCEPTED", 0.08],
  ["REPLIED", 0.07],
  ["QUALIFIED", 0.06],
  ["MEETING_BOOKED", 0.05],
  ["HANDED_OFF", 0.03],
  ["NOT_NOW", 0.05],
  ["DISQUALIFIED", 0.02],
] as const;

/** Deterministic pseudo-random, so two runs produce the same database. */
function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function pickStage(r: number): string {
  let acc = 0;
  for (const [stage, weight] of STAGES) {
    acc += weight;
    if (r <= acc) return stage;
  }
  return "RESEARCHED";
}

async function targetWorkspace(): Promise<{ id: string; name: string }> {
  const ws = await prisma.workspace.findFirst({ orderBy: { createdAt: "asc" } });
  if (!ws) throw new Error("No workspace. Run `npm run db:seed` first.");
  return { id: ws.id, name: ws.name };
}

async function clean(workspaceId: string): Promise<void> {
  const companies = await prisma.company.findMany({
    where: { workspaceId, name: { startsWith: `${COMPANY_PREFIX} ` } },
    select: { id: true },
  });
  const companyIds = companies.map((c) => c.id);
  const deals = await prisma.deal.deleteMany({
    where: { workspaceId, source: FIXTURE_SOURCE },
  });
  const leads = await prisma.lead.deleteMany({
    where: { workspaceId, companyId: { in: companyIds } },
  });
  const removed = await prisma.company.deleteMany({ where: { id: { in: companyIds } } });
  console.log(
    `Removed ${leads.count} lead(s), ${deals.count} deal(s) and ${removed.count} company(ies).`,
  );
}

async function main() {
  const cleanOnly = process.argv.includes("--clean");
  const ws = await targetWorkspace();
  console.log(`Workspace: ${ws.name} (${ws.id})`);

  if (cleanOnly) {
    await clean(ws.id);
    return;
  }

  // Idempotent: a re-run replaces the fixture rather than doubling it.
  await clean(ws.id);

  const random = rng(20260817);
  const started = Date.now();

  // Companies first, in bulk — one per lead is unrealistic, so roughly one
  // company per 1.4 leads, which is what a prospected list actually looks like.
  const companyCount = Math.ceil(LEADS / 1.4);
  const companyRows = Array.from({ length: companyCount }, (_, i) => ({
    workspaceId: ws.id,
    name: `${COMPANY_PREFIX} ${LAST[i % LAST.length]} ${INDUSTRIES[i % INDUSTRIES.length]} ${i}`,
    domain: `scale-${i}.example.hu`,
    industry: INDUSTRIES[i % INDUSTRIES.length],
    city: CITIES[i % CITIES.length],
    sizeBand: ["1-5", "6-20", "21-50", "51-200"][i % 4],
  }));
  await prisma.company.createMany({ data: companyRows });
  const companies = await prisma.company.findMany({
    where: { workspaceId: ws.id, name: { startsWith: `${COMPANY_PREFIX} ` } },
    select: { id: true },
  });
  console.log(`Companies: ${companies.length}`);

  const now = Date.now();
  const leadRows = Array.from({ length: LEADS }, (_, i) => {
    const r = random();
    const stage = pickStage(random());
    const hasSignals = random() < 0.35;
    const ageDays = Math.floor(random() * 240);
    return {
      workspaceId: ws.id,
      companyId: companies[i % companies.length].id,
      contactName: `${LAST[i % LAST.length]} ${FIRST[(i * 7) % FIRST.length]}`,
      title: ["Ügyvezető", "Marketing vezető", "Tulajdonos", "Operatív igazgató"][i % 4],
      email: `scale${i}@example.hu`,
      phone: `+3630${String(1_000_000 + i).slice(0, 7)}`,
      source: "MANUAL" as const,
      stage: stage as never,
      stageEnteredAt: new Date(now - ageDays * 86_400_000),
      icpScore: r < 0.15 ? null : 1 + Math.floor(random() * 5),
      signals: hasSignals ? [SIGNALS[i % SIGNALS.length], FIXTURE_SIGNAL] : [FIXTURE_SIGNAL],
      lastActivityAt: random() < 0.8 ? new Date(now - Math.floor(random() * 90) * 86_400_000) : null,
      createdAt: new Date(now - ageDays * 86_400_000),
    };
  });

  // Chunked: one 5,000-row INSERT is a single statement Postgres will happily
  // take and Prisma will happily build in memory, but it makes a failure
  // all-or-nothing and the progress invisible.
  const CHUNK = 500;
  for (let i = 0; i < leadRows.length; i += CHUNK) {
    await prisma.lead.createMany({ data: leadRows.slice(i, i + CHUNK) });
    process.stdout.write(`\rLeads: ${Math.min(i + CHUNK, leadRows.length)}/${leadRows.length}`);
  }
  console.log("");

  // Pipelines, if the workspace has none yet.
  for (const p of DEFAULT_PIPELINES) {
    const exists = await prisma.pipeline.findFirst({
      where: { workspaceId: ws.id, key: p.key },
      select: { id: true },
    });
    if (exists) continue;
    await prisma.pipeline.create({
      data: {
        workspaceId: ws.id,
        key: p.key,
        name: p.name,
        position: p.position,
        isDefault: p.isDefault,
        stages: {
          create: p.stages.map((s, i) => ({
            workspaceId: ws.id,
            key: s.key,
            name: s.name,
            position: i,
            probability: s.probability,
            rottingDays: s.rottingDays,
            kind: s.kind,
          })),
        },
      },
    });
  }
  const pipelines = await prisma.pipeline.findMany({
    where: { workspaceId: ws.id },
    include: { stages: { orderBy: { position: "asc" } } },
  });

  const scaleLeads = await prisma.lead.findMany({
    where: { workspaceId: ws.id, companyId: { in: companies.map((c) => c.id) } },
    select: { id: true, companyId: true },
    take: DEALS,
  });

  const dealRows = scaleLeads.map((lead, i) => {
    const pipeline = pipelines[i % pipelines.length];
    const openStages = pipeline.stages.filter((s) => s.kind === "open");
    const stage = openStages[i % openStages.length];
    const closed = random() < 0.25;
    // The kind is rolled ONCE. Rolling inside the predicate re-rolls for every
    // stage `find` tests, so the match depends on iteration order and can miss
    // entirely — which is exactly how this returned undefined the first time.
    const wonOrLost = random() < 0.6 ? "won" : "lost";
    const terminal = pipeline.stages.find((s) => s.kind === wonOrLost)!;
    return {
      workspaceId: ws.id,
      leadId: lead.id,
      companyId: lead.companyId,
      title: `Scale deal ${i}`,
      value: 200_000 + Math.floor(random() * 40) * 100_000,
      pipelineId: pipeline.id,
      stageId: closed ? terminal.id : stage.id,
      stageEnteredAt: new Date(now - Math.floor(random() * 90) * 86_400_000),
      expectedCloseAt: new Date(now + Math.floor(random() * 180) * 86_400_000),
      status: (closed ? (terminal.kind === "won" ? "WON" : "LOST") : "OPEN") as never,
      source: FIXTURE_SOURCE,
    };
  });
  for (let i = 0; i < dealRows.length; i += CHUNK) {
    await prisma.deal.createMany({ data: dealRows.slice(i, i + CHUNK) });
    process.stdout.write(`\rDeals: ${Math.min(i + CHUNK, dealRows.length)}/${dealRows.length}`);
  }
  console.log("");

  console.log(
    `Seeded ${leadRows.length} leads and ${dealRows.length} deals in ${(
      (Date.now() - started) / 1000
    ).toFixed(1)}s.`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
