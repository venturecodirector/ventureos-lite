/**
 * Slot generation for the public booking page (spec §4.21). Pure, DST-aware
 * timezone math using the runtime's IANA database via Intl — no external deps.
 * All instants are UTC epoch ms; wall-clock config is in the host timezone
 * (Europe/Budapest first).
 */
export interface SlotConfig {
  timezone: string;
  workingDays: number[]; // ISO weekday: 1=Mon … 7=Sun
  workStartMin: number; // minutes from local midnight
  workEndMin: number;
  slotStepMin: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  minNoticeMin: number;
}

export interface BusyInterval {
  startMs: number;
  endMs: number;
}

export interface SlotOption {
  startMs: number;
  label: string; // "10:00" in host tz
}

/** Offset (local − UTC) in ms for `tz` at the given instant. */
export function tzOffsetMs(tz: string, date: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(date)) p[part.type] = part.value;
  const asUTC = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second),
  );
  return asUTC - date.getTime();
}

/** Convert a wall-clock time in `tz` to a UTC epoch ms (DST-correct). */
export function localWallToUtcMs(
  year: number,
  month0: number,
  day: number,
  hour: number,
  minute: number,
  tz: string,
): number {
  const guess = Date.UTC(year, month0, day, hour, minute);
  // Two passes converge across a DST transition (offset depends on the instant).
  let off = tzOffsetMs(tz, new Date(guess));
  off = tzOffsetMs(tz, new Date(guess - off));
  return guess - off;
}

/** Format a UTC instant as "H:MM" in the host tz (no leading hour zero). */
export function formatSlotLabel(utcMs: number, tz: string): string {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(new Date(utcMs))) p[part.type] = part.value;
  return `${Number(p.hour)}:${p.minute}`;
}

/** ISO weekday (1=Mon … 7=Sun) of a UTC instant in the host tz. */
export function localIsoWeekday(utcMs: number, tz: string): number {
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(
    new Date(utcMs),
  );
  const map: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return map[wd];
}

function parseDayISO(dayISO: string): { y: number; m0: number; d: number } {
  const [y, m, d] = dayISO.split("-").map(Number);
  return { y, m0: m - 1, d };
}

export function generateDaySlots(params: {
  dayISO: string; // local calendar date "YYYY-MM-DD"
  durationMin: number;
  config: SlotConfig;
  busy: BusyInterval[];
  nowMs: number;
}): SlotOption[] {
  const { dayISO, durationMin, config: c, busy, nowMs } = params;
  const { y, m0, d } = parseDayISO(dayISO);

  // Working-day gate — use noon to avoid any midnight/DST edge.
  const noon = localWallToUtcMs(y, m0, d, 12, 0, c.timezone);
  if (!c.workingDays.includes(localIsoWeekday(noon, c.timezone))) return [];

  const out: SlotOption[] = [];
  const noticeCutoff = nowMs + c.minNoticeMin * 60_000;
  for (let m = c.workStartMin; m + durationMin <= c.workEndMin; m += c.slotStepMin) {
    const startMs = localWallToUtcMs(y, m0, d, Math.floor(m / 60), m % 60, c.timezone);
    const endMs = startMs + durationMin * 60_000;
    if (startMs < noticeCutoff) continue;
    const blockStart = startMs - c.bufferBeforeMin * 60_000;
    const blockEnd = endMs + c.bufferAfterMin * 60_000;
    const clash = busy.some((b) => blockStart < b.endMs && b.startMs < blockEnd);
    if (clash) continue;
    out.push({ startMs, label: formatSlotLabel(startMs, c.timezone) });
  }
  return out;
}

export interface DayStripEntry {
  dateISO: string; // "2026-08-13"
  dayNum: number; // 13
  weekday: string; // "Thu"
}

/** The next `count` working days (host tz) starting at/after `fromMs`. */
export function generateDayStrip(params: {
  fromMs: number;
  count: number;
  config: SlotConfig;
}): DayStripEntry[] {
  const { fromMs, count, config: c } = params;
  const out: DayStripEntry[] = [];
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: c.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  });
  // Walk day by day from `fromMs`, at local noon, collecting working days.
  let cursor = fromMs;
  for (let i = 0; i < 60 && out.length < count; i++) {
    const p: Record<string, string> = {};
    for (const part of dtf.formatToParts(new Date(cursor))) p[part.type] = part.value;
    const noon = localWallToUtcMs(
      Number(p.year),
      Number(p.month) - 1,
      Number(p.day),
      12,
      0,
      c.timezone,
    );
    if (c.workingDays.includes(localIsoWeekday(noon, c.timezone))) {
      out.push({
        dateISO: `${p.year}-${p.month}-${p.day}`,
        dayNum: Number(p.day),
        weekday: p.weekday,
      });
    }
    cursor += 24 * 60 * 60_000;
  }
  return out;
}
