import { describe, it, expect } from "vitest";
import {
  AUDIT_STAGE_LABELS_EN,
  AUDIT_STAGE_LABELS_HU,
  auditStagesFor,
  currentAuditStage,
} from "../../src/modules/audit/stages";

/**
 * The regression these cover: the runner advertised three steps and derived
 * the current one from `AuditResult.status`, which only ever holds
 * queued / running / done / error. The third step ("Scoring and screenshots")
 * was therefore unreachable — every audit visibly stalled at step 2 of 3 and
 * then went quiet when the poller's timeout elapsed. It read as a crash.
 *
 * The invariant that keeps it fixed: every step a run advertises must be a
 * step the worker can actually report.
 */
describe("the progress panel cannot advertise a step the worker never reaches", () => {
  it("lists only the steps this particular run will take", () => {
    const plain = auditStagesFor({}).map((s) => s.key);
    expect(plain).toEqual(["queued", "loading", "pagespeed", "screenshots", "finishing"]);

    // The crawl and the pitch are toggles. Listing them on a run that has both
    // switched off is the same lie the old three-step list told: the bar would
    // stop two steps short on every ordinary audit.
    expect(auditStagesFor({ crawl: true }).map((s) => s.key)).toContain("crawling");
    expect(auditStagesFor({}).map((s) => s.key)).not.toContain("crawling");
    expect(auditStagesFor({ withPitch: true }).map((s) => s.key)).toContain("pitch");
    expect(auditStagesFor({}).map((s) => s.key)).not.toContain("pitch");
  });

  it("keeps queued first and finishing last, whatever the toggles", () => {
    for (const opts of [{}, { crawl: true }, { withPitch: true }, { crawl: true, withPitch: true }]) {
      const keys = auditStagesFor(opts).map((s) => s.key);
      expect(keys[0]).toBe("queued");
      expect(keys[keys.length - 1]).toBe("finishing");
    }
  });

  it("every advertised step is one the record can actually report", () => {
    const advertised = auditStagesFor({ crawl: true, withPitch: true }).map((s) => s.key);
    for (const key of advertised) {
      // A record carrying this stage must highlight this stage — the exact
      // property "scoring" failed, because nothing ever wrote it.
      expect(currentAuditStage({ status: "running", stage: key })).toBe(key);
    }
  });

  it("labels exist in both languages for every step", () => {
    for (const { key } of auditStagesFor({ crawl: true, withPitch: true })) {
      expect(AUDIT_STAGE_LABELS_EN[key]).toBeTruthy();
      expect(AUDIT_STAGE_LABELS_HU[key]).toBeTruthy();
    }
  });
});

describe("which step a polled record is on", () => {
  it("trusts the worker's stage over the lifecycle status", () => {
    expect(currentAuditStage({ status: "running", stage: "screenshots" })).toBe("screenshots");
  });

  it("falls back to the lifecycle when the worker has written no stage", () => {
    // A worker one deploy behind writes no stage at all. The panel degrades to
    // the old behaviour rather than rendering nothing.
    expect(currentAuditStage({ status: "queued", stage: null })).toBe("queued");
    expect(currentAuditStage({ status: "running", stage: null })).toBe("loading");
  });

  it("ignores a stage value it does not recognise", () => {
    // Rather than highlighting nothing (findIndex -> -1 -> the first step),
    // an unknown stage falls back to the lifecycle.
    expect(currentAuditStage({ status: "running", stage: "scoring" })).toBe("loading");
  });

  it("highlights nothing once the run has settled", () => {
    expect(currentAuditStage({ status: "done", stage: null })).toBeNull();
    expect(currentAuditStage({ status: "error", stage: "loading" })).toBeNull();
  });
});
