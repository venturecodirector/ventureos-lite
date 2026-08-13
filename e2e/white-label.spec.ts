import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

/**
 * P2/6 — full white-label.
 *
 * The failure this guards against is concrete: a second workspace sends a
 * prospect a report signed by someone else's agency. So the test creates a
 * second workspace with a different identity, publishes a share link from it,
 * and asserts the rendered page carries ITS brand and no trace of the seed one
 * — plus a screenshot of each, so a visual regression is inspectable rather
 * than only assertable.
 */
test.use({ storageState: { cookies: [], origins: [] } });

const prisma = new PrismaClient();
const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const OTHER_BRAND = {
  name: "Studio Kft",
  markBold: "studio",
  markLight: "kft",
  color: "#00A3FF",
  gradientFrom: "#003A5C",
  gradientTo: "#00A3FF",
  footerIdentity: "Studio Kft · Debrecen",
};

const slugs: Record<"seed" | "other", string> = {
  seed: `e2e-brand-seed-${RUN}`,
  other: `e2e-brand-other-${RUN}`,
};
let otherWorkspaceId = "";

const CHECKS = [
  { key: "https", label: "HTTPS", pass: true, detail: null },
  { key: "viewport", label: "Mobil nézet", pass: false, detail: "hiányzó viewport" },
];

async function seedShare(workspaceId: string, slug: string, url: string) {
  const audit = await prisma.auditResult.create({
    data: {
      workspaceId,
      url,
      status: "done",
      score: 64,
      verdict: "STRONG",
      flags: ["nincs mobil nézet"],
      checks: CHECKS,
      screenshots: {},
      expiresAt: new Date(Date.now() + 9e10),
    },
  });
  await prisma.auditShare.create({
    data: { workspaceId, auditId: audit.id, slug, expiresAt: new Date(Date.now() + 9e10) },
  });
}

test.beforeAll(async () => {
  const seedWs = await prisma.workspace.findFirst({ select: { id: true } });
  const other = await prisma.workspace.create({
    data: { name: `Studio Kft ${RUN}`, brand: OTHER_BRAND },
    select: { id: true },
  });
  otherWorkspaceId = other.id;

  await seedShare(seedWs!.id, slugs.seed, `https://seed-${RUN}.hu`);
  await seedShare(other.id, slugs.other, `https://other-${RUN}.hu`);
});

test.afterAll(async () => {
  await prisma.auditShare.deleteMany({ where: { slug: { in: Object.values(slugs) } } });
  await prisma.auditResult.deleteMany({ where: { url: { contains: RUN } } });
  await prisma.workspace.deleteMany({ where: { id: otherWorkspaceId } });
  await prisma.$disconnect();
});

test("a second workspace's share page carries its own brand, not ours", async ({ page }) => {
  await page.goto(`/share/${slugs.other}`);
  await expect(page.locator("body")).toContainText("studio");
  await expect(page.locator("body")).toContainText("Studio Kft · Debrecen");

  // The whole point: nothing of the seed brand survives on another tenant's
  // prospect-facing page. innerText, not textContent — the latter includes
  // Next's inline RSC payload, which carries the repo path and would fail this
  // assertion for a reason that has nothing to do with branding.
  const text = await page.locator("main").innerText();
  expect(text.toLowerCase()).not.toContain("venture");

  await page.screenshot({ path: "test-results/white-label-other.png", fullPage: true });
});

test("the seed workspace still renders as Venture", async ({ page }) => {
  await page.goto(`/share/${slugs.seed}`);
  await expect(page.locator("body")).toContainText("venture");
  await page.screenshot({ path: "test-results/white-label-seed.png", fullPage: true });
});

test("the two pages are visually distinct", async ({ page }) => {
  await page.goto(`/share/${slugs.other}`);
  const otherShot = await page.screenshot({ fullPage: true });
  await page.goto(`/share/${slugs.seed}`);
  const seedShot = await page.screenshot({ fullPage: true });

  // Same report, same layout, different identity — the bytes must differ, or
  // the branding is not reaching the pixels at all.
  expect(Buffer.compare(otherShot, seedShot)).not.toBe(0);
});
