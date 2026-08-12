import { test, expect } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

/**
 * CLAUDE.md hard rule #6: "A Claude-drafted outreach message cannot be marked
 * Sent without human modification."
 *
 * The rule lives on the SERVER, so these tests defeat the client-side guard on
 * purpose (re-enabling the disabled button) and assert the database still
 * refuses. A test that only checked the button would prove nothing.
 */
// Each test re-seeds the same lead, so they must not run concurrently.
test.describe.configure({ mode: "serial" });

const prisma = new PrismaClient();
const COMPANY = "E2E Guardrail Kft.";

let leadId = "";
let messageId = "";
const DRAFT = "Ran a check on E2E Guardrail Kft. — the site scores 51/100 and is not mobile-friendly.";

async function clean(): Promise<void> {
  const leads = await prisma.lead.findMany({
    where: { company: { name: COMPANY } },
    select: { id: true },
  });
  const ids = leads.map((l) => l.id);
  if (ids.length) {
    await prisma.message.deleteMany({ where: { leadId: { in: ids } } });
    await prisma.activity.deleteMany({ where: { leadId: { in: ids } } });
    await prisma.lead.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.company.deleteMany({ where: { name: COMPANY } });
}

test.beforeEach(async () => {
  await clean();
  const ws = await prisma.workspace.findFirst({ orderBy: { createdAt: "asc" } });
  if (!ws) throw new Error("no workspace");
  const company = await prisma.company.create({
    data: { workspaceId: ws.id, name: COMPANY, city: "Budapest" },
  });
  const lead = await prisma.lead.create({
    data: {
      workspaceId: ws.id,
      companyId: company.id,
      contactName: "Guardrail Tester",
      stage: "RESEARCHED",
      icpScore: 4, // above the gate, so only rule #6 is under test
    },
  });
  leadId = lead.id;

  // Exactly the shape `draftOutreach` leaves behind: body === aiDraftBody.
  const msg = await prisma.message.create({
    data: {
      workspaceId: ws.id,
      leadId,
      direction: "OUTBOUND",
      channel: "LINKEDIN",
      kind: "connection",
      body: DRAFT,
      aiDrafted: true,
      aiDraftBody: DRAFT,
      humanEdited: false,
      status: "DRAFT",
    },
  });
  messageId = msg.id;
});

test.afterAll(async () => {
  await clean();
  await prisma.$disconnect();
});

test("an untouched Claude draft cannot be marked sent, even past the UI guard", async ({ page }) => {
  await page.goto(`/outreach?lead=${leadId}`);
  await expect(page.getByTestId("outreach-body")).toHaveValue(DRAFT);

  // The UI warns up front...
  await expect(page.getByTestId("guardrail-hint")).toBeVisible();

  // ...and pressing on anyway is refused by the server, which is where the rule
  // actually lives.
  await page.getByTestId("mark-sent").click();
  await expect(page.getByTestId("outreach-message")).toContainText(/haven't changed it/i);

  const msg = await prisma.message.findUnique({ where: { id: messageId } });
  expect(msg?.status).toBe("DRAFT");
  expect(msg?.sentAt).toBeNull();
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  expect(lead?.stage).toBe("RESEARCHED");
});

test("padding the draft with whitespace does not count as editing it", async ({ page }) => {
  await page.goto(`/outreach?lead=${leadId}`);
  await page.getByTestId("outreach-body").fill(`  ${DRAFT}   `);

  await page.getByTestId("mark-sent").click();
  await expect(page.getByTestId("outreach-message")).toContainText(/haven't changed it/i);

  expect((await prisma.message.findUnique({ where: { id: messageId } }))?.status).toBe("DRAFT");
});

test("a genuine edit unlocks sending and advances the lead", async ({ page }) => {
  await page.goto(`/outreach?lead=${leadId}`);
  await page
    .getByTestId("outreach-body")
    .fill("Szia! Ranéztem az oldalatokra — mobilon nehezen használható. Érdekel egy rövid átnézés?");

  await page.getByTestId("mark-sent").click();
  await expect(page.getByTestId("outreach-message")).toContainText("Marked sent");

  const msg = await prisma.message.findUnique({ where: { id: messageId } });
  expect(msg?.status).toBe("SENT");
  expect(msg?.humanEdited).toBe(true);
  expect(msg?.sentAt).not.toBeNull();

  // First outbound touch moves the lead into Contacted.
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  expect(lead?.stage).toBe("CONTACTED");
  const activity = await prisma.activity.findFirst({ where: { leadId, type: "outreach_sent" } });
  expect(activity).not.toBeNull();
});

test("the connection note enforces LinkedIn's 300-character cap", async ({ page }) => {
  await page.goto(`/outreach?lead=${leadId}`);
  await page.getByTestId("outreach-body").fill("x".repeat(320));

  await expect(page.getByTestId("char-counter")).toHaveText("320 / 300");

  await page.getByTestId("mark-sent").click();
  await expect(page.getByTestId("outreach-message")).toContainText(/capped at 300/i);
  expect((await prisma.message.findUnique({ where: { id: messageId } }))?.status).toBe("DRAFT");
});

test("two follow-ups with no reply park the lead as Not now", async ({ page }) => {
  const ws = await prisma.workspace.findFirst({ orderBy: { createdAt: "asc" } });
  // Connection + first follow-up already out, hand-written (no AI gate involved).
  for (const kind of ["connection", "fu1"]) {
    await prisma.message.create({
      data: {
        workspaceId: ws!.id,
        leadId,
        direction: "OUTBOUND",
        channel: "LINKEDIN",
        kind,
        body: `already sent ${kind}`,
        aiDrafted: false,
        humanEdited: true,
        status: "SENT",
        sentAt: new Date(),
      },
    });
  }
  await prisma.lead.update({ where: { id: leadId }, data: { stage: "CONTACTED" } });

  await page.goto(`/outreach?lead=${leadId}`);
  // exact: the lead list also says "next: Follow-up 2", which substring-matches.
  await page.getByRole("button", { name: "Follow-up 2", exact: true }).click();
  await page.getByRole("button", { name: "Blank draft" }).click();
  // Wait for the draft to exist before typing into it.
  await expect(page.getByTestId("outreach-message")).toContainText("Blank draft started");
  await page.getByTestId("outreach-body").fill("Utolsó üzenet — ha most nem aktuális, megértem.");
  await page.getByTestId("mark-sent").click();

  await expect(page.getByTestId("outreach-message")).toContainText(/parked as Not now/i);
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  expect(lead?.stage).toBe("NOT_NOW");
  expect(lead?.wakeUpAt).not.toBeNull();
});
