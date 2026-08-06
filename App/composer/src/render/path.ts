/** Concatenate nodes and relationships into a Cypher path string. */

import { renderNode } from "./node.js";
import { renderRelationship } from "./relationship.js";
import type { GraphNodeLabel, PathElement } from "../types.js";

export type HopSplitMode = "optional" | "absent";

/**
 * First relationship where the path splits off its tail, or null when the whole
 * path renders as a single pattern. "optional" tails render as OPTIONAL MATCH
 * segments; "absent" tails render as a NOT EXISTS { MATCH ... } anti-join.
 *
 * Split hops apply only to read SCHEMA/INSTANCE clauses (READ STEP has a single
 * entry point and never splits). Everything after the first flagged relationship
 * is normalized into that tail, so hand-written packages cannot interleave
 * required hops after a flagged one. A split also requires an anchor: a preceding
 * node with a variable to re-bind in the tail's clause. When a relationship
 * carries both flags, absent wins (the flags are mutually exclusive by contract).
 */
export function hopSplit(
  path: PathElement[] | null | undefined,
  clauseLabel: GraphNodeLabel | string,
  operation: string
): { index: number; mode: HopSplitMode } | null {
  if (operation !== "read" || clauseLabel === "STEP") return null;
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
