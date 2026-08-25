import { describe, it, expect } from "vitest";
import { quoteLinesFor, kitFrom } from "../../src/modules/meetings/followup";
import { buildFollowupMessage } from "../../src/lib/ai/prompts/meeting-followup";
import { modelForUseCase } from "../../src/lib/ai/models";
import { DEFAULT_SERVICE_MAP } from "../../src/modules/audit/service-map";

/**
 * The post-meeting follow-up kit (playbook-v4 P13/2).
 *
 * The quote half is DETERMINISTIC and must stay that way — CLAUDE.md rule #4
 * keeps AI out of anything that becomes a legal document, and a quote line is
 * the first step of one.
 */

describe("quoteLinesFor", () => {
  it("uses the workspace's own catalogue, not a second one", () => {
    const lines = quoteLinesFor(["seo"], undefined);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.description).toBe(DEFAULT_SERVICE_MAP.seo.item);
  });

  it("suggests the mid-point of the band, rounded to something a person would say", () => {
    const lines = quoteLinesFor(["seo"], undefined);
    const { minHuf, maxHuf } = DEFAULT_SERVICE_MAP.seo;
    expect(lines[0]!.suggestedNet).toBe(Math.round((minHuf + maxHuf) / 2 / 10_000) * 10_000);
    expect(lines[0]!.suggestedNet % 10_000).toBe(0);
    // Integer forints — money is never a float (CLAUDE.md).
    expect(Number.isInteger(lines[0]!.suggestedNet)).toBe(true);
  });

  it("honours an Owner's edited prices instead of the seeded ones", () => {
    const lines = quoteLinesFor(["seo"], {
      serviceMap: { seo: { item: "Saját SEO csomag", minHuf: 200_000, maxHuf: 200_000 } },
    });
    expect(lines[0]!.description).toBe("Saját SEO csomag");
    expect(lines[0]!.suggestedNet).toBe(200_000);
  });

  it("ignores anything that is not a real service key", () => {
    expect(quoteLinesFor(["nonsense", "../etc", ""], undefined)).toEqual([]);
  });

  it("does not repeat a service picked twice", () => {
    expect(quoteLinesFor(["seo", "seo", "legal"], undefined)).toHaveLength(2);
  });

  it("keeps the order they were picked in", () => {
    const lines = quoteLinesFor(["legal", "seo"], undefined);
    expect(lines.map((l) => l.category)).toEqual(["legal", "seo"]);
  });
});

describe("the draft prompt", () => {
  it("passes only facts, and marks the outcome", () => {
    const msg = buildFollowupMessage({
      contactName: "Kovács Anna",
      companyName: "Példa Kft.",
      outcome: "POSTPONED",
      notes: "Ősszel térnek vissza rá.",
      discussedItems: ["Keresőoptimalizálási alapcsomag"],
    });
    expect(msg).toContain("Kovács Anna");
    expect(msg).toContain("POSTPONED");
    expect(msg).toContain("Ősszel térnek vissza rá.");
    expect(msg).toContain("Keresőoptimalizálási alapcsomag");
  });

  it("truncates pasted notes rather than sending an essay to the model", () => {
    const msg = buildFollowupMessage({ outcome: "WON", notes: "x".repeat(9000) });
    expect(msg.length).toBeLessThan(5000);
  });

  it("leaves out what was not filled in", () => {
    const msg = buildFollowupMessage({ outcome: "WON" });
    expect(msg).not.toContain("Cég:");
    expect(msg).not.toContain("Jegyzetek");
  });
});

describe("the model routing", () => {
  /**
   * Sonnet, and deliberately: rule #3 names outreach drafting as a
   * writing-quality use case, and this is the first message after a
   * conversation — where the wrong register costs the deal.
   */
  it("routes the follow-up draft to Sonnet", () => {
    expect(modelForUseCase("meeting_followup")).toBe("claude-sonnet-4-6");
  });
});

describe("kitFrom", () => {
  it("reads a kit back", () => {
    const kit = kitFrom({
      builtAt: "2026-08-25T10:00:00.000Z",
      draftMessageId: "m1",
      attachments: [{ label: "Riport", path: "a.pdf" }],
      quoteLines: [{ category: "seo", description: "x", suggestedNet: 1 }],
      taskId: "t1",
    });
    expect(kit!.draftMessageId).toBe("m1");
    expect(kit!.attachments).toHaveLength(1);
  });

  it("refuses anything that is not a kit rather than half-reading it", () => {
    for (const raw of [null, undefined, {}, 42, "kit", []]) {
      expect(kitFrom(raw)).toBeNull();
    }
  });
});
