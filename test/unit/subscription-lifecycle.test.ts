import { describe, it, expect } from "vitest";
import {
  SUBSCRIPTION_SOURCES,
  CHURN_REASONS,
  isSubscriptionSource,
  isChurnReason,
  monthKey,
  monthsBetween,
  eventForAmountChange,
  eventForStatusChange,
  type SubscriptionState,
} from "../../src/modules/revenue/subscriptions";

/**
 * The subscription lifecycle (playbook-v3 P11/1a).
 *
 * Every change to the recurring book has to become an APPEND-ONLY event with a
 * signed MRR delta, because the movement chart sums those deltas rather than
 * reconstructing history from the current state. If the deltas are wrong the
 * chart is wrong and there is no way to tell.
 */

function sub(over: Partial<SubscriptionState> = {}): SubscriptionState {
  return { monthlyNet: 100_000, status: "ACTIVE", ...over };
}

describe("the taxonomy", () => {
  it("offers the sources the playbook names", () => {
    expect([...SUBSCRIPTION_SOURCES]).toEqual(
      expect.arrayContaining(["ventstudio", "hosting", "retainer", "other"]),
    );
  });

  it("recognises its own values and rejects anything else", () => {
    expect(isSubscriptionSource("hosting")).toBe(true);
    expect(isSubscriptionSource("carrier-pigeon")).toBe(false);
    expect(isChurnReason(CHURN_REASONS[0])).toBe(true);
    expect(isChurnReason("because")).toBe(false);
  });
});

describe("month arithmetic", () => {
  it("keys a date by its calendar month in UTC", () => {
    expect(monthKey(new Date("2026-08-16T23:30:00Z"))).toBe("2026-08");
    expect(monthKey(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01");
  });

  it("counts whole calendar months between two dates", () => {
    expect(monthsBetween(new Date("2026-01-10"), new Date("2026-01-28"))).toBe(0);
    expect(monthsBetween(new Date("2026-01-10"), new Date("2026-02-01"))).toBe(1);
    expect(monthsBetween(new Date("2026-01-31"), new Date("2027-01-01"))).toBe(12);
  });

  it("counts backwards as negative rather than clamping", () => {
    expect(monthsBetween(new Date("2026-06-01"), new Date("2026-04-01"))).toBe(-2);
  });
});

describe("an amount change becomes a signed delta", () => {
  it("a price rise is expansion", () => {
    const event = eventForAmountChange(sub({ monthlyNet: 100_000 }), 150_000);
    expect(event).toEqual({ kind: "expansion", deltaNet: 50_000, monthlyNetAfter: 150_000 });
  });

  it("a price cut is contraction, and the delta is negative", () => {
    const event = eventForAmountChange(sub({ monthlyNet: 100_000 }), 60_000);
    expect(event).toEqual({ kind: "contraction", deltaNet: -40_000, monthlyNetAfter: 60_000 });
  });

  it("no change produces no event at all", () => {
    // An event with a zero delta is noise in an append-only log: it says
    // something happened when nothing did.
    expect(eventForAmountChange(sub({ monthlyNet: 100_000 }), 100_000)).toBeNull();
  });

  it("changing the price of a churned subscription produces nothing", () => {
    // It contributes no MRR, so re-pricing it cannot move the chart.
    expect(eventForAmountChange(sub({ status: "CHURNED" }), 200_000)).toBeNull();
  });
});

describe("a status change becomes a signed delta", () => {
  it("churning removes the whole current amount", () => {
    const event = eventForStatusChange(sub({ monthlyNet: 90_000 }), "CHURNED");
    expect(event).toEqual({ kind: "churn", deltaNet: -90_000, monthlyNetAfter: 0 });
  });

  it("pausing also removes it — a paused subscription bills nothing", () => {
    const event = eventForStatusChange(sub({ monthlyNet: 90_000 }), "PAUSED");
    expect(event).toEqual({ kind: "pause", deltaNet: -90_000, monthlyNetAfter: 0 });
  });

  it("resuming from paused puts it back", () => {
    const event = eventForStatusChange(sub({ monthlyNet: 90_000, status: "PAUSED" }), "ACTIVE");
    expect(event).toEqual({ kind: "resume", deltaNet: 90_000, monthlyNetAfter: 90_000 });
  });

  it("reactivating from churned is its own kind, so the chart can tell them apart", () => {
    const event = eventForStatusChange(sub({ monthlyNet: 90_000, status: "CHURNED" }), "ACTIVE");
    expect(event).toEqual({ kind: "reactivation", deltaNet: 90_000, monthlyNetAfter: 90_000 });
  });

  it("a no-op status change produces nothing", () => {
    expect(eventForStatusChange(sub({ status: "ACTIVE" }), "ACTIVE")).toBeNull();
  });

  it("churning something already paused removes nothing twice", () => {
    // The MRR already left when it paused. Subtracting it again would show a
    // second churn on the chart for money that was already gone.
    const event = eventForStatusChange(sub({ monthlyNet: 90_000, status: "PAUSED" }), "CHURNED");
    expect(event).toEqual({ kind: "churn", deltaNet: 0, monthlyNetAfter: 0 });
  });
});

describe("the deltas reconcile", () => {
  it("a full lifecycle sums to the amount still on the book", () => {
    // This is the property the movement chart depends on: sum(deltas) === MRR.
    const events = [
      { deltaNet: 100_000 }, // new
      eventForAmountChange(sub({ monthlyNet: 100_000 }), 150_000)!, // +50k
      eventForStatusChange(sub({ monthlyNet: 150_000 }), "PAUSED")!, // -150k
      eventForStatusChange(sub({ monthlyNet: 150_000, status: "PAUSED" }), "ACTIVE")!, // +150k
      eventForStatusChange(sub({ monthlyNet: 150_000 }), "CHURNED")!, // -150k
    ];
    expect(events.reduce((n, e) => n + e.deltaNet, 0)).toBe(0);
  });
});
