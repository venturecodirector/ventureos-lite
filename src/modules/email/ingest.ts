/**
 * Turning a fetched message into rows (playbook-v2 P2b).
 *
 * Pure over a FetchedMessage plus the match index, so the whole
 * message → thread → lead decision is testable without a mailbox or a
 * database. The caller persists what this returns.
 */
import { matchParticipants, normalizeAddress, type MatchIndex, type MatchResult } from "./matching";
import { sanitizeEmailHtml, htmlToText } from "./sanitize";
import type { FetchedMessage } from "./provider";

export type Direction = "INBOUND" | "OUTBOUND";

export interface IngestedMessage {
  providerMessageId: string;
  providerThreadId: string;
  direction: Direction;
  fromAddress: string;
  toAddresses: string[];
  ccAddresses: string[];
  subject: string | null;
  snippet: string;
  bodyHtml: string;
  bodyText: string;
  hasAttachments: boolean;
  attachments: FetchedMessage["attachments"];
  sentAt: Date;
  unread: boolean;
  blockedImages: number;
}

export interface IngestResult {
  message: IngestedMessage;
  /** Null when nobody in the thread is a known lead — the unmatched queue. */
  match: MatchResult | null;
}

/** Everyone on the message except the mailbox owner. */
export function participantsOf(message: FetchedMessage, self: Set<string>): string[] {
  const all = [message.headers.from, ...message.headers.to, ...message.headers.cc]
    .map(normalizeAddress)
    .filter((a) => a.includes("@"));
  return [...new Set(all)].filter((a) => !self.has(a));
}

export function ingestMessage(message: FetchedMessage, index: MatchIndex): IngestResult {
  const from = normalizeAddress(message.headers.from);
  // Direction is from the mailbox owner's point of view, which is the only
  // point of view the timeline has.
  const direction: Direction = index.self.has(from) ? "OUTBOUND" : "INBOUND";

  const { html, blockedImages } = sanitizeEmailHtml(message.bodyHtml);
  // Prefer the real text/plain part; fall back to flattening the HTML, because
  // the snippet and the reply analysis must never be handed markup.
  const text = message.bodyText?.trim()
    ? message.bodyText.trim()
    : htmlToText(message.bodyHtml);

  return {
    message: {
      providerMessageId: message.providerMessageId,
      providerThreadId: message.providerThreadId,
      direction,
      fromAddress: from,
      toAddresses: message.headers.to,
      ccAddresses: message.headers.cc,
      subject: message.headers.subject,
      snippet: message.snippet || text.slice(0, 200),
      bodyHtml: html,
      bodyText: text,
      hasAttachments: message.attachments.length > 0,
      attachments: message.attachments,
      sentAt: message.headers.date,
      unread: message.unread,
      blockedImages,
    },
    match: matchParticipants(participantsOf(message, index.self), index),
  };
}
