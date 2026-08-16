import { describe, it, expect } from "vitest";
import {
  NOTIFICATION_TYPES,
  NOTIFICATION_TYPE_DEFS,
  RETENTION_DAYS,
  dedupeKeyFor,
  defaultChannels,
  isNotificationType,
  resolveChannels,
  retentionCutoff,
  visibleTypesFor,
} from "../../src/modules/notifications/types";

/**
 * The notification catalogue (playbook-v2 P6/1). Pure: which types exist, who
 * may receive them, which channels are on by default, and how one event is kept
 * from notifying twice.
 */

describe("the catalogue", () => {
  it("covers every type the playbook lists that has a real event source", () => {
    expect([...NOTIFICATION_TYPES]).toEqual(
      expect.arrayContaining([
        "reply_received",
        "escalation",
        "callback_due",
        "task_due",
        "quote_accepted",
        "quote_declined",
        "meeting_booked",
        "campaign_paused",
        "sync_failed",
        "proposal_pending",
      ]),
    );
  });

  it("gives every type a label and a definition", () => {
    for (const type of NOTIFICATION_TYPES) {
      const def = NOTIFICATION_TYPE_DEFS[type];
      expect(def, type).toBeDefined();
      expect(def.label.length).toBeGreaterThan(0);
      expect(def.description.length).toBeGreaterThan(0);
    }
  });

  it("recognises its own types and rejects anything else", () => {
    expect(isNotificationType("callback_due")).toBe(true);
    expect(isNotificationType("meeting_cancelled")).toBe(false);
    expect(isNotificationType(null)).toBe(false);
  });
});

describe("default channels", () => {
  it("turns in-app on for everything — that is the point of the centre", () => {
    for (const type of NOTIFICATION_TYPES) {
      expect(defaultChannels(type).inApp, type).toBe(true);
    }
  });

  it("leaves push off until someone asks for it", () => {
    // Push needs an explicit browser permission prompt; defaulting it on would
    // promise a delivery nobody has granted.
    for (const type of NOTIFICATION_TYPES) {
      expect(defaultChannels(type).push, type).toBe(false);
    }
  });

  it("puts the time-critical types in the digest and leaves the noisy ones out", () => {
    expect(defaultChannels("callback_due").emailDigest).toBe(true);
    expect(defaultChannels("escalation").emailDigest).toBe(true);
    // A reply lands in the inbox itself; repeating every one in the weekly
    // digest is the fastest way to make the digest unread.
    expect(defaultChannels("reply_received").emailDigest).toBe(false);
  });
});

describe("who may receive what", () => {
  it("keeps the Signal Engine proposal for Owners", () => {
    expect(NOTIFICATION_TYPE_DEFS.proposal_pending.ownerOnly).toBe(true);
    expect(visibleTypesFor("BDR")).not.toContain("proposal_pending");
    expect(visibleTypesFor("OWNER")).toContain("proposal_pending");
  });

  it("gives a BDR everything that is not Owner-only", () => {
    const bdr = visibleTypesFor("BDR");
    expect(bdr).toContain("callback_due");
    expect(bdr).toContain("reply_received");
  });

  it("silences an Owner-only type for a BDR on every channel", () => {
    // Belt and braces: even a stored preference row cannot opt a BDR into a
    // type they are not allowed to see.
    const channels = resolveChannels(
      "proposal_pending",
      { inApp: true, push: true, emailDigest: true },
      "BDR",
    );
    expect(channels).toEqual({ inApp: false, push: false, emailDigest: false });
  });
});

describe("resolving a user's channels", () => {
  it("falls back to the defaults when nothing is stored", () => {
    expect(resolveChannels("callback_due", null, "BDR")).toEqual(
      defaultChannels("callback_due"),
    );
  });

  it("lets a stored preference override each channel independently", () => {
    const stored = { inApp: false, push: true, emailDigest: false };
    expect(resolveChannels("callback_due", stored, "BDR")).toEqual(stored);
  });

  it("treats a partial stored row as an override of only what it sets", () => {
    const resolved = resolveChannels("callback_due", { push: true }, "BDR");
    expect(resolved.push).toBe(true);
    expect(resolved.inApp).toBe(defaultChannels("callback_due").inApp);
  });

  it("returns everything off for a type that does not exist any more", () => {
    // A preference row written before a type was retired must not resurrect it.
    expect(resolveChannels("meeting_cancelled", { inApp: true }, "OWNER")).toEqual({
      inApp: false,
      push: false,
      emailDigest: false,
    });
  });
});

describe("dedupe keys", () => {
  it("is stable for the same event", () => {
    expect(dedupeKeyFor("callback_due", "call-1")).toBe(dedupeKeyFor("callback_due", "call-1"));
  });

  it("separates two entities of the same type", () => {
    expect(dedupeKeyFor("callback_due", "call-1")).not.toBe(
      dedupeKeyFor("callback_due", "call-2"),
    );
  });

  it("separates the same entity under different types", () => {
    expect(dedupeKeyFor("quote_accepted", "doc-1")).not.toBe(
      dedupeKeyFor("quote_declined", "doc-1"),
    );
  });

  it("takes a discriminator, so a recurring event can notify again", () => {
    // An overdue task should be able to nag once a day rather than once ever.
    expect(dedupeKeyFor("task_due", "task-1", "2026-08-16")).not.toBe(
      dedupeKeyFor("task_due", "task-1", "2026-08-17"),
    );
  });
});

describe("retention", () => {
  it("keeps 90 days", () => {
    expect(RETENTION_DAYS).toBe(90);
  });

  it("computes the cutoff from a given now", () => {
    const now = new Date("2026-08-16T12:00:00Z");
    const cutoff = retentionCutoff(now);
    expect(cutoff.toISOString()).toBe("2026-05-18T12:00:00.000Z");
  });
});
