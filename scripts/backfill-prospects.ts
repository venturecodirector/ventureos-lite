/**
 * The prospected-company backfill, from a terminal (P4/1e).
 *
 *   npm run prospects:backfill -- --dry-run   print every proposed change
 *   npm run prospects:backfill -- --apply     write them
 *
 * `--dry-run` is the default, so a mistyped flag inspects rather than writes.
 *
 * ── ONLY THE FREE PASS ─────────────────────────────────────────────────────
 *
 * This runs what can be derived from data the workspace already holds: the town
 * out of the stored address, the industry out of the closed English→Hungarian
 * category map, and the company's phone number in the canonical spelling, also
 * onto the lead. It costs nothing and asks nobody.
 *
 * The Google pass is deliberately NOT here. It spends the workspace's Places
 * budget and it can propose replacing a company's name, so it belongs where a
 * person can see each row and untick it: Prospector → "korábbi prospectek
 * feltöltése".
 */

import { prismaUnsafe } from "../src/lib/db";
import { applyPlans, backfillState, previewLocal } from "../src/modules/prospector/backfill-store";

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");

  const workspaces = await prismaUnsafe.workspace.findMany({ select: { id: true, name: true } });
  for (const workspace of workspaces) {
    const state = await backfillState(workspace.id);
    if (state.total === 0) continue;

    console.log(`\n── ${workspace.name} ──────────────────────────────────`);
    console.log(
      `${state.total} prospected companies · ${state.missingCity} without a city · ` +
        `${state.missingPhone} without a phone · ${state.englishIndustry} with an English industry · ` +
        `${state.missingEmail} leads without an email`,
    );

    const preview = await previewLocal(workspace.id);
    if (!preview.plans.length) {
      console.log("nothing to derive locally.");
      continue;
    }

    for (const plan of preview.plans) {
      console.log(`  ${plan.label}`);
      for (const c of plan.changes) {
        console.log(`    ${c.field}: ${c.overwrites ? `${c.from} → ` : ""}${c.to}`);
      }
    }
    const fields = preview.plans.reduce((n, p) => n + p.changes.length, 0);
    console.log(`  ${preview.plans.length} companies, ${fields} fields.`);
    if (preview.notice) console.log(`  ${preview.notice}`);

    if (!apply) {
      console.log("  (dry run — nothing written)");
      continue;
    }

    // The run is attributed to an Owner, because the audit entry has to name a
    // person and this is the person who would have clicked the button.
    const owner = await prismaUnsafe.membership.findFirst({
      where: { workspaceId: workspace.id, role: "OWNER" },
      select: { userId: true },
    });
    if (!owner) {
      console.log("  SKIPPED — this workspace has no Owner to attribute the run to.");
      continue;
    }

    const result = await applyPlans(
      workspace.id,
      owner.userId,
      preview.plans.map((p) => ({
        companyId: p.companyId,
        changes: p.changes.map((c) => ({ field: c.field, to: c.to })),
      })),
    );
    console.log(
      `  written: ${result.companies} companies, ${result.fields} fields, ` +
        `${result.emailsFound} emails read off websites.`,
    );
    if (result.notice) console.log(`  ${result.notice}`);
  }

  await prismaUnsafe.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prismaUnsafe.$disconnect();
  process.exit(1);
});
