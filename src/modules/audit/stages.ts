/**
 * The steps an audit actually goes through, named once so the worker and the
 * progress panel cannot disagree.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 *
 * The runner used to hardcode three steps and derive the current one from
 * `AuditResult.status`. `status` only ever holds queued / running / done /
 * error, so the third step ("Scoring and screenshots") was unreachable by
 * construction: every audit crawled to step 2 of 3, sat there, and then went
 * quiet when the poller gave up. It looked exactly like a crash, and for the
 * runs that also hit the navigation timeout below it was one.
 *
 * The worker now writes `AuditResult.stage` as it goes, and both runners read
 * it. A stage is cosmetic — nothing branches on it — so a worker that is a
 * deploy behind simply leaves it null and the panel falls back to the old
 * two-step behaviour rather than breaking.
 */

/** Every stage the pipeline can report, in the order it reports them. */
export const AUDIT_STAGE_KEYS = [
  "queued",
  "loading",
  "crawling",
  "pagespeed",
  "screenshots",
  "pitch",
  "finishing",
] as const;

export type AuditStage = (typeof AUDIT_STAGE_KEYS)[number];

export interface AuditStageLabels {
  queued: string;
  loading: string;
  crawling: string;
  pagespeed: string;
  screenshots: string;
  pitch: string;
  finishing: string;
}

export const AUDIT_STAGE_LABELS_EN: AuditStageLabels = {
  queued: "Queued",
  loading: "Loading the site and running the checks",
  crawling: "Crawling the site",
  pagespeed: "PageSpeed and field data",
  screenshots: "Capturing screenshots",
  pitch: "Writing the pitch angle",
  finishing: "Scoring and finishing up",
};

export const AUDIT_STAGE_LABELS_HU: AuditStageLabels = {
  queued: "Sorban áll",
  loading: "Az oldal betöltése és az ellenőrzések",
  crawling: "Az oldal bejárása",
  pagespeed: "PageSpeed és valós felhasználói adatok",
  screenshots: "Képernyőképek készítése",
  pitch: "Ajánlási szempont írása",
  finishing: "Pontozás és lezárás",
};

/**
 * The steps THIS run will take.
 *
 * The crawl and the pitch are toggles, and a step list containing two steps
 * that will never happen is the same lie the old three-step list told — the
 * bar would stop at 5 of 7 on every ordinary audit.
 */
export function auditStagesFor(
  opts: { crawl?: boolean; withPitch?: boolean },
  labels: AuditStageLabels = AUDIT_STAGE_LABELS_EN,
): Array<{ key: AuditStage; label: string }> {
  const keys: AuditStage[] = ["queued", "loading"];
  if (opts.crawl) keys.push("crawling");
  keys.push("pagespeed", "screenshots");
  if (opts.withPitch) keys.push("pitch");
  keys.push("finishing");
  return keys.map((key) => ({ key, label: labels[key] }));
}

/**
 * Which step to highlight for a record we are polling.
 *
 * `stage` is authoritative when the worker has written one. Otherwise fall
 * back to the lifecycle: a queued row is queued, anything else that is still
 * running is at least loading. Returns null when there is nothing in flight.
 */
export function currentAuditStage(row: {
  status: string;
  stage?: string | null;
}): AuditStage | null {
  if (row.status === "done" || row.status === "error") return null;
  const stage = row.stage;
  if (stage && (AUDIT_STAGE_KEYS as readonly string[]).includes(stage)) {
    return stage as AuditStage;
  }
  return row.status === "queued" ? "queued" : "loading";
}
