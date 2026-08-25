import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prismaUnsafe, getWorkspaceClient } from "../../src/lib/db";
import { runRulesForQuote, markAcceptedQuotes, ruleEffectiveness } from "../../src/modules/quote-rules/store";

/**
 * The playbook's VERIFICATION line for P14/3, executed:
 *
 *   "a fixture quote with 3 opens fires the call-task rule exactly once"
 *
 * Plus the two things a rule engine gets wrong quietly: firing on a quote that
 * has already been signed, and never learning whether it helped.
 */
const NAMES = ["QuoteRule Alpha"];
let ws = "";

async function clean() {
  const stale = await prismaUnsafe.workspace.findMany({
    where: { name: { in: NAMES } },
    select: { id: true },
  });
  const ids = stale.map((w) => w.id);
  if (!ids.length) return;
  for (const t of [
    "quoteRuleRun",
    "quoteAcceptance",
    "pageVisit",
    "message",
    "task",
    "document",
    "lead",
    "company",
  ] as const) {
    // @ts-expect-error dynamic model access
    await prismaUnsafe[t].deleteMany({ where: { workspaceId: { in: ids } } });
  }
  await prismaUnsafe.workspace.deleteMany({ where: { id: { in: ids } } });
}

beforeAll(async () => {
  await clean();
  ws = (await prismaUnsafe.workspace.create({ data: { name: NAMES[0] } })).id;
});
afterAll(clean);

beforeEach(async () => {
  for (const t of ["quoteRuleRun", "quoteAcceptance", "pageVisit", "message", "task", "document", "lead"] as const) {
    // @ts-expect-error dynamic model access
    await prismaUnsafe[t].deleteMany({ where: { workspaceId: ws } });
  }
});

async function quoteWithOpens(sessions: number, over: Record<string, unknown> = {}) {
  const db = getWorkspaceClient(ws);
  const lead = await db.lead.create({ data: { workspaceId: ws, contactName: "Olvasó Olga" } });
  const slug = `q-${Date.now()}-${Math.round(sessions * 7919)}`;
  const doc = await db.document.create({
    data: {
      workspaceId: ws,
      leadId: lead.id,
      type: "QUOTE",
      number: "AJ-2026-001",
      acceptSlug: slug,
      payload: {},
    },
  });
  for (let i = 0; i < sessions; i++) {
    await db.pageVisit.create({
      data: {
        workspaceId: ws,
        pageType: "quote",
        pageSlug: slug,
        sessionToken: `sess-${i}-${slug}`,
        lastSeenAt: new Date(),
        scrollPct: 95,
        sections: { pricing: 5_000, scope: 20_000 },
        ...over,
      },
    });
  }
  return { doc, lead, slug };
}

describe("three opens without an acceptance", () => {
  it("fires the call-task rule EXACTLY once, however often it is evaluated", async () => {
    const { doc, lead } = await quoteWithOpens(3);
    const db = getWorkspaceClient(ws);

    expect(await runRulesForQuote(ws, doc.id)).toEqual(["repeat_open"]);
    // Evaluated again — on the next visit, and again by the daily sweep.
    expect(await runRulesForQuote(ws, doc.id)).toEqual([]);
    expect(await runRulesForQuote(ws, doc.id)).toEqual([]);

    expect(await db.quoteRuleRun.count({ where: { documentId: doc.id } })).toBe(1);

    const tasks = await db.task.findMany({ where: { entityType: "lead", entityId: lead.id } });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.title).toContain("3×");
    expect(tasks[0]!.type).toBe("call");
  });

  it("prepares a DRAFT, never a sent message", async () => {
    const { doc, lead } = await quoteWithOpens(3);
    await runRulesForQuote(ws, doc.id);

    const db = getWorkspaceClient(ws);
    const drafts = await db.message.findMany({ where: { leadId: lead.id } });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.status).toBe("DRAFT");
    expect(drafts[0]!.sentAt).toBeNull();
    expect(drafts[0]!.direction).toBe("OUTBOUND");
  });

  it("does not fire on two opens", async () => {
    const { doc } = await quoteWithOpens(2);
    expect(await runRulesForQuote(ws, doc.id)).toEqual([]);
  });

  /**
   * The reading was the client checking what they signed. Chasing them for it
   * is the fastest way to look careless.
   */
  it("stays silent once the quote has been accepted", async () => {
    const { doc } = await quoteWithOpens(6);
    const db = getWorkspaceClient(ws);
    await db.quoteAcceptance.create({
      data: { workspaceId: ws, documentId: doc.id, acceptedByName: "Ügyfél" },
    });
    expect(await runRulesForQuote(ws, doc.id)).toEqual([]);
    expect(await db.quoteRuleRun.count()).toBe(0);
  });
});

describe("price dwell", () => {
  it("fires when the time went to the price and never to the scope", async () => {
    const { doc } = await quoteWithOpens(1, {
      sections: { pricing: 150_000, scope: 0 },
      scrollPct: 30,
    });
    expect(await runRulesForQuote(ws, doc.id)).toContain("price_dwell");
  });
});

describe("effectiveness", () => {
  /**
   * A rule engine that only counts its own firings tells you which rules are
   * loudest. This is what lets the quarterly review say which ones were
   * followed by a signature.
   */
  it("credits a rule when the quote is accepted afterwards", async () => {
    const { doc } = await quoteWithOpens(4);
    await runRulesForQuote(ws, doc.id);

    const db = getWorkspaceClient(ws);
    await db.quoteAcceptance.create({
      data: { workspaceId: ws, documentId: doc.id, acceptedByName: "Ügyfél" },
    });

    expect(await markAcceptedQuotes(ws)).toBe(1);
    const run = await db.quoteRuleRun.findFirst({ where: { documentId: doc.id } });
    expect(run!.acceptedAt).toBeTruthy();

    const eff = await ruleEffectiveness(ws);
    const repeat = eff.find((e) => e.ruleId === "repeat_open")!;
    expect(repeat.fired).toBe(1);
    expect(repeat.accepted).toBe(1);
    // One sample is not a rate — reporting 100% from it would be a lie.
    expect(repeat.rate).toBeNull();
  });
});
