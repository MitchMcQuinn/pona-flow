/**
 * HTTP / Local LLM call-policy helpers: timeout, retry budget, backoff.
 *
 * Persisted on the STEP entity payload. Runtime lives in Engine execution_call.py —
 * keep the caps in step with that module.
 */

import { extractExactParameterRef } from "./parameterRefs.js";
import { MAX_WAIT_SECONDS } from "./waitStep.js";
import type { SequencialProperties } from "./types.js";

export const MIN_TIMEOUT_SECONDS = 1;
export const MAX_TIMEOUT_SECONDS = 300;
export const HTTP_DEFAULT_TIMEOUT_SECONDS = 30;
export const LLM_DEFAULT_TIMEOUT_SECONDS = 300;
export const DEFAULT_MAX_ATTEMPTS = 1;
export const MAX_ATTEMPTS = 20;

export function isHttpOrLlmStep(sp: SequencialProperties | null | undefined): boolean {
  if (!sp || sp.query_id !== undefined) return false;
  const kind = sp.step_type;
  if (kind === "wait" || kind === "join" || kind === "code") return false;
  return true;
}

function timeoutParamName(value: number | string | undefined): string | null {
  if (typeof value !== "string") return null;
  return extractExactParameterRef(value);
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && !value.trim().startsWith("$")) {
    const n = Number(value.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Shape problems the builder can see on its own. Empty array = complete enough to save.
 */
export function callStepWarnings(sp: SequencialProperties | null | undefined): string[] {
  if (!isHttpOrLlmStep(sp) || !sp) return [];
  const warnings: string[] = [];

  if (timeoutParamName(sp.timeout_seconds)) {
    // Runtime resolves $parameter; nothing to check here.
  } else if (sp.timeout_seconds !== undefined && sp.timeout_seconds !== "") {
    const seconds = finiteNumber(sp.timeout_seconds);
    if (seconds === null) {
      warnings.push("Call timeout must be a number of seconds (or $parameter).");
    } else if (seconds < MIN_TIMEOUT_SECONDS || seconds > MAX_TIMEOUT_SECONDS) {
      warnings.push(
        `Call timeout must be between ${MIN_TIMEOUT_SECONDS} and ${MAX_TIMEOUT_SECONDS} seconds.`
      );
    }
  }

  if (sp.max_attempts !== undefined && sp.max_attempts !== null) {
    const attempts = finiteNumber(sp.max_attempts);
    if (attempts === null || !Number.isInteger(attempts)) {
      warnings.push("max_attempts must be an integer.");
    } else if (attempts < 1) {
      warnings.push("max_attempts must be at least 1.");
    } else if (attempts > MAX_ATTEMPTS) {
      warnings.push(`max_attempts cannot exceed ${MAX_ATTEMPTS}.`);
    }
  }

  if (timeoutParamName(sp.backoff_seconds as number | string | undefined)) {
    // Runtime resolves $parameter.
  } else if (sp.backoff_seconds !== undefined && sp.backoff_seconds !== "") {
    const seconds = finiteNumber(sp.backoff_seconds);
    if (seconds === null) {
      warnings.push("Retry backoff must be a number of seconds (or $parameter).");
    } else if (seconds < 0) {
      warnings.push("Retry backoff cannot be negative.");
    } else if (seconds > MAX_WAIT_SECONDS) {
      warnings.push("Retry backoff cannot exceed 30 days.");
    }
  }

  return warnings;
}
