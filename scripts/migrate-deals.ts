/**
 * The P4 deals migration runner (playbook-v2 P4/d).
 *
 *   npm run deals:migrate -- --dry-run    print the mapping, write nothing
 *   npm run deals:migrate -- --apply      create pipelines + deals, relink docs
 *   npm run deals:migrate -- --verify     post-migration integrity check
 *   npm run deals:migrate -- --rollback   delete exactly what --apply created
 *
 * `--dry-run` is the default, so a mistyped flag inspects rather than writes.
 * The dry-run output is committed into docs/migrations/p4-deals.md as the
 * record of what the real run was authorised to do.
 */

import { prismaUnsafe } from "../src/lib/db";
import {
  allWorkspaceIds,
  apply,
  plan,
  rollback,
  verify,
  type MigrationPlan,
} from "../src/modules/deals/migrate";

function huf(n: number): string {
  return `${n.toLocaleString("hu-HU")} Ft`;
}

function printPlan(p: MigrationPlan): void {
  console.log(`\n=== workspace: ${p.workspaceName} (${p.workspaceId}) ===`);
  console.log("\nLeads by stage (every prior state, accounted for):");
  const stages = Object.entries(p.leadsByStage).sort((a, b) => b[1] - a[1]);
  const totalLeads = stages.reduce((n, [, c]) => n + c, 0);
  for (const [stage, count] of stages) {
    const owned = ["QUALIFIED", "MEETING_BOOKED", "HANDED_OFF"].includes(stage);
    console.log(`  ${stage.padEnd(16)} ${String(count).padStart(5)}  ${owned ? "→ deal" : "stays a lead"}`);
  }
  console.log(`  ${"TOTAL".padEnd(16)} ${String(totalLeads).padStart(5)}`);

  console.log(`\nPipelines to create: ${p.pipelinesToCreate.join(", ") || "none (already present)"}`);
  console.log(`Leads already migrated (skipped): ${p.alreadyMigrated}`);
  console.log(`\nDeals to create: ${p.deals.length}`);

  if (p.deals.length) {
    console.log(
      `\n  ${"LEAD".padEnd(26)}${"COMPANY".padEnd(28)}${"FROM".padEnd(16)}` +
        `${"PIPELINE".padEnd(14)}${"STAGE".padEnd(20)}${"STATUS".padEnd(8)}${"VALUE".padStart(14)}  SRC`,
    );
    for (const d of p.deals) {
      console.log(
        `  ${d.leadName.slice(0, 24).padEnd(26)}` +
          `${(d.companyName ?? "—").slice(0, 26).padEnd(28)}` +
          `${d.leadStage.padEnd(16)}` +
          `${d.pipelineKey.padEnd(14)}` +
          `${d.stageName.padEnd(20)}` +
          `${d.status.padEnd(8)}` +
          `${huf(d.value).padStart(14)}  ${d.valueSource}`,
      );
    }
  }

  const byPipeline = new Map<string, number>();
  const byStage = new Map<string, number>();
  let value = 0;
  for (const d of p.deals) {
    byPipeline.set(d.pipelineKey, (byPipeline.get(d.pipelineKey) ?? 0) + 1);
    byStage.set(`${d.pipelineKey}/${d.stageKey}`, (byStage.get(`${d.pipelineKey}/${d.stageKey}`) ?? 0) + 1);
    value += d.value;
  }
  console.log("\nSummary:");
  for (const [k, n] of [...byPipeline].sort()) console.log(`  pipeline ${k.padEnd(14)} ${n}`);
  for (const [k, n] of [...byStage].sort()) console.log(`  stage    ${k.padEnd(28)} ${n}`);
  console.log(`  total deal value              ${huf(value)}`);
  console.log(`  documents to relink           ${p.documentsToLink}`);
  console.log(`  subscriptions to relink       ${p.subscriptionsToLink}`);
  console.log(`  outcomes to relink            ${p.outcomesToLink}`);
}

async function main() {
  const argv = process.argv.slice(2);
  const mode = argv.includes("--apply")
    ? "apply"
    : argv.includes("--rollback")
      ? "rollback"
      : argv.includes("--verify")
        ? "verify"
        : "dry-run";

  const workspaces = await allWorkspaceIds();
  console.log(`P4 deals migration — mode: ${mode} — ${workspaces.length} workspace(s)`);

  let failed = false;

  for (const ws of workspaces) {
    if (mode === "dry-run") {
      printPlan(await plan(ws.id));
      continue;
    }
    if (mode === "apply") {
      const before = await plan(ws.id);
      printPlan(before);
      const res = await apply(ws.id);
      console.log(
        `\nAPPLIED to ${ws.name}: ${res.dealsCreated} deal(s), ` +
          `${res.pipelinesCreated} pipeline(s) created, ` +
          `${res.documentsLinked} document(s), ${res.subscriptionsLinked} subscription(s), ` +
          `${res.outcomesLinked} outcome(s) relinked.`,
      );
      continue;
    }
    if (mode === "rollback") {
      const res = await rollback(ws.id);
      console.log(
        `\nROLLED BACK ${ws.name}: ${res.dealsDeleted} deal(s) deleted, ` +
          `${res.documentsUnlinked} document(s), ${res.subscriptionsUnlinked} subscription(s), ` +
          `${res.outcomesUnlinked} outcome(s) unlinked. Pipelines left in place.`,
      );
      continue;
    }
    const report = await verify(ws.id);
    console.log(`\n=== integrity: ${report.workspaceName} (${report.workspaceId}) ===`);
    for (const c of report.checks) {
      console.log(`  [${c.ok ? "PASS" : "FAIL"}] ${c.name}\n         ${c.detail}`);
    }
    console.log(`  → ${report.ok ? "OK" : "FAILED"}`);
    if (!report.ok) failed = true;
  }

  await prismaUnsafe.$disconnect();
  if (failed) process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  await prismaUnsafe.$disconnect();
  process.exit(1);
});
