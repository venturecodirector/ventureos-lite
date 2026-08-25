import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

/**
 * Delivery after the win (playbook-v3 P11/2), through the real UI.
 *
 * The deal is seeded straight into the Won stage rather than dragged there —
 * the drag is the deals board's own test. What this proves is the handover:
 * the offer appears on a won deal, the checklist is real, and the project
 * refuses to close over an unissued certificate.
 */
const prisma = new PrismaClient();
test.afterAll(() => prisma.$disconnect());

async function seedWonDeal(title: string) {
  const ws = await prisma.workspace.findFirst({ orderBy: { createdAt: "asc" } });
  const pipeline = await prisma.pipeline.findFirst({
    where: { workspaceId: ws!.id },
    orderBy: { position: "asc" },
  });
  const won = await prisma.dealStage.findFirst({
    where: { pipelineId: pipeline!.id, kind: "won" },
  });
  const company = await prisma.company.create({
    data: { workspaceId: ws!.id, name: `Project Co ${Date.now()}` },
  });
  const deal = await prisma.deal.create({
    data: {
      workspaceId: ws!.id,
      title,
      value: 900_000,
      pipelineId: pipeline!.id,
      stageId: won!.id,
      status: "WON",
      companyId: company.id,
      closedAt: new Date(),
    },
  });
  return { dealId: deal.id, pipelineId: pipeline!.id };
}

test("a won deal offers a project, and the certificate blocks the close", async ({ page }) => {
  const title = `Project Deal ${Date.now()}`;
  const { dealId, pipelineId } = await seedWonDeal(title);

  await page.goto(`/deals?pipeline=${pipelineId}`);
  const card = page.locator('[data-testid="deal-card"]', { hasText: title });
  await expect(card).toBeVisible();

  // The offer is on the won deal, and only there.
  await card.getByTestId("deal-start-project").click();

  // Lands on the checklist itself, not on a list to search.
  await expect(page.getByTestId("milestone-row").first()).toBeVisible({ timeout: 30_000 });
  const rows = page.getByTestId("milestone-row");
  expect(await rows.count()).toBeGreaterThan(3);
  await expect(page.getByText("Teljesítésigazolás")).toBeVisible();

  // Tick everything except the certificate — the state that hides the gap.
  const boxes = page.locator('[data-testid="milestone-check-generic"]');
  const n = await boxes.count();
  for (let i = 0; i < n; i++) {
    await boxes.nth(i).check();
    await expect(boxes.nth(i)).toBeChecked({ timeout: 15_000 });
  }

  await page.getByTestId("project-close").click();
  await expect(page.getByText(/teljesítésigazolás még nincs kiállítva/)).toBeVisible({
    timeout: 20_000,
  });

  // Issue it, and the project closes.
  await page.locator('[data-testid="milestone-check-certificate"]').check();
  await page.getByTestId("project-close").click();
  await expect(page.getByText("Projekt lezárva.")).toBeVisible({ timeout: 20_000 });

  // Cleanup: this spec seeds outside the shared prefixes.
  const project = await prisma.project.findUnique({ where: { dealId } });
  if (project) {
    await prisma.milestone.deleteMany({ where: { projectId: project.id } });
    await prisma.task.deleteMany({ where: { entityType: "project", entityId: project.id } });
    await prisma.project.delete({ where: { id: project.id } });
  }
  await prisma.deal.delete({ where: { id: dealId } });
});
