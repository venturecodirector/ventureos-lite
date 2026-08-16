import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

/**
 * The Revenue tab (playbook-v3 P11/1b).
 *
 * The maths is unit-tested; what these prove is that the tab renders the real
 * book — including the clause the P11 VERIFICATION names: a churned
 * subscription showing as negative MRR in the month it churned.
 */
test.describe.configure({ mode: "serial" });

const prisma = new PrismaClient();
const TAG = "E2E Revenue";

let workspaceId = "";
let companyId = "";

async function reset() {
  await prisma.subscriptionEvent.deleteMany({ where: { workspaceId } });
  await prisma.subscription.deleteMany({ where: { workspaceId } });
  await prisma.company.deleteMany({ where: { workspaceId, name: { startsWith: TAG } } });
  companyId = (
    await prisma.company.create({
      data: { workspaceId, name: `${TAG} Danubia`, clientStatus: "CLIENT" },
    })
  ).id;
}

/** A subscription plus its event log, written directly for a known shape. */
async function seedSubscription(opts: {
  monthlyNet: number;
  startedAt: string;
  churnedAt?: string;
  churnReason?: string;
  status?: "ACTIVE" | "PAUSED" | "CHURNED";
  plan?: string;
}) {
  const sub = await prisma.subscription.create({
    data: {
      workspaceId,
      companyId,
      planName: opts.plan ?? "Hosting",
      monthlyNet: opts.monthlyNet,
      startDate: new Date(opts.startedAt),
      status: opts.status ?? (opts.churnedAt ? "CHURNED" : "ACTIVE"),
      churnedAt: opts.churnedAt ? new Date(opts.churnedAt) : null,
      churnReason: opts.churnReason ?? null,
      source: "hosting",
    },
  });
  await prisma.subscriptionEvent.create({
    data: {
      workspaceId,
      subscriptionId: sub.id,
      kind: "new",
      deltaNet: opts.monthlyNet,
      monthlyNetAfter: opts.monthlyNet,
      at: new Date(opts.startedAt),
    },
  });
  if (opts.churnedAt) {
    await prisma.subscriptionEvent.create({
      data: {
        workspaceId,
        subscriptionId: sub.id,
        kind: "churn",
        deltaNet: -opts.monthlyNet,
        monthlyNetAfter: 0,
        reason: opts.churnReason ?? null,
        at: new Date(opts.churnedAt),
      },
    });
  }
  return sub;
}

/** A month key inside the 12-month chart window, relative to today. */
function monthsAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(15);
  d.setUTCMonth(d.getUTCMonth() - n);
  return d.toISOString().slice(0, 10);
}

test.beforeAll(async () => {
  const user = await prisma.user.findUnique({ where: { email: "e2e-runner@ventureco.test" } });
  const membership = await prisma.membership.findFirst({ where: { userId: user!.id } });
  workspaceId = membership!.workspaceId;
});

test.afterAll(async () => {
  await prisma.subscriptionEvent.deleteMany({ where: { workspaceId } });
  await prisma.subscription.deleteMany({ where: { workspaceId } });
  await prisma.company.deleteMany({ where: { workspaceId, name: { startsWith: TAG } } });
  await prisma.$disconnect();
});

test("Analytics offers a Revenue tab and it is reachable", async ({ page }) => {
  await reset();
  await page.goto("/analytics");
  await expect(page.getByTestId("analytics-tab-performance")).toHaveAttribute(
    "aria-current",
    "true",
  );

  await page.getByTestId("analytics-tab-revenue").click();
  await expect(page).toHaveURL(/tab=revenue/);
  await expect(page.getByTestId("analytics-tab-revenue")).toHaveAttribute("aria-current", "true");
});

test("an empty book says so rather than drawing a chart of nothing", async ({ page }) => {
  await reset();
  await page.goto("/analytics?tab=revenue");
  await expect(page.getByTestId("revenue-mrr")).toHaveText("0 Ft");
  await expect(page.getByTestId("revenue-empty")).toBeVisible();
});

test("the headline numbers come from the live book", async ({ page }) => {
  await reset();
  await seedSubscription({ monthlyNet: 100_000, startedAt: monthsAgo(6) });
  await seedSubscription({ monthlyNet: 50_000, startedAt: monthsAgo(4) });

  await page.goto("/analytics?tab=revenue");
  await expect(page.getByTestId("revenue-mrr")).toHaveText("150 000 Ft");
  await expect(page.getByTestId("revenue-arr")).toHaveText("1 800 000 Ft");
  // Two subscriptions, one company: one client.
  await expect(page.getByTestId("revenue-clients")).toHaveText("1");
  await expect(page.getByTestId("revenue-arpc")).toHaveText("150 000 Ft");
});

