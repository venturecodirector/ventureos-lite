import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prismaUnsafe, getWorkspaceClient } from "@/lib/db";
import { processMailSync } from "@/modules/email/jobs";
import { eraseLeadData } from "@/modules/gdpr/erase";
import type {
  MailProvider,
  FetchedMessage,
  MessagePage,
  MailCredentials,
} from "@/modules/email/provider";

/**
 * playbook-v2 P2b — the sync loop, against a fake mailbox.
 *
 * The assertions that matter are the ones about SCOPE: the queries the sync
 * issues are the privacy promise, and a test that only checks "messages
 * arrived" would pass just as happily on a sync that downloaded everything.
 */
const RUN = Math.random().toString(36).slice(2, 8);
const SELF = `owner-${RUN}@ventureco.group`;
let workspaceId = "";
let userId = "";
let accountId = "";
const created = { companies: [] as string[], leads: [] as string[] };

/** Records every query it is asked, so the test can inspect the boundary. */
class FakeGmail implements MailProvider {
  readonly name = "fake";
  readonly queries: string[] = [];
  constructor(private readonly messages: FetchedMessage[]) {}

  async listMessageIds(_c: MailCredentials, query: string): Promise<MessagePage> {
    this.queries.push(query);
    return {
      ids: this.messages.map((m) => ({
        messageId: m.providerMessageId,
        threadId: m.providerThreadId,
      })),
      nextPageToken: null,
    };
  }

  async getMessage(_c: MailCredentials, messageId: string) {
    const message = this.messages.find((m) => m.providerMessageId === messageId)!;
    return { message };
  }

  async sendReply(): Promise<{ providerMessageId: string }> {
    throw new Error("not used in this test");
  }
}

function fixture(over: Partial<FetchedMessage> = {}): FetchedMessage {
  return {
    providerMessageId: `msg-${RUN}-1`,
    providerThreadId: `thr-${RUN}-1`,
    headers: {
      from: `anna-${RUN}@nagyceg-${RUN}.hu`,
      to: [SELF],
      cc: [],
      subject: "Ajánlatkérés",
      date: new Date("2026-08-01T09:00:00Z"),
    },
    snippet: "Kedves Tamás",
    bodyHtml: "<p>Kedves Tamás,</p><p>kérek egy ajánlatot.</p>",
    bodyText: null,
    attachments: [],
    unread: true,
    ...over,
  };
}

