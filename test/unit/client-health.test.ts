import { describe, it, expect } from "vitest";
import {
  DEFAULT_HEALTH_RULES,
  healthRulesFrom,
  scoreClientHealth,
  suggestedTaskFor,
  type HealthInputs,
} from "../../src/modules/revenue/health";

/**
 * Customer health (playbook-v3 P11/1c). Rules only — no AI anywhere near it,
 * and every red has to be explainable in a sentence a person can act on.
 */

function inputs(over: Partial<HealthInputs> = {}): HealthInputs {
  return {
    companyName: "Danubia Kft",
    daysPaymentLate: 0,
    monthsSinceTouchpoint: 0,
    supportFlag: false,
    subscriptionAgeMonths: 24,
    ...over,
  };
}

const R = DEFAULT_HEALTH_RULES;

describe("a healthy client", () => {
  it("is green with no reasons", () => {
    const health = scoreClientHealth(inputs(), R);
    expect(health.level).toBe("green");
    expect(health.reasons).toEqual([]);
  });
});

describe("payment lateness", () => {
  it("goes amber past the amber threshold", () => {
    const health = scoreClientHealth(inputs({ daysPaymentLate: R.paymentLateAmberDays }), R);
    expect(health.level).toBe("amber");
    // The reason has to name the invoice, or nobody knows what to chase.
    expect(health.reasons.join(" ")).toMatch(/invoice.*due/i);
  });

  it("goes red past the red threshold", () => {
    expect(scoreClientHealth(inputs({ daysPaymentLate: R.paymentLateRedDays }), R).level).toBe("red");
  });

  it("stays green just under the amber threshold", () => {
    expect(
      scoreClientHealth(inputs({ daysPaymentLate: R.paymentLateAmberDays - 1 }), R).level,
    ).toBe("green");
  });

  it("names the number of days, so the reason is actionable", () => {
    const health = scoreClientHealth(inputs({ daysPaymentLate: 41 }), R);
    expect(health.reasons.join(" ")).toContain("41");
  });
});

describe("going quiet", () => {
  it("goes amber then red as the silence lengthens", () => {
    expect(scoreClientHealth(inputs({ monthsSinceTouchpoint: R.quietAmberMonths }), R).level).toBe(
      "amber",
    );
    expect(scoreClientHealth(inputs({ monthsSinceTouchpoint: R.quietRedMonths }), R).level).toBe(
      "red",
    );
  });

  it("is worse for a NEW client than for an established one", () => {
    // A client three months in who has gone quiet is in trouble; the same
    // silence from a two-year client is a quiet quarter. Subscription age is
    // the input that separates them.
    const quiet = { monthsSinceTouchpoint: R.quietAmberMonths };
    const established = scoreClientHealth(inputs({ ...quiet, subscriptionAgeMonths: 24 }), R);
    const fresh = scoreClientHealth(
      inputs({ ...quiet, subscriptionAgeMonths: R.youngClientMonths - 1 }),
      R,
    );
    expect(established.level).toBe("amber");
    expect(fresh.level).toBe("red");
    expect(fresh.reasons.join(" ")).toMatch(/new client/i);
  });

  it("does not escalate a young client who is NOT quiet", () => {
    expect(scoreClientHealth(inputs({ subscriptionAgeMonths: 1 }), R).level).toBe("green");
  });
});

describe("the support flag", () => {
  it("is amber on its own", () => {
    const health = scoreClientHealth(inputs({ supportFlag: true }), R);
    expect(health.level).toBe("amber");
    expect(health.reasons.join(" ")).toMatch(/support/i);
  });

  it("does not downgrade a red", () => {
    const health = scoreClientHealth(
      inputs({ supportFlag: true, daysPaymentLate: R.paymentLateRedDays }),
      R,
    );
    expect(health.level).toBe("red");
  });
});

describe("several problems at once", () => {
  it("takes the worst level and keeps every reason", () => {
    const health = scoreClientHealth(
      inputs({
        daysPaymentLate: R.paymentLateAmberDays,
        monthsSinceTouchpoint: R.quietRedMonths,
        supportFlag: true,
      }),
      R,
    );
    expect(health.level).toBe("red");
    expect(health.reasons).toHaveLength(3);
  });
});

describe("the rules are configurable", () => {
  it("falls back to the defaults for anything unset", () => {
    expect(healthRulesFrom(null)).toEqual(DEFAULT_HEALTH_RULES);
    expect(healthRulesFrom({ quietRedMonths: 6 })).toEqual({
      ...DEFAULT_HEALTH_RULES,
      quietRedMonths: 6,
    });
  });

  it("ignores a value that is not a positive number", () => {
    // A threshold of zero would make every client red for ever.
    expect(healthRulesFrom({ quietRedMonths: 0 }).quietRedMonths).toBe(
      DEFAULT_HEALTH_RULES.quietRedMonths,
    );
    expect(healthRulesFrom({ quietRedMonths: "soon" }).quietRedMonths).toBe(
      DEFAULT_HEALTH_RULES.quietRedMonths,
    );
  });

  it("honours a stricter threshold", () => {
    const strict = healthRulesFrom({ quietAmberMonths: 1 });
    expect(scoreClientHealth(inputs({ monthsSinceTouchpoint: 1 }), strict).level).toBe("amber");
  });

  it("keeps red at or above amber, whatever was configured", () => {
    // A red threshold below the amber one is incoherent — everything past amber
    // would be red and the middle band would vanish.
    const rules = healthRulesFrom({ quietAmberMonths: 5, quietRedMonths: 2 });
    expect(rules.quietRedMonths).toBeGreaterThanOrEqual(rules.quietAmberMonths);
  });
});

describe("the suggested task", () => {
  it("names the client and the worst reason", () => {
    const health = scoreClientHealth(inputs({ daysPaymentLate: 45 }), R);
    const task = suggestedTaskFor(inputs({ daysPaymentLate: 45 }), health);
    expect(task).not.toBeNull();
    expect(task!.title).toContain("Danubia Kft");
    expect(task!.note).toMatch(/45/);
  });

  it("is not offered for a green client", () => {
    expect(suggestedTaskFor(inputs(), scoreClientHealth(inputs(), R))).toBeNull();
  });

  it("is not offered for an amber one — the list is for reds", () => {
    const health = scoreClientHealth(inputs({ supportFlag: true }), R);
    expect(suggestedTaskFor(inputs({ supportFlag: true }), health)).toBeNull();
  });
});
