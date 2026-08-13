import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { escalationReason } from "@/modules/inbox/escalation";

/**
 * playbook-v2 P2c/P2d — the two rules that carry the risk.
 *
 * Both are enforced in server actions that need a session, so rather than
 * standing up an authenticated request this pins them where they can actually
 * be pinned: the escalation classifier itself, and the STRUCTURE of the code
 * that must call it. A structural assertion is weaker than an end-to-end one,
 * and much stronger than nothing — these are the two places a refactor would
 * silently remove a guarantee.
 */
const src = (p: string) => readFileSync(join(process.cwd(), "src", p), "utf8");

describe("money talk locks a reply", () => {
  it("recognises price, proposal and contract mentions in both languages", () => {
    expect(escalationReason("Mennyibe kerül ez?")).toBe("price");
    expect(escalationReason("Kérek egy árajánlatot")).toBe("proposal");
    expect(escalationReason("Küldd át a szerződést")).toBe("contract");
    expect(escalationReason("What is the cost?")).toBe("price");
    expect(escalationReason("Please send a proposal")).toBe("proposal");
    expect(escalationReason("Ready to sign the contract")).toBe("contract");
  });

  it("leaves ordinary correspondence alone", () => {
    expect(escalationReason("Köszönöm, jövő héten ráérek")).toBeNull();
    expect(escalationReason("Thanks, next week works")).toBeNull();
  });

  it("is consulted before a reply can be sent", () => {
    const sender = src("modules/email/send-gmail.ts");
    expect(sender).toContain("escalationReason");
    // And the send is refused unless the operator acknowledged it — a warning
    // that does not block is not a lock.
    expect(sender).toMatch(/acknowledgeEscalation/);
    expect(sender).toMatch(/error:\s*"escalated"/);
  });
});

describe("the AI budget rule", () => {
  it("is the message-open path that calls Claude, not the sync", () => {
    // The playbook is explicit: reply analysis runs when a human opens an
    // unread inbound message, never in bulk during backfill.
    expect(src("modules/email/thread-actions.ts")).toContain("callClaude");
    expect(src("modules/email/jobs.ts")).not.toContain("callClaude");
    expect(src("modules/email/ingest.ts")).not.toContain("callClaude");
    expect(src("modules/email/gmail.ts")).not.toContain("callClaude");
  });

  it("stamps analyzedAt even when the call fails, so a click cannot re-spend", () => {
    const actions = src("modules/email/thread-actions.ts");
    // The update must sit outside the try/catch that swallows a budget cap,
    // or one lead clicked repeatedly drains a day's budget.
    const afterCatch = actions.slice(actions.indexOf("/* budget cap"));
    expect(afterCatch).toContain("analyzedAt");
  });

  it("skips outbound and already-analysed messages before spending anything", () => {
    const actions = src("modules/email/thread-actions.ts");
    expect(actions).toMatch(/direction !== "INBOUND" \|\| message\.analyzedAt/);
  });
});

describe("cold and personal sending stay apart", () => {
  it("the Gmail sender imports nothing from campaigns", () => {
    expect(src("modules/email/send-gmail.ts")).not.toMatch(/modules\/campaigns/);
  });

  it("the Gmail sender goes through the user's own mailbox, not a relay", () => {
    const sender = src("modules/email/send-gmail.ts");
    expect(sender).toContain("GmailProvider");
    // Assert on IMPORTS, not on the word: the file's own comment explains the
    // Mailgun separation, and a prose match would fail on the documentation of
    // the rule it is checking.
    const imports = sender
      .split("\n")
      .filter((l) => l.trim().startsWith("import"))
      .join("\n");
    expect(imports).not.toMatch(/mailgun/i);
    expect(imports).not.toContain("mail/provider");
    // The shared suppression list IS imported, and should be: someone who
    // asked not to be contacted means it on every channel.
    expect(imports).toContain("mail/suppression");
  });

  it("refuses to send from a mailbox belonging to another user", () => {
    expect(src("modules/email/send-gmail.ts")).toContain("thread.account.userId !== userId");
  });
});

describe("a learned link is written when a thread is matched by hand", () => {
  it("upserts an AddressLink so the correction is permanent", () => {
    const actions = src("modules/email/thread-actions.ts");
    expect(actions).toContain("addressLink.upsert");
    // Every counterpart address, not only the sender — a colleague replying
    // from a second address should match next time too.
    expect(actions).toContain("toAddresses");
  });
});
