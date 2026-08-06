/** MATCH-before-MERGE for existing graph nodes and alias references. */

import { instanceCreateIdParamName, nodeIdLiteral } from "../entity/ids.js";
import { isExistingGraphNode } from "../entity/predicates.js";
import { renderMatchExistingNode } from "./node.js";
import type { GraphNodeLabel, GraphPattern, NodePattern, PathElement } from "../types.js";

function findExistingDefinitionInPath(
  path: PathElement[],
  beforeIndex: number,
  aliasRef: string,
  clauseLabel: GraphNodeLabel | string
): NodePattern | null {
  const want = (aliasRef || "").trim();
  if (!want) return null;
  for (let i = 0; i < beforeIndex; i += 1) {
    const step = path[i];
    if (step.kind !== "node" || !step.node || step.node.alias_mode === "reference") continue;
    const def = step.node;
    const defKey = (def.alias_ref || def.variable || "").trim();
    if (defKey !== want) continue;
    if (isExistingGraphNode(def)) return def;
    if (nodeIdLiteral(def, clauseLabel)) return def;
    // A new create-INSTANCE definition with an engine-minted id is re-matchable in a
    // later pattern via the same run-time parameter.
    if (
      instanceCreateIdParamName(def, {
        clauseLabel,
        operation: "create",
        entityKind: "node",
      })
    ) {
      return def;
    }
  }
  return null;
}

function findExistingDefinitionInClause(
  patterns: GraphPattern[],
  patternIndex: number,
  path: PathElement[],
  beforeIndex: number,
  aliasRef: string,
  clauseLabel: GraphNodeLabel | string
): NodePattern | null {
  let def = findExistingDefinitionInPath(path, beforeIndex, aliasRef, clauseLabel);
  if (def) return def;
  const want = (aliasRef || "").trim();
  if (!want || !patterns) return null;
  for (let pi = 0; pi < patternIndex; pi += 1) {
    const priorPath = (patterns[pi] && patterns[pi].path) || [];
    def = findExistingDefinitionInPath(priorPath, priorPath.length, want, clauseLabel);
    if (def) return def;
  }
  return null;
}

export function collectExistingNodeMatches(
  path: PathElement[] | null | undefined,
  clauseLabel: GraphNodeLabel | string,
  patterns: GraphPattern[] | null | undefined,
  patternIndex: number | null | undefined
): string[] {
  const lines: string[] = [];
  const matchedVars = new Set<string>();
  (path || []).forEach((step, stepIndex) => {
    if (step.kind !== "node" || !step.node) return;
    const variable = (step.node.variable || "").trim();
    if (!variable || matchedVars.has(variable)) return;

    let existingNode: NodePattern | null = null;
    let referenceNode: NodePattern | null = null;
    if (step.node.alias_mode === "reference") {
      referenceNode = step.node;
      const ref = (step.node.alias_ref || step.node.variable || "").trim();
      // A definition in the same path (self-loop / cycle) is rendered inside this
      // same MERGE pattern, which binds the variable itself. Emitting a MATCH here
      // would double-bind it ("variable already bound") — and the node may not
      // even exist yet. Existing-node definitions still get their MATCH from their
      // own defining occurrence, so the reference never needs one of its own.
      const samePathDef = findExistingDefinitionInPath(path!, stepIndex, ref, clauseLabel);
      if (samePathDef) return;
      existingNode =
        patterns != null && patternIndex != null
          ? findExistingDefinitionInClause(patterns, patternIndex, path!, stepIndex, ref, clauseLabel)
          : null;
      if (!existingNode) return;
    } else if (isExistingGraphNode(step.node)) {
      existingNode = step.node;
    } else {
      return;
    }

    const nodeForMatch = referenceNode
      ? {
          ...existingNode,
          variable: (referenceNode.variable || existingNode!.variable || "").trim(),
        }
      : existingNode!;
    const line = renderMatchExistingNode(nodeForMatch, clauseLabel);
    if (line) {
      lines.push(line);
      matchedVars.add(variable);
    }
  });
  return lines;
}
