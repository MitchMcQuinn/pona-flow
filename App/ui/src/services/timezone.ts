/**
 * Timezone helpers for displaying/editing event times in a user's local zone.
 *
 * Event times are stored as a UTC time-of-day ("HH:MM"). The UI lets a user view and
 * edit them in their preferred IANA timezone; we convert on display and convert back to
 * UTC on save. Because a bare time-of-day has no date, conversions use the zone's
 * *current* UTC offset (a pragmatic approximation that ignores historical DST shifts).
 */

const MINUTES_PER_DAY = 24 * 60;

/** The browser's detected IANA timezone, falling back to UTC. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** All IANA timezone names the runtime knows about, with a curated fallback. */
export function supportedTimeZones(): string[] {
  const intl = Intl as typeof Intl & {
    supportedValuesOf?: (key: string) => string[];
  };
  try {
    if (typeof intl.supportedValuesOf === "function") {
      const zones = intl.supportedValuesOf("timeZone");
      if (Array.isArray(zones) && zones.length > 0) return zones;
    }
  } catch {
    // fall through to the curated list
  }
  return [
    "UTC",
    "America/Los_Angeles",
    "America/Denver",
    "America/Chicago",
    "America/New_York",
    "America/Sao_Paulo",
    "Europe/London",
    "Europe/Paris",
    "Europe/Berlin",
    "Europe/Moscow",
    "Asia/Dubai",
    "Asia/Kolkata",
    "Asia/Shanghai",
    "Asia/Tokyo",
    "Australia/Sydney"
  ];
}

/** Minutes to ADD to UTC to get local time in `timeZone` (e.g. -300 for US Eastern in winter). */
export function utcOffsetMinutes(timeZone: string, at: Date = new Date()): number {
  try {
    const local = new Date(at.toLocaleString("en-US", { timeZone }));
    const utc = new Date(at.toLocaleString("en-US", { timeZone: "UTC" }));
    return Math.round((local.getTime() - utc.getTime()) / 60000);
  } catch {
    return 0;
  }
}

function wrapMinutes(total: number): number {
  return ((total % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

function parseHHMM(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function formatHHMM(totalMinutes: number): string {
  const m = wrapMinutes(totalMinutes);
  const hh = String(Math.floor(m / 60)).padStart(2, "0");
  const mm = String(m % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** Convert a UTC "HH:MM" time-of-day to the equivalent time in `timeZone`. */
export function utcTimeToZone(hhmm: string, timeZone: string): string {
  const minutes = parseHHMM(hhmm);
  if (minutes === null) return hhmm;
  return formatHHMM(minutes + utcOffsetMinutes(timeZone));
}

/** Convert a `timeZone`-local "HH:MM" time-of-day back to UTC. */
export function zoneTimeToUtc(hhmm: string, timeZone: string): string {
  const minutes = parseHHMM(hhmm);
  if (minutes === null) return hhmm;
  return formatHHMM(minutes - utcOffsetMinutes(timeZone));
}

/** A short offset label like "UTC+02:00" for the given zone. */
export function offsetLabel(timeZone: string): string {
  const offset = utcOffsetMinutes(timeZone);
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `UTC${sign}${hh}:${mm}`;
}

/** A select-friendly label like "America/New_York (UTC-05:00)". */
export function timeZoneLabel(timeZone: string): string {
  return `${timeZone} (${offsetLabel(timeZone)})`;
}
