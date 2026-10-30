import type { Combinator, EventRuleGroup, EventType } from "../state/types";
import type { EventPreviewDocument } from "../components/events/EventBuilder";
import type { WalkthroughPin } from "./types";

const DAY_NUMBERS: Record<string, number> = {
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
  sun: 7,
  sunday: 7
};

/** Turn an agent event document into the fields the create-an-event form actually shows. */
export function eventPreviewFrom(
  document: Record<string, unknown>,
  context?: { note?: string; pins?: WalkthroughPin[] }
): EventPreviewDocument {
  const nested = objectOf(document.event) ?? document;
  const pack = objectOf(nested.event_package) ?? objectOf(nested.eventPackage) ?? {};
  const source: Record<string, unknown> = { ...nested, ...pack };
  const type = eventType(nested.type ?? nested.event_type ?? pack.type);
  const groups = scheduleGroups(source, type, context);
  const timezone = text(source.timezone) || text(pack.timezone) || text(nested.timezone);
  const combinator = combinatorOf(source.combinator ?? pack.combinator);
  const preview: EventPreviewDocument = {
    name: text(nested.name) || text(source.name),
    type,
    sequences: idList(nested.sequences ?? source.sequences),
    recovery_sequences: idList(nested.recovery_sequences ?? source.recovery_sequences),
    event_package: {
      timezone: timezone || undefined,
      combinator,
      groups
    }
  };
  if (typeof nested.enabled === "boolean") preview.enabled = nested.enabled;
  else if (nested.enabled === 0 || nested.enabled === 1) preview.enabled = Boolean(nested.enabled);
  const external = objectOf(nested.external_package) ?? objectOf(source.external_package);
  if (external) preview.external_package = external as EventPreviewDocument["external_package"];
  const simulation = objectOf(nested.simulation_package) ?? objectOf(source.simulation_package);
  if (simulation) preview.simulation_package = simulation;
  return preview;
}

function scheduleGroups(
  source: Record<string, unknown>,
  type: EventType | undefined,
  context?: { note?: string; pins?: WalkthroughPin[] }
): EventRuleGroup[] {
  const rawGroups = arrayOf(source.groups).length ? arrayOf(source.groups) : arrayOf(source.schedules);
  const groups = rawGroups.map((entry) => groupFrom(objectOf(entry) ?? {})).filter(groupHasRule);
  const hinted = type === "external" || type === "simulated" ? null : scheduleHint(source, context);
  if (!groups.length) return hinted ? [blankGroup(hinted)] : [];
  if (!hinted) return groups;
  const first = groups[0];
  return [
    {
      ...first,
      is_time: first.is_time || hinted.is_time || null,
      is_weekday: first.is_weekday?.length ? first.is_weekday : hinted.is_weekday ?? null
    },
    ...groups.slice(1)
  ];
}

function scheduleHint(
  source: Record<string, unknown>,
  context?: { note?: string; pins?: WalkthroughPin[] }
): Partial<EventRuleGroup> | null {
  const fromFields = groupFrom(source);
  const cron = cronGroup(text(source.cron) || text(source.schedule));
  const explicit: Partial<EventRuleGroup> = {
    is_time: fromFields.is_time || cron?.is_time || null,
    is_weekday: fromFields.is_weekday?.length ? fromFields.is_weekday : cron?.is_weekday ?? null
  };
  if (explicit.is_time || explicit.is_weekday?.length) return explicit;
  const prose = [context?.note, ...(context?.pins ?? []).map((pin) => pin.note)].filter(Boolean).join("\n");
  return proseSchedule(prose);
}

function blankGroup(hint: Partial<EventRuleGroup>): EventRuleGroup {
  return {
    combinator: "AND",
    is_weekday: hint.is_weekday ?? null,
    is_date_ordinal: null,
    is_date: null,
    is_time: hint.is_time ?? null,
    is_month: null,
    is_year: null
  };
}

function groupFrom(raw: Record<string, unknown>): EventRuleGroup {
  const cron = cronGroup(text(raw.cron));
  const time = clock(raw.is_time) || clock(raw.time) || clock(raw.at) || cron?.is_time || null;
  const days = weekdays(raw.is_weekday) || weekdays(raw.weekdays) || weekdays(raw.dow) || cron?.is_weekday || null;
  return {
    combinator: combinatorOf(raw.combinator) ?? "AND",
    is_weekday: days,
    is_date_ordinal: numberList(raw.is_date_ordinal),
    is_date: text(raw.is_date) || null,
    is_time: time,
    is_month: numberList(raw.is_month),
    is_year: numberList(raw.is_year)
  };
}

