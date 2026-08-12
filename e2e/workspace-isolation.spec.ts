import { test, expect, type BrowserContext } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { getWorkspaceClient } from "../src/lib/db";
import { hashPassword } from "../src/lib/auth/password";
import { signInAs, E2E_PASSWORD } from "./helpers/auth";

/**
 * Spec acceptance criterion 8 (Phase-4 exit): a user assigned only to workspace
 * B sees ZERO rows from workspace A — proven through the UI, the API, the file
 * route, and at the database-policy level (Prisma guard + RLS + session
 * membership validation). Public-page slugs are the deliberate unauthenticated
 * exception and are covered explicitly.
 */
// Shared module state + one-time seed → run serially in a single worker.
test.describe.configure({ mode: "serial" });

// These specs manage their own sessions — start from a signed-out browser.
test.use({ storageState: { cookies: [], origins: [] } });

const prisma = new PrismaClient();
const FILES_DIR = process.env.FILES_DIR ?? "/data/files";
const A_NAME = "Isolation Alpha";
const B_NAME = "Isolation Bravo";

let wsA = "";
let wsB = "";
let userA = "";
let userB = "";
let aLeadId = "";
let aDocId = "";
let aDocPath = "";
let acceptSlug = "";
let shareSlug = "";

async function clean() {
  const stale = await prisma.workspace.findMany({ where: { name: { in: [A_NAME, B_NAME] } }, select: { id: true } });
  const ids = stale.map((w) => w.id);
  if (ids.length) {
    for (const t of ["quoteAcceptance", "auditShare", "auditResult", "document", "lead", "company"] as const) {
      // @ts-expect-error dynamic model access
      await prisma[t].deleteMany({ where: { workspaceId: { in: ids } } });
    }
    await prisma.workspace.deleteMany({ where: { id: { in: ids } } });
  }
  const staleUsers = await prisma.user.findMany({
    where: { email: { in: ["a@iso.test", "b@iso.test"] } },
    select: { id: true },
  });
  if (staleUsers.length) {
    await prisma.session.deleteMany({ where: { userId: { in: staleUsers.map((u) => u.id) } } });
  }
  await prisma.loginAttempt.deleteMany({ where: { email: { in: ["a@iso.test", "b@iso.test"] } } });
  await prisma.user.deleteMany({ where: { email: { in: ["a@iso.test", "b@iso.test"] } } });
}

test.beforeAll(async () => {
  await clean();

  const a = await prisma.workspace.create({ data: { name: A_NAME } });
  const b = await prisma.workspace.create({ data: { name: B_NAME } });
  wsA = a.id;
  wsB = b.id;
  // Real password hashes: these users sign in through the actual login form.
  const hash = await hashPassword(E2E_PASSWORD);
  userA = (await prisma.user.create({ data: { email: "a@iso.test", name: "Alice Alpha", passwordHash: hash } })).id;
  userB = (await prisma.user.create({ data: { email: "b@iso.test", name: "Bob Bravo", passwordHash: hash } })).id;
  await prisma.membership.create({ data: { userId: userA, workspaceId: wsA, role: "OWNER" } });
  await prisma.membership.create({ data: { userId: userB, workspaceId: wsB, role: "OWNER" } }); // member of B ONLY

  // Workspace A private data.
  const coA = await prisma.company.create({ data: { workspaceId: wsA, name: "Alpha Secret Co" } });
  aLeadId = (await prisma.lead.create({ data: { workspaceId: wsA, companyId: coA.id, contactName: "Alpha Secret Lead", stage: "MEETING_BOOKED" } })).id;
  const doc = await prisma.document.create({ data: { workspaceId: wsA, leadId: aLeadId, type: "QUOTE", acceptSlug: `acc-${Date.now()}` } });
  aDocId = doc.id;
  acceptSlug = doc.acceptSlug!;
  aDocPath = `documents/${aDocId}.pdf`;
  await prisma.document.update({ where: { id: aDocId }, data: { pdfUrl: aDocPath } });
  await mkdir(join(FILES_DIR, "documents"), { recursive: true });
  await writeFile(join(FILES_DIR, aDocPath), Buffer.from("%PDF-1.4 alpha-secret"));
  const audit = await prisma.auditResult.create({ data: { workspaceId: wsA, companyId: coA.id, url: "http://a", status: "done", expiresAt: new Date(Date.now() + 9e10) } });
  shareSlug = (await prisma.auditShare.create({ data: { workspaceId: wsA, auditId: audit.id, leadId: aLeadId, slug: `shr-${Date.now()}`, expiresAt: new Date(Date.now() + 9e10) } })).slug;

  // Workspace B's own data (so B's views aren't empty for the wrong reason).
  const coB = await prisma.company.create({ data: { workspaceId: wsB, name: "Bravo Own Co" } });
  await prisma.lead.create({ data: { workspaceId: wsB, companyId: coB.id, contactName: "Bravo Own Lead", stage: "MEETING_BOOKED" } });
});