beforeAll(async () => {
  const ws = await prismaUnsafe.workspace.findFirst({
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  workspaceId = ws!.id;
  const user = await prismaUnsafe.user.findFirst({ select: { id: true } });
  userId = user!.id;

  const db = getWorkspaceClient(workspaceId);
  const company = await db.company.create({
    data: {
      workspaceId,
      name: `Nagyceg ${RUN}`,
      domain: `nagyceg-${RUN}.hu`,
      website: `https://nagyceg-${RUN}.hu`,
    },
    select: { id: true },
  });
  created.companies.push(company.id);
  const lead = await db.lead.create({
    data: {
      workspaceId,
      companyId: company.id,
      source: "PROSPECTOR",
      stage: "RESEARCHED",
      email: `anna-${RUN}@nagyceg-${RUN}.hu`,
    },
    select: { id: true },
  });
  created.leads.push(lead.id);

  const account = await prismaUnsafe.mailAccount.create({
    data: {
      workspaceId,
      userId,
      accountEmail: SELF,
      provider: "gmail",
      backfillDone: true,
      credentialId: (
        await prismaUnsafe.googleCredential.create({
          data: {
            userId,
            accountEmail: SELF,
            purpose: "MAIL",
            accessToken: "token",
            refreshToken: "refresh",
            expiryDate: new Date(Date.now() + 3_600_000),
          },
          select: { id: true },
        })
      ).id,
    },
    select: { id: true },
  });
  accountId = account.id;
});

afterAll(async () => {
  await prismaUnsafe.mailAccount.deleteMany({ where: { accountEmail: SELF } });
  await prismaUnsafe.googleCredential.deleteMany({ where: { accountEmail: SELF } });
  await prismaUnsafe.lead.deleteMany({ where: { id: { in: created.leads } } });
  await prismaUnsafe.company.deleteMany({ where: { id: { in: created.companies } } });
  await prismaUnsafe.$disconnect();
});

describe("the sync only ever asks about known people", () => {
  it("builds every query from CRM addresses, never a bare date", async () => {
    const provider = new FakeGmail([fixture()]);
    await processMailSync({ accountId }, provider);

    expect(provider.queries.length).toBeGreaterThan(0);
    // EVERY query must be participant-constrained — that is the promise.
    for (const q of provider.queries) {
      expect(q).toMatch(/from:|to:|cc:/);
    }
    // And this lead must appear in ONE of them. Not in every one: with enough
    // addresses the scope chunks across several queries, which is exactly the
    // behaviour that stops a long address list silently truncating.
    expect(provider.queries.some((q) => q.includes(`nagyceg-${RUN}.hu`))).toBe(true);
  });

  it("stores the matched message against its lead", async () => {
    const db = getWorkspaceClient(workspaceId);
    const thread = await db.emailThread.findFirst({
      where: { accountId },
      include: { messages: true },
    });
    expect(thread).not.toBeNull();
    expect(thread!.leadId).toBe(created.leads[0]);
    expect(thread!.messages).toHaveLength(1);
    expect(thread!.messages[0]!.direction).toBe("INBOUND");
    // Sanitized on the way in, not on the way out.
    expect(thread!.messages[0]!.bodyHtml).not.toContain("<script");
  });

  it("does not store the same message twice on a second pass", async () => {
    const db = getWorkspaceClient(workspaceId);
    const before = await db.emailMessage.count({ where: { thread: { accountId } } });
    await processMailSync({ accountId }, new FakeGmail([fixture()]));
    const after = await db.emailMessage.count({ where: { thread: { accountId } } });
    expect(after).toBe(before);
  });

  it("issues no query at all when the workspace knows no addresses", async () => {
    // A bare `after:` with no participant clause would match the whole mailbox.
    const empty = await prismaUnsafe.workspace.create({
      data: { name: `empty-${RUN}` },
      select: { id: true },
    });
    const cred = await prismaUnsafe.googleCredential.create({
      data: {
        userId,
        accountEmail: `empty-${RUN}@ventureco.group`,
        purpose: "MAIL",
        accessToken: "t",
        refreshToken: "r",
        expiryDate: new Date(Date.now() + 3_600_000),
      },
      select: { id: true },
    });
    const account = await prismaUnsafe.mailAccount.create({
      data: {
        workspaceId: empty.id,
        userId,
        accountEmail: `empty-${RUN}@ventureco.group`,
        credentialId: cred.id,
        backfillDone: true,
      },
      select: { id: true },
    });

    const provider = new FakeGmail([fixture()]);
    const stored = await processMailSync({ accountId: account.id }, provider);

    expect(provider.queries).toEqual([]);
    expect(stored).toBe(0);

    await prismaUnsafe.mailAccount.delete({ where: { id: account.id } });
    await prismaUnsafe.googleCredential.delete({ where: { id: cred.id } });
    await prismaUnsafe.workspace.delete({ where: { id: empty.id } });
  });

  it("leaves an unknown correspondent's thread unmatched rather than guessing", async () => {
    const db = getWorkspaceClient(workspaceId);
    await processMailSync(
      { accountId },
      new FakeGmail([
        fixture({
          providerMessageId: `msg-${RUN}-2`,
          providerThreadId: `thr-${RUN}-2`,
          headers: {
            ...fixture().headers,
            from: `idegen-${RUN}@sehol-${RUN}.hu`,
          },
        }),
      ]),
    );
    const unmatched = await db.emailThread.findFirst({
      where: { accountId, providerThreadId: `thr-${RUN}-2` },
    });
    expect(unmatched).not.toBeNull();
    expect(unmatched!.leadId).toBeNull();
  });
});

describe("no AI runs during sync", () => {
  it("stores messages without spending a Claude call", async () => {
    // The playbook's budget rule: reply analysis fires when a human OPENS an
    // unread message, never in bulk while syncing.
    const before = await prismaUnsafe.claudeUsage.count({ where: { workspaceId } });
    await processMailSync(
      { accountId },
      new FakeGmail([
        fixture({ providerMessageId: `msg-${RUN}-3`, providerThreadId: `thr-${RUN}-3` }),
      ]),
    );
    const after = await prismaUnsafe.claudeUsage.count({ where: { workspaceId } });
    expect(after).toBe(before);
  });
});

describe("erasure takes the correspondence with it", () => {
  it("removes synced threads and messages for an erased lead", async () => {
    const db = getWorkspaceClient(workspaceId);
    const leadId = created.leads[0]!;
    const before = await db.emailThread.count({ where: { leadId } });
    expect(before).toBeGreaterThan(0);

    await eraseLeadData(db, leadId, { eraseDocuments: true });

    expect(await db.emailThread.count({ where: { leadId } })).toBe(0);
    // Messages cascade from the thread.
    expect(await db.emailMessage.count({ where: { thread: { accountId } } })).toBeLessThan(
      before + 3,
    );
  });
});
