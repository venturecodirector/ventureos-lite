/**
 * Time-of-day greeting.
 *
 * The shell said "good morning" at every hour of the day, which is the kind of
 * detail that quietly tells a user the software is not paying attention.
 *
 * The bands are the owner's, and they cover the full 24 hours with no gap:
 *
 *   05:00–09:59  morning
 *   10:00–17:59  day
 *   18:00–04:59  evening   (wraps past midnight)
 *
 * Pure and hour-based so every boundary is testable without mocking a clock.
 * The hour must come from the DEVICE, not the server: the server runs UTC in a
 * container and would wish a Budapest user good morning at 07:00 local while
 * believing it to be 05:00.
 */
export type GreetingBand = "morning" | "day" | "evening";

export const GREETING_BANDS = {
  morning: { from: 5, until: 10 },
  day: { from: 10, until: 18 },
  evening: { from: 18, until: 5 },
} as const;

export function greetingBandFor(hour: number): GreetingBand {
  // Anything unexpected (NaN, a fractional hour, an out-of-range number) lands
  // on the band that covers the most hours rather than throwing in a header.
  if (!Number.isFinite(hour)) return "day";
  const h = Math.floor(hour) % 24;
  const normalized = h < 0 ? h + 24 : h;

  if (normalized >= 5 && normalized < 10) return "morning";
  if (normalized >= 10 && normalized < 18) return "day";
  return "evening";
}

/** Lowercase, matching the display type used across the shell. */
export const GREETING_LABEL: Record<GreetingBand, string> = {
  morning: "good morning",
  day: "good day",
  evening: "good evening",
};

export function greetingFor(hour: number): string {
  return GREETING_LABEL[greetingBandFor(hour)];
}

/**
 * Milliseconds until the greeting would next change.
 *
 * A dashboard left open across 10:00 should not keep saying good morning until
 * someone reloads it. Used to schedule exactly one re-render at the boundary
 * rather than polling.
 */
export function msUntilNextBand(now: Date): number {
  const nextBoundaryHour = (() => {
    const h = now.getHours();
    if (h < 5) return 5;
    if (h < 10) return 10;
    if (h < 18) return 18;
    return 24 + 5; // tomorrow at 05:00
  })();

  const next = new Date(now);
  next.setHours(nextBoundaryHour, 0, 0, 0);
  return Math.max(1000, next.getTime() - now.getTime());
}
