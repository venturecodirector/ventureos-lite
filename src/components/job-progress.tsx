"use client";

import { useEffect, useState } from "react";

/**
 * Feedback for work that runs in the worker rather than in the request.
 *
 * Audits, PDF renders and briefs are queued jobs that routinely take 10-40
 * seconds. The UI previously showed nothing but a disabled button, so a slow
 * run was indistinguishable from a hung one and people reloaded mid-job.
 *
 * The bar is indeterminate on purpose. The worker reports a stage, not a
 * percentage, and inventing a number that creeps to 90% and stalls is worse
 * than being honest: the stage label plus a live elapsed counter tells you it
 * is alive and roughly where it is.
 */
export interface JobStage {
  key: string;
  label: string;
}

export function JobProgress({
  stages,
  current,
  startedAt,
  note,
  slowAfterMs = 25_000,
  slowNote,
}: {
  stages: JobStage[];
  /** Key of the stage in progress, or null when not running. */
  current: string | null;
  startedAt: number | null;
  note?: string;
  /** How long before we reassure the user it has not died. */
  slowAfterMs?: number;
  slowNote?: string;
}) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!startedAt) return;
    setElapsed(Math.round((Date.now() - startedAt) / 1000));
    const iv = setInterval(
      () => setElapsed(Math.round((Date.now() - startedAt) / 1000)),
      500,
    );
    return () => clearInterval(iv);
  }, [startedAt]);

  if (!current || !startedAt) return null;

  const index = Math.max(0, stages.findIndex((s) => s.key === current));
  const slow = Date.now() - startedAt > slowAfterMs;

  return (
    <div
      className="mb-4 rounded-card border border-line bg-panel p-[18px]"
      role="status"
      aria-live="polite"
      data-testid="job-progress"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span
          aria-hidden
          className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-[rgba(239,241,248,0.18)] border-t-accent"
        />
        <b className="text-[13px]">{stages[index]?.label ?? "Working"}</b>
        <span className="text-[12px] text-muted">
          step {index + 1} of {stages.length} · {elapsed}s
        </span>
      </div>

      {/* Indeterminate track — motion means alive, not "x% complete". */}
      <div className="mt-3 h-[6px] w-full overflow-hidden rounded-full bg-panel-2">
        <div className="h-full w-1/3 animate-[jobslide_1.4s_ease-in-out_infinite] rounded-full bg-[linear-gradient(135deg,#310B59,#7427C6)]" />
      </div>

      <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1">
        {stages.map((s, i) => (
          <span
            key={s.key}
            className={`text-[11.5px] ${
              i < index ? "text-[#3DDC97]" : i === index ? "text-ink" : "text-muted"
            }`}
          >
            {i < index ? "✓ " : i === index ? "• " : "  "}
            {s.label}
          </span>
        ))}
      </div>

      {note && <p className="mt-2 text-[11.5px] text-muted">{note}</p>}
      {slow && (
        <p className="mt-1.5 text-[11.5px] text-warn">
          {slowNote ??
            "Still going — this runs in the background, so you can leave the page and come back."}
        </p>
      )}
    </div>
  );
}
