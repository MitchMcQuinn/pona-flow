/** Concatenate nodes and relationships into a Cypher path string. */

import { renderNode } from "./node.js";
import { renderRelationship } from "./relationship.js";
import type { GraphNodeLabel, PathElement, QueryObject } from "../types.js";

export type HopSplitMode = "optional" | "absent";

/**
 * Whether a clause's hops may carry a mode (optional / absent) that splits the path.
 *
 * INSTANCE splits on every match operation: an optional hop widens the matched set
 * and an absent hop narrows it, which is meaningful for a read, an update's SET, and
 * a delete's targets alike. SCHEMA splits on read only — update SCHEMA edits the
 * per-space entities payload (SQLite, no Cypher) and delete SCHEMA runs the cascade
 * endpoint by attributive_label rather than the composed pattern. STEP never splits:
 * a sequence needs a single concrete entry point.
 */
export function supportsHopSplit(
  clauseLabel: GraphNodeLabel | string,
  operation: string
): boolean {
  if (clauseLabel === "INSTANCE") {
    return operation === "read" || operation === "update" || operation === "delete";
  }
  if (clauseLabel === "SCHEMA") return operation === "read";
  return false;
}

/**
 * First relationship where the path splits off its tail, or null when the whole
 * path renders as a single pattern. "optional" tails render as OPTIONAL MATCH
 * segments; "absent" tails render as a NOT EXISTS { MATCH ... } anti-join.
 *
 * Split hops apply only where ``supportsHopSplit`` allows them. Everything after the
 * first flagged relationship is normalized into that tail, so hand-written packages
 * cannot interleave required hops after a flagged one. A split also requires an
 * anchor: a preceding node with a variable to re-bind in the tail's clause. When a
 * relationship carries both flags, absent wins (the flags are mutually exclusive by
 * contract).
 */
export function hopSplit(
  path: PathElement[] | null | undefined,
  clauseLabel: GraphNodeLabel | string,
  operation: string
): { index: number; mode: HopSplitMode } | null {
  if (!supportsHopSplit(clauseLabel, operation)) return null;
  if (!path || !path.length) return null;
  let hasAnchor = false;
  for (let i = 0; i < path.length; i += 1) {
    const el = path[i];
    if (el.kind === "node") {
      if (((el.node && el.node.variable) || "").trim()) hasAnchor = true;
      continue;
    }
    if (el.kind !== "relationship" || !hasAnchor) continue;
    if (el.relationship?.absent === true) return { index: i, mode: "absent" };
    if (el.relationship?.optional === true) return { index: i, mode: "optional" };
  }
  return null;
}

/**
 * Index of the first relationship where the path splits into OPTIONAL MATCH
 * segments, or -1 when the path does not split into an optional tail.
 */
export function optionalHopSplitIndex(
  path: PathElement[] | null | undefined,
  clauseLabel: GraphNodeLabel | string,
  operation: string
): number {
  const split = hopSplit(path, clauseLabel, operation);
  return split && split.mode === "optional" ? split.index : -1;
}

/**
 * Index of the first relationship where the path splits into a NOT EXISTS
 * anti-join tail, or -1 when the path does not split into an absent tail.
 */
export function absentHopSplitIndex(
  path: PathElement[] | null | undefined,
  clauseLabel: GraphNodeLabel | string,
  operation: string
): number {
  const split = hopSplit(path, clauseLabel, operation);
  return split && split.mode === "absent" ? split.index : -1;
}

export interface HopTailVariables {
  /**
   * Variables bound by an OPTIONAL MATCH segment. They exist in the outer query but
   * are null on rows where the hop did not match, so referencing one in SET or DELETE
   * is a no-op for those rows rather than an error.
   */
  optional: Set<string>;
  /**
   * Variables that live inside a NOT EXISTS { MATCH ... } subquery. They are never
   * bound in the outer query, so any RETURN / ORDER BY / SET / DELETE reference to
   * one is invalid Cypher.
   */
  absent: Set<string>;
}

/** Variable declared by a path element, or "" when it is unnamed. */
function pathElementVariable(el: PathElement): string {
  if (el.kind === "node") return ((el.node && el.node.variable) || "").trim();
  return ((el.relationship && el.relationship.variable) || "").trim();
}

/**
 * Variables that a query's split hop tails bind, grouped by tail kind. This is the
 * single source of truth for "which variables are nullable / unbound", shared by the
 * composer, the authoring validation, and the builder's binding pickers.
 */
export function hopTailVariables(query: QueryObject | null | undefined): HopTailVariables {
  const optional = new Set<string>();
  const absent = new Set<string>();
  const operation = (query && query.operation) || "read";
  (query?.match || []).forEach((clause) => {
    (clause.patterns || []).forEach((pattern) => {
      const path = pattern.path || [];
      const split = hopSplit(path, clause.label || "", operation);
      if (!split) return;
      const target = split.mode === "absent" ? absent : optional;
      for (let i = split.index; i < path.length; i += 1) {
        const variable = pathElementVariable(path[i]);
        if (variable) target.add(variable);
      }
    });
  });
  return { optional, absent };
}

/** Variable of the last named node before endExclusive, or "" when none exists. */
export function lastNodeVariable(path: PathElement[], endExclusive: number): string {
  for (let i = endExclusive - 1; i >= 0; i -= 1) {
    const el = path[i];
    if (el.kind === "node") {
      const variable = ((el.node && el.node.variable) || "").trim();
      if (variable) return variable;
    }
  }
  return "";
}

export function renderPath(
  path: PathElement[] | null | undefined,
  clauseLabel: GraphNodeLabel | string,
  operation: string
): string {
  if (!path || !path.length) return "";
  return path
    .map((el) => {
      if (el.kind === "node") {
        const nodeLabel =
          (el.node && el.node.labels && el.node.labels[0]) || clauseLabel || "";
        const variable = (el.node && el.node.variable) || "";
        if (!variable) return "";
        return renderNode(el.node, {
          variable,
          label: nodeLabel,
          clauseLabel,
          operation,
        });
      }
      if (el.kind === "relationship") {
        const variable = (el.relationship && el.relationship.variable) || "";
        if (!variable) return "";
        return renderRelationship(el.relationship, {
          variable,
          clauseLabel,
          operation,
        });
      }
      return "";
    })
    .join("");
}