test.afterAll(async () => {
  await clean();
  await prisma.$disconnect();
});

/** Sign in as one of the two isolation users, through the real login form. */
async function asUser(context: BrowserContext, email: string) {
  await signInAs(context, email);
}

test("database-policy level: B's guarded client reads/mutates zero A rows", async () => {
  const dbB = getWorkspaceClient(wsB);
  // Reads: none of A's rows are visible through B's client.
  expect(await dbB.lead.count({ where: { id: aLeadId } })).toBe(0);
  expect(await dbB.company.findMany({ where: { name: "Alpha Secret Co" } })).toHaveLength(0);
  expect(await dbB.document.count({ where: { id: aDocId } })).toBe(0);
  expect(await dbB.auditShare.count({})).toBe(0);
  // Mutations: an update targeting A's lead through B's client matches nothing.
  const res = await dbB.lead.updateMany({ where: { id: aLeadId }, data: { stage: "DISQUALIFIED" } });
  expect(res.count).toBe(0);
  // A's lead is unchanged.
  const aLead = await prisma.lead.findUnique({ where: { id: aLeadId } });
  expect(aLead?.stage).toBe("MEETING_BOOKED");
});

test("UI: user B sees only workspace B data, even with a tampered session row", async ({ page, context }) => {
  await asUser(context, "b@iso.test");
  await page.goto("/pipeline");
  await expect(page.getByTestId("active-workspace")).toHaveText(B_NAME);
  await expect(page.getByText("Bravo Own Lead")).toBeVisible();
  await expect(page.getByText("Alpha Secret Lead")).toHaveCount(0);

  // Tamper at the strongest point available: the active workspace now lives on
  // the SESSION ROW (no client-writable cookie exists any more), so point B's
  // own session at workspace A directly in the database. Membership is
  // re-checked on every request, so the session is repaired back to B and no A
  // data leaks.
  await prisma.session.updateMany({
    where: { userId: userB, revokedAt: null },
    data: { workspaceId: wsA },
  });
  await page.goto("/pipeline");
  await expect(page.getByTestId("active-workspace")).toHaveText(B_NAME);
  await expect(page.getByText("Alpha Secret Lead")).toHaveCount(0);
});

test("file route: B cannot read A's document PDF; A can", async ({ browser }) => {
  const ctxB = await browser.newContext();
  await asUser(ctxB, "b@iso.test");
  const bRes = await ctxB.request.get(`/api/files/${aDocPath}`);
  expect(bRes.status()).toBe(404); // cross-workspace → fail closed
  await ctxB.close();

  const ctxA = await browser.newContext();
  await asUser(ctxA, "a@iso.test");
  const aRes = await ctxA.request.get(`/api/files/${aDocPath}`);
  expect(aRes.status()).toBe(200); // owner reads its own file
  expect(await aRes.text()).toContain("alpha-secret");
  await ctxA.close();
});

test("public-page slugs: reachable unauthenticated (by design), not via B's tenant scope", async ({ browser }) => {
  // The public pages are the intended cross-tenant exception (unlisted slug).
  const anon = await browser.newContext();
  const accept = await anon.request.get(`/accept/${acceptSlug}`);
  expect(accept.status()).toBeLessThan(500); // renders (public), not a tenant leak path
  const share = await anon.request.get(`/share/${shareSlug}`);
  expect(share.status()).toBeLessThan(500);
  await anon.close();

  // But B's authenticated, workspace-scoped client cannot enumerate A's slugs.
  const dbB = getWorkspaceClient(wsB);
  expect(await dbB.auditShare.count({})).toBe(0);
  expect(await dbB.quoteAcceptance.count({})).toBe(0);
});
