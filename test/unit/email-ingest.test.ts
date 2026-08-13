import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { ingestMessage, participantsOf } from "@/modules/email/ingest";
import { emptyIndex, type MatchIndex } from "@/modules/email/matching";
import {
  parseAddressList,
  parseDisplayName,
  flattenParts,
  toFetchedMessage,
} from "@/modules/email/gmail";
import type { FetchedMessage } from "@/modules/email/provider";

const SELF = "me@ventureco.group";

function index(over: Partial<MatchIndex> = {}): MatchIndex {
  return { ...emptyIndex(), self: new Set([SELF]), ...over };
}

function message(over: Partial<FetchedMessage> = {}): FetchedMessage {
  return {
    providerMessageId: "m1",
    providerThreadId: "t1",
    headers: {
      from: "anna@nagyceg.hu",
      to: [SELF],
      cc: [],
      subject: "Ajánlatkérés",
      date: new Date("2026-08-01T10:00:00Z"),
    },
    snippet: "Kedves Tamás",
    bodyHtml: "<p>Kedves Tamás,</p><p>érdekelne az ajánlat.</p>",
    bodyText: null,
    attachments: [],
    unread: true,
    ...over,
  };
}

describe("Gmail header parsing", () => {
  it("pulls addresses out of a display-name list", () => {
    expect(parseAddressList('"Nagy Anna" <anna@nagyceg.hu>, peter@masik.hu')).toEqual([
      "anna@nagyceg.hu",
      "peter@masik.hu",
    ]);
  });

  it("reads the display name without swallowing the address", () => {
    expect(parseDisplayName('"Nagy Anna" <anna@nagyceg.hu>')).toBe("Nagy Anna");
    expect(parseDisplayName("anna@nagyceg.hu")).toBeNull();
  });

  it("handles an empty or missing header", () => {
    expect(parseAddressList(null)).toEqual([]);
    expect(parseAddressList("")).toEqual([]);
  });
});

describe("MIME walking", () => {
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");

  it("finds html and text parts in a multipart message", () => {
    const { html, text } = flattenParts({
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/plain", body: { data: b64("sima szöveg") } },
        { mimeType: "text/html", body: { data: b64("<p>html</p>") } },
      ],
    });
    expect(text).toBe("sima szöveg");
    expect(html).toBe("<p>html</p>");
  });

  it("collects attachment metadata without the bytes", () => {
    const { attachments } = flattenParts({
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "text/plain", body: { data: b64("hi") } },
        {
          mimeType: "application/pdf",
          filename: "ajanlat.pdf",
          body: { attachmentId: "att-1", size: 51234 },
        },
      ],
    });
    expect(attachments).toEqual([
      {
        filename: "ajanlat.pdf",
        mimeType: "application/pdf",
        sizeBytes: 51234,
        providerAttachmentId: "att-1",
      },
    ]);
  });

  it("survives a message with no payload at all", () => {
    expect(flattenParts(undefined)).toEqual({ html: null, text: null, attachments: [] });
  });

  it("falls back to now for an unparseable Date rather than Invalid Date", () => {
    // Invalid Date poisons every sort it touches; a bounded-wrong timestamp
    // still puts the message on the timeline.
    const m = toFetchedMessage({
      id: "m",
      threadId: "t",
      payload: { headers: [{ name: "Date", value: "not a date" }] },
    } as Parameters<typeof toFetchedMessage>[0]);
    expect(Number.isNaN(m.headers.date.getTime())).toBe(false);
  });
});

describe("participantsOf", () => {
  it("excludes the mailbox owner", () => {
    const p = participantsOf(
      message({ headers: { ...message().headers, cc: ["peter@masik.hu"] } }),
      new Set([SELF]),
    );
    expect(p).toEqual(["anna@nagyceg.hu", "peter@masik.hu"]);
  });

  it("deduplicates someone appearing twice", () => {
    const p = participantsOf(
      message({
        headers: { ...message().headers, to: [SELF, "anna@nagyceg.hu"] },
      }),
      new Set([SELF]),
    );
    expect(p).toEqual(["anna@nagyceg.hu"]);
  });
});

