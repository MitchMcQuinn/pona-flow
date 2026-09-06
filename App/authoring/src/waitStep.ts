/**
 * Wait STEP authoring helpers: mode vocabulary, duration conversion, and shape checks.
 *
 * The entity payload stores duration as seconds (or `$param`). The builder converts
 * a display amount + unit into that field. Keep this in step with Engine wait execution.
 */

import { extractExactParameterRef } from "./parameterRefs.js";
import type { SequencialProperties, WaitDurationUnit, WaitMode } from "./types.js";

export const WAIT_MODES: readonly WaitMode[] = ["duration", "until", "event"];

export const WAIT_DURATION_UNITS: readonly WaitDurationUnit[] = [
  "seconds",
  "minutes",
  "hours"
];

export const WAIT_DURATION_UNIT_LABELS: Record<WaitDurationUnit, string> = {
  seconds: "seconds",
  minutes: "minutes",
  hours: "hours"
};

/** 30 days — a parked run should not sit unbounded by accident. */
export const MAX_WAIT_SECONDS = 30 * 24 * 3600;

const UNIT_SECONDS: Record<WaitDurationUnit, number> = {
  seconds: 1,
  minutes: 60,
  hours: 3600
};

export function isWaitMode(value: unknown): value is WaitMode {
  return typeof value === "string" && (WAIT_MODES as readonly string[]).includes(value);
}

export function isWaitDurationUnit(value: unknown): value is WaitDurationUnit {
  return typeof value === "string" && (WAIT_DURATION_UNITS as readonly string[]).includes(value);
}

export function isWaitStep(sp: SequencialProperties | null | undefined): boolean {
  return Boolean(sp && sp.query_id === undefined && sp.step_type === "wait");
}

export function durationAmountToSeconds(
  amount: number,
  unit: WaitDurationUnit
): number {
  return Math.round(amount * UNIT_SECONDS[unit]);
}

/** Pick a compact display unit for a stored second count. */
export function secondsToDurationParts(seconds: number): {
  amount: number;
  unit: WaitDurationUnit;
} {
  if (seconds > 0 && seconds % 3600 === 0) {
    return { amount: seconds / 3600, unit: "hours" };
  }
  if (seconds > 0 && seconds % 60 === 0) {
    return { amount: seconds / 60, unit: "minutes" };
  }
  return { amount: seconds, unit: "seconds" };
}

export function waitDurationParamName(
  value: number | string | undefined
): string | null {
  if (typeof value !== "string") return null;
  return extractExactParameterRef(value);
}

/** True when a wait-until string is `$name` or looks like an ISO-8601 datetime. */
export function isWaitUntilValue(raw: string): boolean {
  const text = raw.trim();
  if (!text) return false;
  if (extractExactParameterRef(text)) return true;
  const parsed = Date.parse(text);
  return !Number.isNaN(parsed);
}

/**
 * Shape problems the builder can see on its own. Empty array = complete enough to save.
 */
export function waitStepWarnings(sp: SequencialProperties | null | undefined): string[] {
  if (!isWaitStep(sp) || !sp) return [];
  const warnings: string[] = [];
  const mode: WaitMode = isWaitMode(sp.wait_mode) ? sp.wait_mode : "duration";

  if (mode === "duration") {
    const param = waitDurationParamName(sp.wait_duration_seconds);
    if (param) return warnings;
    const seconds =
      typeof sp.wait_duration_seconds === "number"
        ? sp.wait_duration_seconds
        : Number(String(sp.wait_duration_seconds ?? "").trim());
    if (!Number.isFinite(seconds) || seconds < 0) {
      warnings.push("Wait duration must be a number of seconds (or $parameter).");
    } else if (seconds > MAX_WAIT_SECONDS) {
      warnings.push("Wait duration cannot exceed 30 days.");
    }
  } else if (mode === "until") {
    const until = String(sp.wait_until ?? "").trim();
    if (!until) {
      warnings.push("Wait-until needs a datetime (or $parameter).");
    } else if (!isWaitUntilValue(until)) {
      warnings.push("Wait-until must be an ISO-8601 datetime (or $parameter).");
    }
  } else if (mode === "event") {
    if (!(sp.wait_event_id ?? "").trim()) {
      warnings.push("Wait-for-event needs an Event from this space.");
    }
  }
  return warnings;
}
