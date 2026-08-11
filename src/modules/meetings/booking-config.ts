import type { SlotConfig } from "./slots";

/**
 * Booking-page configuration (spec §4.21) — slot length, buffers, working
 * hours, notice/horizon, timezone, and meeting types. Stored on
 * BookingPage.config / meeting_types_json; these defaults seed the first host
 * and fill any missing fields. Pure module: shared by seed, server, and client.
 */
export interface MeetingType {
  id: string;
  label: string;
  durationMin: number;
}

export const DEFAULT_MEETING_TYPES: MeetingType[] = [
  { id: "intro", label: "30 min intro · Google Meet", durationMin: 30 },
  { id: "deep", label: "60 min working session", durationMin: 60 },
];

export const DEFAULT_SLOT_CONFIG: SlotConfig = {
  timezone: "Europe/Budapest",
  workingDays: [1, 2, 3, 4, 5],
  workStartMin: 9 * 60,
  workEndMin: 17 * 60,
  slotStepMin: 30,
  bufferBeforeMin: 15,
  bufferAfterMin: 15,
  minNoticeMin: 120,
};

/** How many days ahead the day strip may reach. */
export const DEFAULT_HORIZON_DAYS = 14;

export function parseSlotConfig(raw: unknown): SlotConfig {
  const c =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  const days = Array.isArray(c.workingDays)
    ? (c.workingDays.filter((n) => typeof n === "number") as number[])
    : DEFAULT_SLOT_CONFIG.workingDays;
  return {
    timezone: typeof c.timezone === "string" ? c.timezone : DEFAULT_SLOT_CONFIG.timezone,
    workingDays: days.length ? days : DEFAULT_SLOT_CONFIG.workingDays,
    workStartMin: num(c.workStartMin, DEFAULT_SLOT_CONFIG.workStartMin),
    workEndMin: num(c.workEndMin, DEFAULT_SLOT_CONFIG.workEndMin),
    slotStepMin: num(c.slotStepMin, DEFAULT_SLOT_CONFIG.slotStepMin),
    bufferBeforeMin: num(c.bufferBeforeMin, DEFAULT_SLOT_CONFIG.bufferBeforeMin),
    bufferAfterMin: num(c.bufferAfterMin, DEFAULT_SLOT_CONFIG.bufferAfterMin),
    minNoticeMin: num(c.minNoticeMin, DEFAULT_SLOT_CONFIG.minNoticeMin),
  };
}

export function parseMeetingTypes(raw: unknown): MeetingType[] {
  if (!Array.isArray(raw)) return DEFAULT_MEETING_TYPES;
  const out = raw
    .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
    .map((t) => ({
      id: String(t.id ?? ""),
      label: String(t.label ?? ""),
      durationMin: typeof t.durationMin === "number" ? t.durationMin : 30,
    }))
    .filter((t) => t.id && t.label);
  return out.length ? out : DEFAULT_MEETING_TYPES;
}

export function horizonDays(raw: unknown): number {
  const c =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  return typeof c.horizonDays === "number" && c.horizonDays > 0 ? c.horizonDays : DEFAULT_HORIZON_DAYS;
}
