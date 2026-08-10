import { normalizeAttributiveLabel } from "@pona-flow/authoring";
import type { GraphNodeLabel, NodePattern, QueryObject, RelationshipPattern } from "./types";

export function attributiveLabelChanged(before: string | undefined, after: string): boolean {
  return normalizeAttributiveLabel(before ?? "") !== normalizeAttributiveLabel(after);
}

/** True when this STEP create package references at least one existing graph node (meta-workflow). */
export function stepCreateReferencesExistingNode(query: QueryObject): boolean {
  if (query.operation !== "create") return false;
  for (const clause of query.match ?? []) {
    if (clause.label !== "STEP") continue;
    for (const pattern of clause.patterns ?? []) {
      for (const step of pattern.path ?? []) {
        if (step.kind === "node" && step.node?.node_source === "existing") return true;
      }
    }
  }
  return false;
}

export function nodeClearedForAttributiveLabel(
  graphLabel: GraphNodeLabel,
  attributiveLabel: string,
  current: NodePattern
): Partial<NodePattern> {
  const patch: Partial<NodePattern> = {
    attributive_label: normalizeAttributiveLabel(attributiveLabel),
    node_source: undefined,
    id_binding: undefined,
    properties: [],
    sequencial_properties: undefined,
    alias_mode: "define",
    alias_ref: undefined,
    variable: current.alias_locked ? current.variable : ""
  };
  if (graphLabel === "STEP") {
    patch.sequencial_properties = { body: {} };
  }
  return patch;
}

export function relationshipClearedForAttributiveLabel(
  attributiveLabel: string,
  _graphLabel: GraphNodeLabel,
  current: RelationshipPattern
): Partial<RelationshipPattern> {
  const patch: Partial<RelationshipPattern> = {
    attributive_label: normalizeAttributiveLabel(attributiveLabel),
    node_source: undefined,
    id_binding: undefined,
    properties: [],
    condition_type: "null",
    condition: undefined,
    variable: current.alias_locked ? current.variable : ""
  };
  return patch;
}
