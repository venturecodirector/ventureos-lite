/**
 * Callback quick-chip smart defaults (spec §4.17). Times are wall-clock; we
 * compute in UTC here for determinism — the Budapest-timezone offset is applied
 * at display/config time. "Pick…" opens a custom picker (handled in the UI).
 */
export type CallbackChip = "tomorrow_9" | "thu_14" | "next_mon_9";

export const CALLBACK_CHIPS: Array<{ key: CallbackChip; label: string }> = [
  { key: "tomorrow_9", label: "Tomorrow 9:00" },
  { key: "thu_14", label: "Thu 14:00" },
  { key: "next_mon_9", label: "Next Mon 9:00" },
];

function nextWeekdayAt(now: Date, dow: number, hour: number): Date {
  for (let add = 0; add <= 7; add += 1) {
    const d = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + add, hour),
    );
    if (d.getUTCDay() === dow && d.getTime() > now.getTime()) return d;
  }
  // Unreachable (a weekday recurs within 7 days), but satisfy the type.
  return new Date(now.getTime() + 7 * 86_400_000);
}

export function callbackChipDate(chip: CallbackChip, now: Date = new Date()): Date {
  switch (chip) {
    case "tomorrow_9":
      return new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 9),
      );
    case "thu_14":
      return nextWeekdayAt(now, 4, 14);
    case "next_mon_9":
      return nextWeekdayAt(now, 1, 9);
  }
}

export function isCallbackDue(callbackAt: Date, now: Date = new Date()): boolean {
  return callbackAt.getTime() <= now.getTime();
}
