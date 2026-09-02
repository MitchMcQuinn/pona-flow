/**
 * Sequence loop config: defaults, normalization, and authoring-time validation.
 *
 * Mirrors `Engine/server/execution_loop.py` — the engine is the enforcing side, and
 * these rules exist so the builder can block a save (and explain why) instead of
 * letting compose fail later. Keep the two in step.
 *
 * Deliberately *not* checked here: whether the STEP graph actually contains exactly
 * one cycle, and whether a referenced name is a real RETURN alias. Neither is
 * knowable from the QueryObject — a downstream sequence's read query is a single
 * node plus `-[*]->`, so the cycle lives in POINTS_TO edges the builder never sees.
 * Compose reports both, and the builder surfaces them from the compose response.
 */

import type { LoopComparisonOperator, LoopConfig, LoopType } from "./types.js";

export const LOOP_TYPES: readonly LoopType[] = ["dag", "for", "for_while", "for_each"];

/** Mirrors execution_loop.COMPARISON_OPERATORS. */
export const LOOP_COMPARISON_OPERATORS: readonly LoopComparisonOperator[] = [
  "=",
  "<>",
  "<",
  "<=",
  ">",
  ">=",
  "CONTAINS",
  "STARTS WITH",
  "ENDS WITH"
];

/** Mirrors execution_loop.DEFAULT_MAX_ITERATIONS. */
export const DEFAULT_MAX_ITERATIONS = 1000;

export const DEFAULT_LOOP_CONFIG: LoopConfig = { type: "dag" };

/** Human-readable name for each type, for the builder's selector. */
export const LOOP_TYPE_LABELS: Record<LoopType, string> = {
  dag: "DAG (no looping)",
  for: "for (fixed count)",
  for_while: "for/while (condition)",
  for_each: "for/each (result rows)"
};

export function isLoopType(value: unknown): value is LoopType {
  return typeof value === "string" && (LOOP_TYPES as readonly string[]).includes(value);
}

/** True when the config leaves the executor on its historical single-pass walk. */
export function isDagLoop(loop: LoopConfig | undefined): boolean {
  return !loop || loop.type === "dag";
}

/**
 * Mirrors execution_loop._as_positive_int, including its treatment of an absent value.
 *
 * Blank is null rather than 0, which is what separates "the iterations box is empty"
 * (incomplete — warn) from an explicit zero (legal — skip the body).
 */
function positiveInt(value: unknown): number | null {
  if (typeof value === "boolean") return null;
  if (typeof value !== "number") {
    const text = String(value ?? "").trim();
    if (!text) return null;
    value = Number(text);
  }
  const parsed = value as number;
  if (!Number.isInteger(parsed) || parsed < 0) return null;
  return parsed;
}

/**
 * Drop the fields that don't belong to the selected type before saving.
 *
 * The builder keeps every type's inputs mounted so switching back and forth doesn't
 * lose what was typed; this is what stops that scratch state reaching the catalog.
 * Returns undefined for a plain DAG so the payload omits the column entirely.
 */
export function normalizeLoopConfig(loop: LoopConfig | undefined): LoopConfig | undefined {
  if (isDagLoop(loop)) return undefined;
  const type = loop!.type;
  const out: LoopConfig = { type };
  const maxIterations = positiveInt(loop!.max_iterations);
  if (maxIterations) out.max_iterations = maxIterations;
  if (type === "for") {
    out.count = positiveInt(loop!.count) ?? 0;
  } else if (type === "for_while") {
    const condition = loop!.condition;
    out.condition = {
      parameter: (condition?.parameter || "").trim(),
      operator: condition?.operator ?? "=",
      value: condition?.value ?? ""
    };
  } else if (type === "for_each") {
    out.source = (loop!.source || "").trim();
  }
  return out;
}

/**
 * Shape problems the builder can see on its own, as readable messages.
 * An empty array means the config is complete enough to save.
 */
export function loopConfigWarnings(loop: LoopConfig | undefined): string[] {
  if (isDagLoop(loop)) return [];
  const warnings: string[] = [];
  const type = loop!.type;

  // A zero cap is dropped by normalizeLoopConfig, so it means "unset" here too —
  // otherwise a cleared input would make every count look like an overrun.
  // A zero cap is dropped by normalizeLoopConfig, so it means "unset" here too —
  // otherwise a cleared input would make every count look like an overrun.
  const maxIterations = positiveInt(loop!.max_iterations) || DEFAULT_MAX_ITERATIONS;
  const capGiven = String(loop!.max_iterations ?? "").trim() !== "";
  if (capGiven && positiveInt(loop!.max_iterations) === null) {
    warnings.push("Maximum iterations must be a whole number.");
  }

  if (type === "for") {
    const count = positiveInt(loop!.count);
    if (count === null) {
      warnings.push("A for loop needs a whole number of iterations.");
    } else if (count > maxIterations) {
      warnings.push(
        `A for loop of ${count} iterations exceeds this sequence's maximum of ` +
          `${maxIterations}. Lower the count or raise the maximum.`
      );
    }
  } else if (type === "for_while") {
    const condition = loop!.condition;
    if (!(condition?.parameter || "").trim()) {
      warnings.push("A for/while loop needs a parameter to test.");
    }
    if (
      !condition?.operator ||
      !(LOOP_COMPARISON_OPERATORS as readonly string[]).includes(condition.operator)
    ) {
      warnings.push("A for/while loop needs a comparison operator.");
    }
  } else if (type === "for_each") {
    if (!(loop!.source || "").trim()) {
      warnings.push("A for/each loop needs a RETURN alias to iterate.");
    }
  }
  return warnings;
}