function groupHasRule(group: EventRuleGroup): boolean {
  return Boolean(
    group.is_time ||
      group.is_date ||
      group.is_weekday?.length ||
      group.is_month?.length ||
      group.is_year?.length ||
      group.is_date_ordinal?.length
  );
}

function proseSchedule(value: string): Partial<EventRuleGroup> | null {
  if (!value.trim()) return null;
  const time = clock(value);
  const days = proseDays(value);
  const meridiem = /\b(?:a\.?m\.?|p\.?m\.?)\b/i.test(value);
  const shownTime = time && (meridiem || days) ? time : null;
  if (!shownTime && !days) return null;
  return { is_time: shownTime, is_weekday: days };
}

function proseDays(value: string): number[] | null {
  const text = value.toLowerCase();
  if (/\bweekdays?\b/.test(text)) return [1, 2, 3, 4, 5];
  const span = text.match(
    /\b(mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\s+(?:through|to)\s+(mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b/
  );
  if (!span) return null;
  const start = DAY_NUMBERS[span[1]];
  const end = DAY_NUMBERS[span[2]];
  if (!start || !end || start > end) return null;
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

function cronGroup(cron: string): Partial<EventRuleGroup> | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5) return null;
  const [minute, hour, , , dow] = parts;
  if (!/^\d{1,2}$/.test(minute) || !/^\d{1,2}$/.test(hour)) return null;
  const hh = Number(hour);
  const mm = Number(minute);
  if (hh > 23 || mm > 59) return null;
  return {
    is_time: `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`,
    is_weekday: weekdays(dow)
  };
}

/** A clock the time input can show: 24-hour HH:MM. */
export function clock(value: unknown): string | null {
  if (typeof value === "number" && value >= 0 && value <= 23) {
    return `${String(value).padStart(2, "0")}:00`;
  }
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase().replace(/z$/, "");
  const ampm = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/);
  if (ampm) {
    let hour = Number(ampm[1]);
    const minute = ampm[2] ?? "00";
    const meridiem = ampm[3].replace(/\./g, "");
    if (hour > 12 || Number(minute) > 59) return null;
    if (meridiem === "pm" && hour < 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
    return `${String(hour).padStart(2, "0")}:${minute}`;
  }
  const hm = text.match(/\b(\d{1,2}):(\d{2})\b/);
  if (!hm) return null;
  const hour = Number(hm[1]);
  const minute = Number(hm[2]);
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${hm[2]}`;
}

function weekdays(value: unknown): number[] | null {
  if (Array.isArray(value)) {
    const days = value.flatMap((entry) => weekdays(entry) ?? []);
    return uniqueDays(days);
  }
  if (typeof value === "number") return dayNumber(String(value));
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase();
  if (!text || text === "*") return null;
  const range = text.match(/^([a-z0-9]+)\s*-\s*([a-z0-9]+)$/);
  if (range) {
    const start = singleDay(range[1]);
    const end = singleDay(range[2]);
    if (start && end && start <= end) {
      return Array.from({ length: end - start + 1 }, (_, index) => start + index);
    }
  }
  return uniqueDays(text.split(/[,\s]+/).flatMap((part) => (singleDay(part) ? [singleDay(part) as number] : [])));
}

function dayNumber(token: string): number[] | null {
  const day = singleDay(token);
  return day ? [day] : null;
}

function singleDay(token: string): number | null {
  const named = DAY_NUMBERS[token];
  if (named) return named;
  if (!/^\d+$/.test(token)) return null;
  const value = Number(token);
  if (value === 0 || value === 7) return 7;
  if (value >= 1 && value <= 6) return value;
  return null;
}

function uniqueDays(days: number[]): number[] | null {
  const unique = [...new Set(days.filter((day) => day >= 1 && day <= 7))].sort((a, b) => a - b);
  return unique.length ? unique : null;
}

function numberList(value: unknown): number[] | null {
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const numbers = list.map((entry) => Number(entry)).filter((entry) => Number.isFinite(entry));
  return numbers.length ? numbers : null;
}

function idList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (typeof entry === "string" || typeof entry === "number") return String(entry);
      const record = objectOf(entry);
      return record ? text(record.id) || text(record.name) : "";
    })
    .filter(Boolean);
}

function eventType(value: unknown): EventType | undefined {
  const kind = text(value);
  if (kind === "time" || kind === "external" || kind === "simulated") return kind;
  return undefined;
}

function combinatorOf(value: unknown): Combinator | undefined {
  return value === "AND" || value === "OR" ? value : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function objectOf(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return null;
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