describe("ingestMessage", () => {
  const idx = index({
    byAddress: new Map([["anna@nagyceg.hu", { leadId: "lead-1", companyId: "c1" }]]),
  });

  it("marks mail from the owner as outbound and everything else inbound", () => {
    expect(ingestMessage(message(), idx).message.direction).toBe("INBOUND");
    const sent = message({
      headers: { ...message().headers, from: SELF, to: ["anna@nagyceg.hu"] },
    });
    expect(ingestMessage(sent, idx).message.direction).toBe("OUTBOUND");
  });

  it("matches the thread to its lead", () => {
    const { match } = ingestMessage(message(), idx);
    expect(match?.leadId).toBe("lead-1");
    expect(match?.matchType).toBe("address");
  });

  it("leaves an unknown correspondent unmatched rather than guessing", () => {
    const { match } = ingestMessage(
      message({ headers: { ...message().headers, from: "idegen@sehol.hu" } }),
      idx,
    );
    expect(match).toBeNull();
  });

  it("stores sanitized HTML, never the original", () => {
    const nasty = message({
      bodyHtml: '<p>hi</p><script>alert(1)</script><img src="https://tracker.hu/o.gif">',
    });
    const { message: out } = ingestMessage(nasty, idx);
    expect(out.bodyHtml).not.toContain("script");
    // A whitespace-anchored match, because `data-blocked-src="https://…"`
    // legitimately contains the substring `src="https://…` — the parked
    // attribute is the point, and a naive contains() would fail on success.
    expect(out.bodyHtml).not.toMatch(/\ssrc="https:\/\/tracker/);
    expect(out.bodyHtml).toContain("data-blocked-src");
    expect(out.blockedImages).toBe(1);
  });

  it("derives plain text when the message had no text part", () => {
    const { message: out } = ingestMessage(message({ bodyText: null }), idx);
    expect(out.bodyText).toBe("Kedves Tamás, érdekelne az ajánlat.");
    expect(out.bodyText).not.toContain("<");
  });

  it("prefers the real text part when there is one", () => {
    const { message: out } = ingestMessage(message({ bodyText: "  eredeti szöveg  " }), idx);
    expect(out.bodyText).toBe("eredeti szöveg");
  });

  it("keeps attachment metadata and flags the message", () => {
    const withFile = message({
      attachments: [
        {
          filename: "a.pdf",
          mimeType: "application/pdf",
          sizeBytes: 10,
          providerAttachmentId: "x",
        },
      ],
    });
    const { message: out } = ingestMessage(withFile, idx);
    expect(out.hasAttachments).toBe(true);
    expect(out.attachments).toHaveLength(1);
  });
});

/**
 * The playbook requires that campaign mail cannot leave through a personal
 * Gmail account — "impossible by construction". A runtime flag can be
 * forgotten in a new call site; a missing import cannot, so the construction
 * is the import graph and this is what proves it.
 */
describe("cold campaigns and Gmail share no code", () => {
  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
      else if ([".ts", ".tsx"].includes(extname(name))) out.push(full);
    }
    return out;
  }

  const root = join(process.cwd(), "src/modules");

  it("no campaign module imports the Gmail sender", () => {
    const offenders = sourceFiles(join(root, "campaigns")).filter((f) => {
      const text = readFileSync(f, "utf8");
      return /from\s+["'].*email\/(gmail|send-gmail)["']/.test(text);
    });
    expect(offenders).toEqual([]);
  });

  it("the Gmail provider imports nothing from campaigns", () => {
    const offenders = sourceFiles(join(root, "email")).filter((f) => {
      const text = readFileSync(f, "utf8");
      return /from\s+["'].*modules\/campaigns/.test(text);
    });
    expect(offenders).toEqual([]);
  });
});