test("a paused subscription is off the MRR but still on the book", async ({ page }) => {
  await reset();
  await seedSubscription({ monthlyNet: 100_000, startedAt: monthsAgo(6) });
  await seedSubscription({ monthlyNet: 60_000, startedAt: monthsAgo(5), status: "PAUSED" });

  await page.goto("/analytics?tab=revenue");
  await expect(page.getByTestId("revenue-mrr")).toHaveText("100 000 Ft");
  await page.getByTestId("sub-filter-PAUSED").click();
  await expect(page.getByTestId("subscription-row")).toHaveCount(1);
});

test("a churned subscription shows as negative MRR in the month it churned", async ({ page }) => {
  // The P11 VERIFICATION clause, on the real page.
  await reset();
  await seedSubscription({
    monthlyNet: 200_000,
    startedAt: monthsAgo(6),
    churnedAt: monthsAgo(2),
    churnReason: "price",
  });

  await page.goto("/analytics?tab=revenue");
  // It left the book entirely.
  await expect(page.getByTestId("revenue-mrr")).toHaveText("0 Ft");

  // The churn column carries the negative bar, titled with the amount, and it
  // sits in the month of the churn — not the month it started.
  const chart = page.getByTestId("movement-chart");
  const churnBar = chart.locator('[title*="churn"]');
  await expect(churnBar).toHaveCount(1);
  // Normalise before comparing: hu-HU formatting uses a non-breaking space as
  // the thousands separator, so a regex over the raw title matches nothing.
  const title = (await churnBar.getAttribute("title")) ?? "";
  expect(title.replace(/[^\d-]/g, "")).toBe("-200000");

  const columns = chart.locator("> div");
  const churnMonth = monthsAgo(2).slice(0, 7);
  const startMonth = monthsAgo(6).slice(0, 7);
  const label = (m: string) =>
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"][
      Number(m.split("-")[1]) - 1
    ];
  // The churn bar belongs to the churn month's column.
  const churnColumn = columns.filter({ hasText: label(churnMonth) });
  await expect(churnColumn.locator('[title*="churn"]')).toHaveCount(1);
  const startColumn = columns.filter({ hasText: label(startMonth) });
  await expect(startColumn.locator('[title*="churn"]')).toHaveCount(0);
  await expect(startColumn.locator('[title*="new"]')).toHaveCount(1);
});

test("the churn breakdown counts reasons", async ({ page }) => {
  await reset();
  await seedSubscription({
    monthlyNet: 100_000,
    startedAt: monthsAgo(8),
    churnedAt: monthsAgo(3),
    churnReason: "price",
  });
  await seedSubscription({
    monthlyNet: 30_000,
    startedAt: monthsAgo(7),
    churnedAt: monthsAgo(2),
    churnReason: "price",
  });
  await seedSubscription({
    monthlyNet: 250_000,
    startedAt: monthsAgo(9),
    churnedAt: monthsAgo(1),
    churnReason: "went_quiet",
  });

  await page.goto("/analytics?tab=revenue");
  const breakdown = page.getByTestId("churn-breakdown");
  await expect(breakdown).toBeVisible();
  // Worst first: went_quiet took more MRR than the two price churns together.
  await expect(breakdown.locator("> div").first()).toContainText("went quiet");
  await expect(breakdown).toContainText("×2");
});

test("the status filter narrows the subscriptions table", async ({ page }) => {
  await reset();
  await seedSubscription({ monthlyNet: 100_000, startedAt: monthsAgo(6), plan: "Live one" });
  await seedSubscription({
    monthlyNet: 40_000,
    startedAt: monthsAgo(6),
    churnedAt: monthsAgo(1),
    churnReason: "budget_cut",
    plan: "Gone one",
  });

  await page.goto("/analytics?tab=revenue");
  // Defaults to active.
  await expect(page.getByTestId("subscription-row")).toHaveCount(1);
  await expect(page.getByTestId("subscriptions-table")).toContainText("Live one");

  await page.getByTestId("sub-filter-ALL").click();
  await expect(page.getByTestId("subscription-row")).toHaveCount(2);
  await expect(page.getByTestId("subscriptions-table")).toContainText("Gone one");

  await page.getByTestId("sub-filter-CHURNED").click();
  await expect(page.getByTestId("subscription-row")).toHaveCount(1);
  await expect(page.getByTestId("subscriptions-table")).toContainText("budget cut");
});
